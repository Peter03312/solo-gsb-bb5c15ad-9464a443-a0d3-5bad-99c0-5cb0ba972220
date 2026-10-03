'use strict';

/**
 * 多语言译文字幕：请求解析、规则校验、并列查询视图、失效对账与导出前核对。
 *
 * 译文模型：
 *   - 译文沿用源字幕的起止时间与词区间，本身不携带任何时间/切点/原文，也不改词、切点、原文；
 *   - 校对者保存时携带 非空目标语言代号 lang、字幕 ID、读取时行版本 cue_version、
 *     译文版本 version（新建时省略或为 0）；
 *   - 同一语言每条当前字幕最多一份非历史译文（DB 部分唯一索引 + 服务端核对）；
 *   - 源字幕 文本/时间/词区间 变化 → 译文转 review（待复核）；
 *     仅锁定或展示顺序变化不失效；源行删除 → history（留作历史，新行视为缺译，
 *     不按序号自动挪用）；
 *   - 待复核译文可由校对者在当前源行上确认；过期版本或无效译文返回当前值与原因且不改数据。
 */

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

const MAX_LANG_LEN = 32;
const LANG_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** 路径参数中的语言代号：非空、≤32 字、字母开头（en / zh-CN / pt_BR 等），非法返回 null */
function normalizeLang(raw) {
  if (typeof raw !== 'string') return null;
  const lang = raw.trim();
  if (lang === '' || lang.length > MAX_LANG_LEN || !LANG_RE.test(lang)) return null;
  return lang;
}

/**
 * 保存译文请求形状校验（与项目当前状态无关的部分）。
 * 合法项：{ text, cue_version, version }（version 省略/0 表示新建）。
 */
function parseTranslationBody(body) {
  const errors = [];
  const b = body || {};
  if (typeof b.text !== 'string' || b.text.trim() === '') {
    errors.push('text（译文文本）必须是非空字符串');
  }
  if (!isInt(b.cue_version) || b.cue_version < 1) {
    errors.push('cue_version（读取时源字幕行版本）必须是 ≥1 的整数');
  }
  let version = 0;
  if (b.version !== undefined && b.version !== null) {
    if (!isInt(b.version) || b.version < 0) {
      errors.push('version（译文版本）必须是 ≥0 的整数；新建传 0 或省略，更新传当前版本');
    } else {
      version = b.version;
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    item: errors.length === 0 ? { text: b.text, cue_version: b.cue_version, version } : null,
  };
}

/** 确认待复核译文请求：{ version } 必填正整数 */
function parseConfirmBody(body) {
  const errors = [];
  const b = body || {};
  if (!isInt(b.version) || b.version < 1) {
    errors.push('version（当前译文版本）必须是 ≥1 的整数');
  }
  return { ok: errors.length === 0, errors, version: isInt(b.version) ? b.version : null };
}

/**
 * 译文自身的现行规则校验：字数 ≤ max_chars；字速（沿用源行起止）≤ max_cps。
 * 时长/词时段/切点由源字幕保证（译文不改时间与切点），不在此重复。
 * 返回中文原因列表，空数组表示通过。
 */
function checkTranslationText(text, cue, rules) {
  const reasons = [];
  const len = text.length;
  if (len > rules.max_chars) {
    reasons.push(`译文 ${len} 字，超过单条最大字数 ${rules.max_chars}`);
  }
  const dur = cue.end_ms - cue.start_ms;
  if (dur > 0) {
    const cps = len / (dur / 1000);
    if (cps > rules.max_cps + 1e-9) {
      reasons.push(`译文 ${cps.toFixed(1)} 字/秒，超过每秒最多 ${rules.max_cps} 字（沿用源行 ${dur}ms）`);
    }
  }
  return reasons;
}

const mapRow = (r) => ({
  id: r.id,
  lang: r.lang,
  subtitle_id: r.subtitle_id,
  text: r.text,
  status: r.status,
  version: r.version,
  cue_version_snapshot: r.cue_version_snapshot,
  src_text: r.src_text,
  src_start_ms: r.src_start_ms,
  src_end_ms: r.src_end_ms,
  src_word_start: r.src_word_start,
  src_word_end: r.src_word_end,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

/**
 * 源字幕变更后的统一失效对账（在源变更事务提交后或事务内调用均可）：
 *   1) 源行已删除/置空（重排删除、重新导入）→ history（不按序号挪用）；
 *   2) current 译文：源 文本/时间/词区间 相对快照变化 → review；
 *      仅锁定(locked)或展示顺序(idx)变化不处理；
 *   3) 已经是 review/history 的行保持状态：review 只能由校对者显式确认恢复。
 * 返回 { history, review } 本次受影响数量。
 */
function syncTranslations(db, projectId) {
  const orphaned = db.prepare(
    `UPDATE translations
        SET status = 'history', subtitle_id = NULL, updated_at = datetime('now')
      WHERE project_id = ? AND status != 'history'
        AND (subtitle_id IS NULL
             OR NOT EXISTS (SELECT 1 FROM subtitles s WHERE s.id = subtitle_id))`
  ).run(projectId).changes;

  const reviewed = db.prepare(
    `UPDATE translations
        SET status = 'review', updated_at = datetime('now')
      WHERE project_id = ? AND status = 'current'
        AND EXISTS (SELECT 1 FROM subtitles s WHERE s.id = translations.subtitle_id)
        AND (src_text != (SELECT text FROM subtitles s WHERE s.id = translations.subtitle_id)
             OR src_start_ms != (SELECT start_ms FROM subtitles s WHERE s.id = translations.subtitle_id)
             OR src_end_ms   != (SELECT end_ms   FROM subtitles s WHERE s.id = translations.subtitle_id)
             OR src_word_start != (SELECT word_start FROM subtitles s WHERE s.id = translations.subtitle_id)
             OR src_word_end   != (SELECT word_end   FROM subtitles s WHERE s.id = translations.subtitle_id))`
  ).run(projectId).changes;

  return { history: orphaned, review: reviewed };
}

/** 取某项目某语言全部非历史译文（按 subtitle_id） */
function activeTranslationsByLang(db, projectId, lang) {
  const rows = db.prepare(
    `SELECT * FROM translations WHERE project_id = ? AND lang = ? AND status != 'history'
     ORDER BY id`
  ).all(projectId, lang);
  const byCue = new Map();
  for (const r of rows) {
    if (!byCue.has(r.subtitle_id)) byCue.set(r.subtitle_id, r);
  }
  return byCue;
}

/** 历史译文（源行已删除/重新导入），按语言或全部语言 */
function listHistory(db, projectId, lang) {
  const rows = lang
    ? db.prepare(
        `SELECT * FROM translations WHERE project_id = ? AND lang = ? AND status = 'history'
         ORDER BY id DESC`
      ).all(projectId, lang)
    : db.prepare(
        `SELECT * FROM translations WHERE project_id = ? AND status = 'history' ORDER BY id DESC`
      ).all(projectId);
  return rows.map(mapRow);
}

/**
 * 并列查询视图：按展示顺序列出每条当前字幕 + 该语言译文 + 状态与现行规则原因。
 * 每条 entry：
 *   cue          当前源字幕（id/idx/词区间/原文/起止/locked/version）
 *   translation  非历史译文行（无则 null）
 *   state        missing | current | review
 *   valid        是否可参与导出（current 且满足现行字数/字速规则）
 *   invalid_reasons []  现行规则不通过的中文原因（review 也会动态计算）
 */
function buildLangView(db, projectId, lang) {
  const project = db.prepare('SELECT sub_version FROM projects WHERE id = ?').get(projectId);
  const rulesRow = db.prepare('SELECT * FROM rules WHERE project_id = ?').get(projectId);
  const rules = {
    version: rulesRow.version, max_chars: rulesRow.max_chars,
    min_duration_ms: rulesRow.min_duration_ms, max_cps: rulesRow.max_cps,
  };
  const cues = db.prepare(
    `SELECT id, idx, word_start, word_end, text, start_ms, end_ms, locked, version
     FROM subtitles WHERE project_id = ? ORDER BY idx`
  ).all(projectId);
  const byCue = activeTranslationsByLang(db, projectId, lang);

  const entries = cues.map((cue) => {
    const row = byCue.get(cue.id);
    const translation = row ? mapRow(row) : null;
    let state = 'missing';
    let valid = false;
    let invalidReasons = [];
    if (row) {
      state = row.status === 'review' ? 'review' : 'current';
      invalidReasons = checkTranslationText(row.text, cue, rules);
      valid = state === 'current' && invalidReasons.length === 0;
    }
    return { cue, translation, state, valid, invalid_reasons: invalidReasons };
  });

  const counts = {
    cues: cues.length,
    missing: 0, current: 0, review: 0, valid: 0,
  };
  for (const e of entries) {
    counts[e.state]++;
    if (e.valid) counts.valid++;
  }
  return {
    lang,
    sub_version: project.sub_version,
    rules_version: rules.version,
    rules,
    counts,
    entries,
    exports: db.prepare(
      'SELECT lang, version, cue_count, created_at FROM translation_exports WHERE project_id = ? AND lang = ? ORDER BY version DESC'
    ).all(projectId, lang),
    history: listHistory(db, projectId, lang),
  };
}

/**
 * 项目语言总览：每种语言的译文状态分布 + 导出数（含历史条数）。
 */
function listLanguages(db, projectId) {
  const rows = db.prepare(
    `SELECT lang,
            SUM(CASE WHEN status != 'history' THEN 1 ELSE 0 END) AS active_count,
            SUM(CASE WHEN status = 'current' THEN 1 ELSE 0 END) AS current_count,
            SUM(CASE WHEN status = 'review'  THEN 1 ELSE 0 END) AS review_count,
            SUM(CASE WHEN status = 'history' THEN 1 ELSE 0 END) AS history_count
       FROM translations WHERE project_id = ? GROUP BY lang ORDER BY lang`
  ).all(projectId);
  const exportCounts = db.prepare(
    'SELECT lang, COUNT(*) AS n FROM translation_exports WHERE project_id = ? GROUP BY lang'
  ).all(projectId);
  const expByLang = new Map(exportCounts.map((r) => [r.lang, r.n]));
  return rows.map((r) => ({
    lang: r.lang,
    active_count: r.active_count,
    current_count: r.current_count,
    review_count: r.review_count,
    history_count: r.history_count,
    export_count: expByLang.get(r.lang) || 0,
  }));
}

/**
 * 按语言导出前核对：
 *   1) 整版源字幕结构（覆盖/重叠/切点/词时段）与现行规则（含时长/字数/字速）必须通过；
 *   2) 当前每行都必须有一份 current 且满足现行字数/字速规则的译文。
 * 通过 → { ok:true, entries }；否则列出 missing/review/invalid/conflicts，不生成快照。
 */
function evaluateExport(db, projectId, lang) {
  const view = buildLangView(db, projectId, lang);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  const words = db.prepare(
    'SELECT idx, text, start_ms, end_ms FROM words WHERE project_id = ? ORDER BY idx'
  ).all(projectId);
  const cuts = db.prepare(
    'SELECT cut_ms FROM shots WHERE project_id = ? ORDER BY idx'
  ).all(projectId).map((r) => r.cut_ms);
  // 延迟引用避免循环依赖（layout 不依赖本模块）
  const { validateStructure, validateRules } = require('./layout');
  const conflicts = [
    ...validateStructure(view.entries.map((e) => e.cue), words, cuts),
    ...validateRules(view.entries.map((e) => e.cue), view.rules),
  ];

  const missing = [];
  const review = [];
  const invalid = [];
  for (const e of view.entries) {
    if (!e.translation) {
      missing.push({ subtitle_id: e.cue.id, idx: e.cue.idx, text: e.cue.text });
    } else if (e.state === 'review') {
      review.push({
        subtitle_id: e.cue.id, idx: e.cue.idx, text: e.cue.text,
        translation: e.translation, invalid_reasons: e.invalid_reasons,
      });
    } else if (!e.valid) {
      invalid.push({
        subtitle_id: e.cue.id, idx: e.cue.idx, text: e.cue.text,
        translation: e.translation, reasons: e.invalid_reasons,
      });
    }
  }

  const ok = conflicts.length === 0 && missing.length === 0 &&
    review.length === 0 && invalid.length === 0;
  return {
    ok, lang,
    sub_version: project.sub_version,
    rules_version: view.rules_version,
    counts: view.counts,
    entries: view.entries,
    missing, review, invalid, conflicts,
  };
}

module.exports = {
  MAX_LANG_LEN,
  normalizeLang,
  parseTranslationBody,
  parseConfirmBody,
  checkTranslationText,
  syncTranslations,
  buildLangView,
  listLanguages,
  listHistory,
  evaluateExport,
  activeTranslationsByLang,
  mapRow,
};
