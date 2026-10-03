'use strict';

const { computeLayout, validateStructure, validateRules } = require('./layout');

/**
 * 校对者逐词时间修正：请求解析与候选整版核对（纯函数，不依赖数据库）。
 *
 * 一项修正：{ word_idx, start_ms, end_ms }
 *   - word_idx        词序号（words.idx，词序与词文本永不变更，只改时间）
 *   - start_ms/end_ms 修正后的起止毫秒：非负整数且 start < end，组内序号不得重复
 *
 * 核对模型：
 *   把修正应用到当前词序列得到 mergedWords，要求全部词仍按序互不重叠；
 *   锁定字幕的文本与时间必须原样保留——锁定区间内的词（含因切点落入词内）
 *   修正后仍须完整落在锁定时段内、且不把切点带进锁定字幕；
 *   含修正词的未锁定字幕整体删除，仅对这些受影响区间重新排版，
 *   其余字幕（含锁定字幕与未受影响的未锁定字幕）保留 ID/行版本/人工文本/时间；
 *   候选整版须满足词完整覆盖、切点隔离与现行字数/时长/字速规则。
 */

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

const MAX_ITEMS = 1000;

/**
 * 解析提交请求的“形状”（与项目当前状态无关）：
 * 空组、重复词序号、字段类型、非法时间。
 * 返回 { ok, items, errors }，items: [{word_idx, start_ms, end_ms}]。
 */
function parseWordRevisionItems(body) {
  const errors = [];
  const rawItems = body && body.items;
  if (!Array.isArray(rawItems)) {
    return { ok: false, errors: ['请求体必须包含 items 数组'] };
  }
  if (rawItems.length === 0) {
    return { ok: false, errors: ['修正组为空：items 至少包含一项'] };
  }
  if (rawItems.length > MAX_ITEMS) {
    return { ok: false, errors: [`单组修正项 ${rawItems.length} 超过上限 ${MAX_ITEMS}`] };
  }
  const seen = new Set();
  const items = [];
  const pushErr = (msg) => {
    if (errors.length < 20) errors.push(msg);
  };
  rawItems.forEach((raw, i) => {
    const it = raw || {};
    let rowBad = false;
    if (!isInt(it.word_idx) || it.word_idx < 0) {
      pushErr(`第 ${i + 1} 项：word_idx 必须是 ≥0 的整数词序号`);
      rowBad = true;
    } else if (seen.has(it.word_idx)) {
      pushErr(`第 ${i + 1} 项：词序号 ${it.word_idx} 在同一组内重复`);
      rowBad = true;
    } else {
      seen.add(it.word_idx);
    }
    if (!isInt(it.start_ms) || it.start_ms < 0) {
      pushErr(`第 ${i + 1} 项：start_ms 必须是非负整数毫秒`);
      rowBad = true;
    }
    if (!isInt(it.end_ms) || it.end_ms < 0) {
      pushErr(`第 ${i + 1} 项：end_ms 必须是非负整数毫秒`);
      rowBad = true;
    }
    if (isInt(it.start_ms) && isInt(it.end_ms) && it.start_ms >= it.end_ms) {
      pushErr(`第 ${i + 1} 项：词 ${it.word_idx} 非法时间 [${it.start_ms}, ${it.end_ms}]，开始必须早于结束`);
      rowBad = true;
    }
    if (!rowBad) {
      items.push({ word_idx: it.word_idx, start_ms: it.start_ms, end_ms: it.end_ms });
    }
  });
  if (errors.length >= 20 && rawItems.length > errors.length) {
    errors.push('……错误过多，仅显示前 20 条');
  }
  return { ok: errors.length === 0, items, errors };
}

function wordRef(k, words) {
  return words[k] ? `词 ${k} "${words[k].text}"` : `词 ${k}`;
}

/** 区间并集：[[a,b],...] → 互不相交、按起点升序的区间列表 */
function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function inAny(k, regions) {
  return regions.some(([a, b]) => a <= k && k <= b);
}

/**
 * 整版核对。输入当前项目完整载荷与 loadWordRevision() 得到的提议。
 *
 * 返回：
 *   ok                  是否可确认（原子写入）
 *   stale               提议读取时的字幕集版本是否已过期（409 类）
 *   items[]             逐项原值/当前值/建议值、state（ok/missing/drifted）与 conflicts
 *   replaced[]          将被删除重排的受影响未锁定字幕（当前行）
 *   affected_locked[]   含修正词、原样保留的锁定字幕
 *   subtitles[]         候选整版：kept（保留 ID/版本）/ new（重排新行，id 为 null）
 *   conflicts[]         无法归到具体修正项的整版级冲突
 *
 * 409 类（过期/失效）：stale、item.state=missing/drifted；
 * 422 类（规则/结构不可兼顾）：其余全部 conflicts。
 */
function evaluateWordRevision({ project, revision }) {
  const { words, cuts, rules, subtitles } = project;
  const n = words.length;
  const stale = revision.sub_version_snapshot !== project.sub_version;

  // 以词序号为键的修正项（保留组内 ord 用于展示）
  const itemByWord = new Map();
  for (const it of revision.items) itemByWord.set(it.word_idx, it);
  const correctedSet = new Set(revision.items.map((it) => it.word_idx));

  // 1. 逐项状态：缺失（重新导入后词序号不存在）/ 漂移（读取后词时间又被改过）
  const itemResults = revision.items.map((it) => {
    const k = it.word_idx;
    const w = words[k];
    const entry = {
      ord: it.ord,
      word_idx: k,
      word_text: w ? w.text : (it.word_text ?? null),
      orig: it.orig,
      current: w ? { text: w.text, start_ms: w.start_ms, end_ms: w.end_ms } : null,
      proposed: it.proposed,
      state: 'ok',
      conflicts: [],
    };
    if (!w) {
      entry.state = 'missing';
      entry.conflicts.push({
        type: 'word_missing', word_idx: k,
        message: `词 ${k} 已不存在（提交后可能重新导入了转写），无法应用该修正；请按当前词表重新提交`,
      });
      return entry;
    }
    if (w.start_ms !== it.orig.start_ms || w.end_ms !== it.orig.end_ms) {
      entry.state = 'drifted';
      entry.conflicts.push({
        type: 'word_changed', word_idx: k,
        message:
          `${wordRef(k, words)} 在你读取后已被修改：读取时为 [${it.orig.start_ms}, ${it.orig.end_ms}]，` +
          `当前已是 [${w.start_ms}, ${w.end_ms}]，请刷新后重新修正`,
      });
    }
    return entry;
  });
  const resultByWord = new Map(itemResults.map((r) => [r.word_idx, r]));

  const attach = (k, conflict) => {
    const r = resultByWord.get(k);
    if (r && !r.conflicts.some((c) => c.type === conflict.type && c.message === conflict.message)) {
      r.conflicts.push(conflict);
    } else if (!r) {
      globalConflicts.push(conflict);
    }
  };
  const globalConflicts = [];

  // 2. 应用修正得到候选词序列（词序、词文本不变）
  const merged = words.map((w, k) => {
    const it = itemByWord.get(k);
    return it ? { ...w, start_ms: it.proposed.start_ms, end_ms: it.proposed.end_ms } : { ...w };
  });

  // 3. 修正后全部词仍须按序、互不重叠（允许首尾相接）
  for (let k = 0; k + 1 < n; k++) {
    const a = merged[k];
    const b = merged[k + 1];
    if (b.start_ms < a.end_ms) {
      if (correctedSet.has(k)) {
        attach(k, {
          type: 'word_overlap', word_idx: k,
          message:
            `${wordRef(k, merged)} 修正后结束于 ${a.end_ms}ms，晚于后一词 "${b.text}" 的开始 ${b.start_ms}ms，` +
            '修正后全部词仍须按序且互不重叠',
        });
      }
      if (correctedSet.has(k + 1)) {
        attach(k + 1, {
          type: 'word_overlap', word_idx: k + 1,
          message:
            `${wordRef(k + 1, merged)} 修正后开始于 ${b.start_ms}ms，早于前一词 "${a.text}" 的结束 ${a.end_ms}ms，` +
            '修正后全部词仍须按序且互不重叠',
        });
      }
      if (!correctedSet.has(k) && !correctedSet.has(k + 1)) {
        globalConflicts.push({
          type: 'word_overlap', word_idx: k, word_end: k + 1,
          message: `词 ${k} "${a.text}" 与词 ${k + 1} "${b.text}" 时间重叠，无法形成有序词序列`,
        });
      }
    }
  }

  // 4. 锁定字幕原样保留：锁定区间内的词修正后仍须完整落在锁定时段内，
  //    且镜头切点不得因词段移动而落入锁定字幕覆盖的词内部（切点隔离）。
  const affectedLockedIds = new Set();
  const lockedCues = subtitles.filter((s) => s.locked === 1);
  for (const L of lockedCues) {
    for (let k = L.word_start; k <= L.word_end; k++) {
      if (!correctedSet.has(k)) continue;
      affectedLockedIds.add(L.id);
      const mw = merged[k];
      if (mw.start_ms < L.start_ms || mw.end_ms > L.end_ms) {
        attach(k, {
          type: 'locked_word_span', word_idx: k, subtitle_id: L.id,
          message:
            `${wordRef(k, merged)} 修正后时段 [${mw.start_ms}, ${mw.end_ms}] 超出锁定字幕 ${L.id}` +
            `（"${L.text}" [${L.start_ms}, ${L.end_ms}]）的边界：锁定字幕的文本与时间必须原样保留，该修正无法兼顾`,
        });
      }
      for (const c of cuts) {
        if (mw.start_ms < c && c < mw.end_ms) {
          attach(k, {
            type: 'locked_cut_inside_word', word_idx: k, subtitle_id: L.id,
            message:
              `${wordRef(k, merged)} 修正后时段 [${mw.start_ms}, ${mw.end_ms}] 把镜头切点 ${c}ms 包入词内，` +
              `而该词属于必须原样保留的锁定字幕 ${L.id}（字幕不得跨切点），该修正无法兼顾`,
          });
        }
      }
    }
  }

  // 5. 受影响的未锁定字幕：词区间含任意修正词 → 整条删除并重排其并集区间
  const replaced = subtitles.filter(
    (s) => s.locked === 0 &&
      [...correctedSet].some((k) => s.word_start <= k && k <= s.word_end && k < n)
  );
  const replacedIds = new Set(replaced.map((s) => s.id));
  const regions = mergeIntervals(replaced.map((s) => [s.word_start, s.word_end]));

  // 6. 对受影响区间重新排版：固定字幕 = 全部保留行（锁定 + 未受影响未锁定）
  let candidate = null;
  const fixed = subtitles.filter((s) => !replacedIds.has(s.id));
  const anyBlocking409 =
    stale || itemResults.some((r) => r.state !== 'ok') || globalConflicts.length > 0;

  if (!anyBlocking409) {
    const result = computeLayout({
      words: merged, cuts, rules,
      locked: fixed.map((s) => ({
        word_start: s.word_start, word_end: s.word_end, text: s.text,
        start_ms: s.start_ms, end_ms: s.end_ms, locked: s.locked,
      })),
    });
    if (!result.ok) {
      // 只归因到重排区间：区间内冲突定位到修正词；区间外（理论上不出现）列整版
      for (const cf of result.conflicts) {
        const hitRegion = regions.some(
          ([a, b]) => !(cf.word_end < a || cf.word_start > b)
        );
        if (!hitRegion) {
          globalConflicts.push(cf);
          continue;
        }
        const hitItems = itemResults.filter(
          (r) => r.state === 'ok' && r.word_idx >= cf.word_start && r.word_idx <= cf.word_end
        );
        if (hitItems.length > 0) {
          for (const r of hitItems) {
            r.conflicts.push({ ...cf, word_idx: r.word_idx });
          }
        } else {
          // 重排把冲突推到区间内但不在修正词上（如相邻挤压），归给区间内首个修正词
          const anchor = itemResults
            .filter((r) => r.state === 'ok' && inAny(r.word_idx, regions))
            .sort((x, y) => x.word_idx - y.word_idx)[0];
          if (anchor) anchor.conflicts.push({ ...cf, word_idx: anchor.word_idx });
          else globalConflicts.push(cf);
        }
      }
    } else {
      // 7. 组装候选整版：保留行沿用 ID/版本/locked；重排新行 id/version 为 null
      const fixedByRange = new Map(fixed.map((s) => [`${s.word_start}:${s.word_end}`, s]));
      candidate = result.cues.map((c) => {
        const keep = fixedByRange.get(`${c.word_start}:${c.word_end}`);
        if (keep) {
          return {
            id: keep.id, version: keep.version, locked: keep.locked, origin: 'kept',
            word_start: keep.word_start, word_end: keep.word_end,
            text: keep.text, start_ms: keep.start_ms, end_ms: keep.end_ms,
          };
        }
        return {
          id: null, version: null, locked: 0, origin: 'new',
          word_start: c.word_start, word_end: c.word_end,
          text: c.text, start_ms: c.start_ms, end_ms: c.end_ms,
        };
      });

      // 8. 候选整版兜底：结构（覆盖/重叠/切点/词时段）+ 现行规则（含锁定行）
      const structural = validateStructure(candidate, merged, cuts);
      const ruleProblems = validateRules(candidate, rules);
      const cueByRange = new Map(subtitles.map((s) => [`${s.word_start}:${s.word_end}`, s]));
      for (const prob of [...structural, ...ruleProblems]) {
        const oldCue = cueByRange.get(`${prob.word_start}:${prob.word_end}`);
        const hitItems = itemResults.filter(
          (r) => r.state === 'ok' && prob.word_start <= r.word_idx && r.word_idx <= prob.word_end
        );
        const enriched = { ...prob, ...(oldCue ? { subtitle_id: oldCue.id } : {}) };
        if (!oldCue || oldCue.locked === 1 || !replacedIds.has(oldCue.id) || hitItems.length === 0) {
          // 保留行（锁定/未受影响）违规，或无法定位到修正词 → 整版级冲突
          globalConflicts.push(enriched);
        } else {
          for (const r of hitItems) r.conflicts.push({ ...enriched, word_idx: r.word_idx });
        }
      }
    }
  }

  const anyItemBlocking = itemResults.some((r) => r.state !== 'ok' || r.conflicts.length > 0);
  return {
    ok: !stale && !anyItemBlocking && globalConflicts.length === 0 && candidate !== null,
    stale,
    items: itemResults,
    replaced,
    affected_locked: lockedCues.filter((L) => affectedLockedIds.has(L.id)),
    subtitles: candidate || [],
    merged_words: stale || anyBlocking409 ? [] : merged,
    conflicts: globalConflicts,
  };
}

module.exports = {
  parseWordRevisionItems,
  evaluateWordRevision,
  mergeIntervals,
  MAX_ITEMS,
  isInt,
};
