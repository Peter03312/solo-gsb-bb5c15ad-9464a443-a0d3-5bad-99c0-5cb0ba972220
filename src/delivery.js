'use strict';

/**
 * 片方多语字幕交付：把原文与一组选定语言在同一时间轴上冻结为一个批次。
 *
 * 提交方携带：
 *   - sub_version / rules_version  读取时的字幕集版本与规则版本（任一漂移 → 409，整批不生效）；
 *   - languages                    非空且不重复的目标语言代号列表；
 *   - translations[lang]           各语言逐行译文版本清单
 *                                  [{ subtitle_id, version }]，须与当前字幕行一一对应；
 *   - note?                        可选交付说明。
 *
 * 服务端在一次事务内核对：
 *   1) 提交的 sub_version 仍是当前字幕集版本、rules_version 仍是当前规则版本；
 *   2) 源字幕整版结构（词覆盖/不重叠/不跨切点/不缩短词时段）与现行规则通过；
 *   3) 每种语言的每条字幕都有一份 status=current、version 与提交一致
 *      且满足现行字数/字速规则的译文。
 * 任一语言缺译、待复核、无效或版本漂移，按语言和字幕行返回原因，
 * 整批不生成快照、不消耗版本（事务回滚）。
 *
 * 成功时在现有原文导出序列（exports）与各语言导出序列（translation_exports）中
 * 各生成一个不可变 WebVTT 版本，并以批次清单 delivery_files 关联文件、字幕集版本
 * 与规则版本；各文件时间轴一致，后续编辑不改变旧批次。既有单语言/原文导出与下载
 * 约定保持兼容。
 */

const { validateStructure, validateRules } = require('./layout');
const { normalizeLang, checkTranslationText } = require('./translation');

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

const MAX_LANGS = 100;

/**
 * 交付请求形状校验（与项目当前状态无关的部分）。
 * 返回 { ok, errors, request }；request 为归一化后的
 * { sub_version, rules_version, note, languages, itemsByLang: Map(lang -> [{subtitle_id, version}]) }。
 */
function parseDeliveryBody(body) {
  const errors = [];
  const b = body || {};

  if (!isInt(b.sub_version) || b.sub_version < 0) {
    errors.push('sub_version（读取时字幕集版本）必须是 ≥0 的整数');
  }
  if (!isInt(b.rules_version) || b.rules_version < 1) {
    errors.push('rules_version（读取时规则版本）必须是 ≥1 的整数');
  }
  const note = b.note !== undefined && b.note !== null ? String(b.note) : '';

  // 语言列表：数组、非空、语言代号合法、去重（按归一化后的代号）
  const languages = [];
  const seenLangs = new Set();
  if (!Array.isArray(b.languages)) {
    errors.push('languages 必须是非空数组（目标语言代号，如 ["en","ja-JP"]）');
  } else if (b.languages.length === 0) {
    errors.push('languages 不能为空：一次交付至少包含一种目标语言');
  } else if (b.languages.length > MAX_LANGS) {
    errors.push(`languages 数量 ${b.languages.length} 超过上限 ${MAX_LANGS}`);
  } else {
    b.languages.forEach((raw, i) => {
      const lang = normalizeLang(raw);
      if (!lang) {
        errors.push(`languages[${i}] 语言代号 ${JSON.stringify(raw)} 非法：须非空、≤32 字、字母开头（如 en、ja-JP、pt_BR）`);
        return;
      }
      if (raw !== lang) {
        errors.push(`languages[${i}] 语言代号 ${JSON.stringify(raw)} 含有首尾空白，请提交规范化形式 "${lang}"`);
        return;
      }
      if (seenLangs.has(lang)) {
        errors.push(`languages[${i}] 语言 ${lang} 重复：目标语言列表不得重复`);
        return;
      }
      seenLangs.add(lang);
      languages.push(lang);
    });
  }

  // 逐语言译文版本清单：translations 必须是以语言代号为键的对象，覆盖 languages 中的每种语言
  const itemsByLang = new Map();
  const translations = b.translations;
  if (translations === undefined || translations === null || typeof translations !== 'object' || Array.isArray(translations)) {
    errors.push('translations 必须是对象：以语言代号为键，值为 [{subtitle_id, version}] 逐行译文版本清单');
  } else {
    for (const key of Object.keys(translations)) {
      const lang = normalizeLang(key);
      if (!lang || key !== lang || !seenLangs.has(lang)) {
        errors.push(`translations 含未在 languages 中声明的语言键 ${JSON.stringify(key)}`);
        continue;
      }
      const list = translations[key];
      if (!Array.isArray(list)) {
        errors.push(`translations["${lang}"] 必须是数组 [{subtitle_id, version}]`);
        continue;
      }
      const items = [];
      const seenCues = new Set();
      list.forEach((it, i) => {
        if (!it || typeof it !== 'object' || Array.isArray(it)) {
          errors.push(`translations["${lang}"][${i}] 必须是对象 {subtitle_id, version}`);
          return;
        }
        if (!isInt(it.subtitle_id) || it.subtitle_id < 1) {
          errors.push(`translations["${lang}"][${i}].subtitle_id 必须是 ≥1 的整数`);
          return;
        }
        if (!isInt(it.version) || it.version < 1) {
          errors.push(`translations["${lang}"][${i}].version（译文版本）必须是 ≥1 的整数`);
          return;
        }
        if (seenCues.has(it.subtitle_id)) {
          errors.push(`translations["${lang}"] 中字幕 ${it.subtitle_id} 的译文版本重复出现：逐行清单每行只能出现一次`);
          return;
        }
        seenCues.add(it.subtitle_id);
        items.push({ subtitle_id: it.subtitle_id, version: it.version });
      });
      itemsByLang.set(lang, items);
    }
    for (const lang of languages) {
      if (!itemsByLang.has(lang)) {
        errors.push(`缺少语言 ${lang} 的逐行译文版本清单 translations["${lang}"]`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    request: errors.length === 0
      ? { sub_version: b.sub_version, rules_version: b.rules_version, note, languages, itemsByLang }
      : null,
  };
}

/**
 * 交付前整版核对（在事务内对权威当前状态执行）。
 *
 * project：loadProject 结果（含 sub_version/rules/words/cuts/subtitles）
 * request：parseDeliveryBody 通过后的 request
 * activeByLang：Map(lang -> Map(subtitle_id -> translationRow))，各语言非历史译文
 *
 * 返回：
 *   { sub_version_stale, rules_version_stale, conflicts,
 *     languages: [{ lang, missing:[], review:[], invalid:[], version_stale:[], problem_count }] }
 * 行级原因按语言和字幕行给出；problem_count 为该语言四种问题的总数。
 */
function evaluateDelivery(project, request, activeByLang) {
  const conflicts = [
    ...validateStructure(project.subtitles, project.words, project.cuts),
    ...validateRules(project.subtitles, project.rules),
  ];

  const cueById = new Map(project.subtitles.map((c) => [c.id, c]));

  const languages = request.languages.map((lang) => {
    const items = request.itemsByLang.get(lang) || [];
    const submitted = new Map(items.map((it) => [it.subtitle_id, it.version]));
    const byCue = activeByLang.get(lang) || new Map();

    const missing = [];   // 清单漏行 / 没有非历史译文
    const review = [];    // 译文待复核
    const invalid = [];   // current 但不满足现行字数/字速
    const versionStale = []; // 译文存在但版本与提交不一致（版本漂移）

    const addProblem = (bucket, cue, reasons, extra) => {
      bucket.push({
        subtitle_id: cue.id, idx: cue.idx, text: cue.text,
        reasons, ...(extra || {}),
      });
    };

    // 清单中指向不存在字幕行的条目（正常情况下 sub_version 匹配即不会出现，
    // 但仍在事务内兜底，按缺译处理）
    for (const [sid, version] of submitted) {
      if (!cueById.has(sid)) {
        addProblem(missing, { id: sid, idx: null, text: null },
          [`字幕 ${sid} 在当前字幕集（v${project.sub_version}）中不存在（可能已被重排删除），请刷新后重新提交`],
          { submitted_version: version });
      }
    }

    for (const cue of project.subtitles) {
      const submittedVersion = submitted.get(cue.id);
      const row = byCue.get(cue.id);
      if (submittedVersion === undefined) {
        addProblem(missing, cue, ['逐行译文版本清单缺少该字幕行']);
        continue;
      }
      if (!row) {
        addProblem(missing, cue,
          [`语言 ${lang} 在字幕 ${cue.id} 上没有当前译文（源行可能已重排删除，旧译文留作历史且不按序号挪用）`],
          { submitted_version: submittedVersion });
        continue;
      }
      // 版本漂移优先：先确认提交的译文版本仍有效
      if (row.version !== submittedVersion) {
        const reasons = [`译文版本漂移：提交基于 v${submittedVersion}，当前已是 v${row.version}，请刷新后重新提交`];
        if (row.status === 'review') reasons.push('该译文当前为待复核状态');
        addProblem(versionStale, cue, reasons, {
          submitted_version: submittedVersion,
          current: { version: row.version, status: row.status, text: row.text },
        });
        continue;
      }
      if (row.status === 'review') {
        addProblem(review, cue, ['该译文为待复核状态：保存后源字幕文本/时间/词区间已变化，须确认或重新保存后再交付'], {
          current: { version: row.version, text: row.text },
        });
        continue;
      }
      // current 且版本一致：核对现行字数/字速规则
      const ruleReasons = checkTranslationText(row.text, cue, project.rules);
      if (ruleReasons.length > 0) {
        addProblem(invalid, cue, ruleReasons, {
          current: { version: row.version, text: row.text },
        });
      }
    }

    return {
      lang,
      missing, review, invalid, version_stale: versionStale,
      problem_count: missing.length + review.length + invalid.length + versionStale.length,
    };
  });

  return {
    sub_version_stale: request.sub_version !== project.sub_version,
    rules_version_stale: request.rules_version !== project.rules.version,
    sub_version_current: project.sub_version,
    rules_version_current: project.rules.version,
    conflicts,
    languages,
  };
}

/** 批次清单行（列表视图，不含文件内容） */
function mapFileRow(r) {
  return {
    ord: r.ord,
    kind: r.kind,
    lang: r.lang,
    version: r.version,
    cue_count: r.cue_count,
    download_url: r.kind === 'source'
      ? `/api/projects/${r.project_id}/exports/${r.version}`
      : `/api/projects/${r.project_id}/translations/${encodeURIComponent(r.lang)}/exports/${r.version}`,
  };
}

/** 项目下交付批次清单（不含文件内容），按批次倒序 */
function listBatches(db, projectId) {
  const batches = db.prepare(
    `SELECT * FROM delivery_batches WHERE project_id = ? ORDER BY id DESC`
  ).all(projectId);
  const filesStmt = db.prepare(
    'SELECT * FROM delivery_files WHERE project_id = ? AND batch_id = ? ORDER BY ord'
  );
  return batches.map((b) => {
    const files = filesStmt.all(projectId, b.id).map(mapFileRow);
    return {
      id: b.id,
      project_id: b.project_id,
      note: b.note,
      sub_version: b.sub_version,
      rules_version: b.rules_version,
      cue_count: b.cue_count,
      languages: files.filter((f) => f.kind === 'translation').map((f) => f.lang),
      lang_count: b.lang_count,
      created_at: b.created_at,
      files,
    };
  });
}

/** 单个批次（含清单与文件下载地址；不含快照正文，正文经既有下载接口取得）。不存在返回 null。 */
function loadBatch(db, projectId, batchId) {
  const b = db.prepare(
    'SELECT * FROM delivery_batches WHERE id = ? AND project_id = ?'
  ).get(batchId, projectId);
  if (!b) return null;
  const files = db.prepare(
    'SELECT * FROM delivery_files WHERE project_id = ? AND batch_id = ? ORDER BY ord'
  ).all(projectId, b.id).map(mapFileRow);
  return {
    id: b.id,
    project_id: b.project_id,
    note: b.note,
    sub_version: b.sub_version,
    rules_version: b.rules_version,
    cue_count: b.cue_count,
    languages: files.filter((f) => f.kind === 'translation').map((f) => f.lang),
    lang_count: b.lang_count,
    created_at: b.created_at,
    files,
  };
}

module.exports = {
  MAX_LANGS,
  parseDeliveryBody,
  evaluateDelivery,
  listBatches,
  loadBatch,
};
