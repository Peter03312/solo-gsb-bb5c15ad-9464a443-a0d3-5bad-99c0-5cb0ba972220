'use strict';

/**
 * 多语批次交付：把原文与选定语言冻结为同一时间轴的一个批次。
 *
 * 提交内容：
 *   sub_version    项目当前字幕集版本（乐观锁）
 *   rules_version  项目当前规则版本（乐观锁）
 *   languages      非空且不重复的目标语言列表
 *   versions       各语言逐行译文版本：{ <lang>: { <subtitle_id>: <translation_version> } }
 *
 * 服务端在一次事务内核对：
 *   1) 源字幕整版结构（词覆盖/不重叠/不跨切点/不缩短词时段）与现行规则；
 *   2) 每种语言当前每行译文为 current 且满足现行字数/字速规则；
 *   3) 提交的 sub_version / rules_version / 逐行译文版本仍有效（未漂移）。
 * 任一语言缺译、待复核、无效或版本漂移 → 按语言与字幕行返回原因，
 * 整批不生成快照、不消耗任何导出序列的版本号。
 * 全部通过 → 在原文导出序列（exports）与每种语言导出序列（translation_exports）
 * 中各生成一个不可变 WebVTT 版本，并以批次清单（delivery_batches +
 * delivery_batch_files）关联文件、字幕集版本与规则版本；各文件沿用同一源时间轴，
 * 后续编辑不改变旧批次。
 */

const {
  normalizeLang, checkTranslationText, activeTranslationsByLang, mapRow,
} = require('./translation');

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

const MAX_LANGUAGES = 50;

/**
 * 批次交付请求形状校验（与项目当前状态无关的部分）。
 * 合法：{ sub_version, rules_version, languages: [...], versions: { lang: { sid: ver } } }
 * 通过时返回 parsed：{ sub_version, rules_version, languages: [lang...],
 *   versions: Map<lang, Map<subtitle_id, version>> }。
 */
function parseDeliveryBody(body) {
  const errors = [];
  const b = body || {};

  if (!isInt(b.sub_version) || b.sub_version < 0) {
    errors.push('sub_version（当前字幕集版本）必须是 ≥0 的整数');
  }
  if (!isInt(b.rules_version) || b.rules_version < 1) {
    errors.push('rules_version（当前规则版本）必须是 ≥1 的整数');
  }

  // 目标语言列表：非空数组、逐个合法、不重复
  let languages = null;
  if (!Array.isArray(b.languages) || b.languages.length === 0) {
    errors.push('languages（目标语言列表）必须是非空数组，如 ["en","ja-JP"]');
  } else if (b.languages.length > MAX_LANGUAGES) {
    errors.push(`目标语言数量 ${b.languages.length} 超过上限 ${MAX_LANGUAGES}`);
  } else {
    languages = [];
    const seen = new Set();
    b.languages.forEach((raw, i) => {
      const lang = typeof raw === 'string' ? normalizeLang(raw) : null;
      if (!lang) {
        errors.push(
          `languages[${i}] ${JSON.stringify(raw)} 非法：语言代号须非空、≤32 字、字母开头（字母/数字/-/_），如 en、ja-JP、pt_BR`
        );
        return;
      }
      if (seen.has(lang)) {
        errors.push(`目标语言 ${lang} 在列表中重复`);
        return;
      }
      seen.add(lang);
      languages.push(lang);
    });
  }

  // 各语言逐行译文版本：versions[lang][subtitle_id] = version（≥1 整数）。
  // 每个声明的语言都必须给出版本表；不允许出现未声明的语言。
  let versions = null;
  const v = b.versions;
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    errors.push('versions（各语言逐行译文版本）必须是对象：{ 语言代号: { 字幕ID: 译文版本 } }');
  } else if (languages && languages.length > 0) {
    versions = new Map();
    const langSet = new Set(languages);
    for (const key of Object.keys(v)) {
      if (!langSet.has(key)) {
        errors.push(`versions 包含未在 languages 中声明的语言 ${JSON.stringify(key)}`);
      }
    }
    for (const lang of languages) {
      const per = v[lang];
      if (per === null || typeof per !== 'object' || Array.isArray(per)) {
        errors.push(`versions.${lang} 必须是对象：{ 字幕ID: 译文版本 }（该语言每行都要给出译文版本）`);
        continue;
      }
      const map = new Map();
      let bad = false;
      for (const [sidRaw, ver] of Object.entries(per)) {
        const sid = Number(sidRaw);
        if (!isInt(sid) || sid < 1 || String(sid) !== sidRaw.trim()) {
          errors.push(`versions.${lang} 的键 ${JSON.stringify(sidRaw)} 非法：须为当前字幕 ID（正整数）`);
          bad = true;
          continue;
        }
        if (!isInt(ver) || ver < 1) {
          errors.push(`versions.${lang}[${JSON.stringify(sidRaw)}] 译文版本必须是 ≥1 的整数`);
          bad = true;
          continue;
        }
        map.set(sid, ver);
      }
      if (!bad) versions.set(lang, map);
    }
  }

  const ok = errors.length === 0 && languages !== null && versions !== null &&
    versions.size === (languages ? languages.length : 0);
  return {
    ok,
    errors,
    parsed: ok
      ? { sub_version: b.sub_version, rules_version: b.rules_version, languages, versions }
      : null,
  };
}

/**
 * 批次交付核对（在事务内调用，读取事务内权威状态；只读，不写任何数据）。
 * 返回 {
 *   ok, sub_version, rules_version,
 *   sub_version_stale, rules_version_stale,   // 项目级版本漂移（→ 409）
 *   conflicts,                                // 源整版结构/现行规则冲突
 *   languages: [{ lang, ok, missing, review, invalid, stale, unknown }],
 *   cues,                // 当前整版（ok 时用于生成原文快照）
 *   translationsByLang,  // Map<lang, Map<subtitle_id, 译文行>>（ok 时用于生成译文快照）
 * }
 */
function evaluateDelivery(db, projectId, parsed) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  const rulesRow = db.prepare('SELECT * FROM rules WHERE project_id = ?').get(projectId);
  const rules = {
    version: rulesRow.version, max_chars: rulesRow.max_chars,
    min_duration_ms: rulesRow.min_duration_ms, max_cps: rulesRow.max_cps,
  };
  const cues = db.prepare(
    `SELECT id, idx, word_start, word_end, text, start_ms, end_ms, locked, version
       FROM subtitles WHERE project_id = ? ORDER BY idx`
  ).all(projectId);
  const words = db.prepare(
    'SELECT idx, text, start_ms, end_ms FROM words WHERE project_id = ? ORDER BY idx'
  ).all(projectId);
  const cuts = db.prepare(
    'SELECT cut_ms FROM shots WHERE project_id = ? ORDER BY idx'
  ).all(projectId).map((r) => r.cut_ms);

  const subVersionStale = parsed.sub_version !== project.sub_version;
  const rulesVersionStale = parsed.rules_version !== rules.version;

  // 1) 源字幕整版结构与现行规则（与原文导出同一套校验）
  const { validateStructure, validateRules } = require('./layout');
  const conflicts = [];
  if (words.length === 0) {
    conflicts.push({ type: 'no_words', message: '尚未导入逐词转写，无法交付批次' });
  }
  if (cues.length === 0) {
    conflicts.push({ type: 'no_cues', message: '没有字幕可交付，请先排版' });
  }
  if (words.length > 0 && cues.length > 0) {
    conflicts.push(...validateStructure(cues, words, cuts));
    conflicts.push(...validateRules(cues, rules));
  }

  // 2)+3) 每种语言逐行核对：译文存在、为 current、满足现行字数/字速、版本与提交一致
  const cueIds = new Set(cues.map((c) => c.id));
  const translationsByLang = new Map();
  const languages = parsed.languages.map((lang) => {
    const byCue = activeTranslationsByLang(db, projectId, lang);
    translationsByLang.set(lang, byCue);
    const submitted = parsed.versions.get(lang) || new Map();
    const report = { lang, missing: [], review: [], invalid: [], stale: [], unknown: [] };

    for (const cue of cues) {
      const base = { subtitle_id: cue.id, idx: cue.idx, text: cue.text };
      const row = byCue.get(cue.id);
      if (!row) {
        report.missing.push(base);
        continue;
      }
      if (row.status === 'review') {
        report.review.push({ ...base, translation: mapRow(row) });
        continue;
      }
      const reasons = checkTranslationText(row.text, cue, rules);
      if (reasons.length > 0) {
        report.invalid.push({ ...base, translation: mapRow(row), reasons });
        continue;
      }
      const submittedVer = submitted.get(cue.id);
      if (submittedVer === undefined) {
        report.stale.push({
          ...base, submitted_version: null, current_version: row.version,
          reason: '未提交该行译文版本',
        });
      } else if (submittedVer !== row.version) {
        report.stale.push({
          ...base, submitted_version: submittedVer, current_version: row.version,
          reason: `提交的译文版本 v${submittedVer} 与当前 v${row.version} 不一致（版本漂移）`,
        });
      }
    }
    // 提交版本表中引用了当前整版不存在的字幕行
    for (const [sid, ver] of submitted) {
      if (!cueIds.has(sid)) {
        report.unknown.push({
          subtitle_id: sid, submitted_version: ver,
          reason: `字幕 ${sid} 不在当前整版中（可能已被重排删除）`,
        });
      }
    }
    report.ok = report.missing.length === 0 && report.review.length === 0 &&
      report.invalid.length === 0 && report.stale.length === 0 && report.unknown.length === 0;
    return report;
  });

  const ok = !subVersionStale && !rulesVersionStale && conflicts.length === 0 &&
    languages.every((l) => l.ok);
  return {
    ok,
    sub_version: project.sub_version,
    rules_version: rules.version,
    rules,
    sub_version_stale: subVersionStale,
    rules_version_stale: rulesVersionStale,
    conflicts,
    languages,
    cues,
    translationsByLang,
  };
}

module.exports = { MAX_LANGUAGES, parseDeliveryBody, evaluateDelivery };
