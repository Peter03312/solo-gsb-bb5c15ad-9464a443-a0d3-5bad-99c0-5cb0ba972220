'use strict';

/**
 * 字幕排版引擎（纯函数，不依赖数据库）。
 *
 * 输入：
 *   words  : [{ idx, text, start_ms, end_ms }]  按 idx 升序、互不重叠（导入时已校验）
 *   cuts   : [ms, ...]                          镜头切点，升序
 *   rules  : { max_chars, min_duration_ms, max_cps }
 *   locked : [{ word_start, word_end, text, start_ms, end_ms }] 已锁定字幕（原样保留）
 *
 * 输出（二选一）：
 *   { ok: true,  cues: [{ word_start, word_end, text, start_ms, end_ms, locked }] } 按时间升序
 *   { ok: false, conflicts: [{ type, word_start, word_end, message }] }
 *
 * 硬性约束：
 *   1. 按原词序覆盖全部词，每词恰好属于一条字幕；
 *   2. 字幕互不重叠（允许首尾相接）；
 *   3. 字幕时段内部不得包含镜头切点；
 *   4. 不得缩短任何词本身的时段（字幕必须完整包含其所有词的时段）；
 *   5. 文本字数 <= max_chars；显示时长 >= min_duration_ms；字数/秒 <= max_cps。
 * 无法满足时返回冲突列表（受影响词段 + 冲突条件），绝不输出貌似完整的结果。
 */

// 中日韩字符范围：拼接词时 CJK 之间不加空格，西文词之间加空格
const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/;

function needsSpace(prevLastChar, nextFirstChar) {
  return !CJK.test(prevLastChar) && !CJK.test(nextFirstChar);
}

function joinWords(texts) {
  let out = '';
  for (const t of texts) {
    if (!out) { out = t; continue; }
    out += needsSpace(out[out.length - 1], t[0]) ? ' ' + t : t;
  }
  return out;
}

function preview(words, a, b, max = 24) {
  const t = joinWords(words.slice(a, b + 1).map((w) => w.text));
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** 第一个 end_ms >= c 的词下标；不存在则返回 words.length */
function firstWordWithEndGE(words, c) {
  let lo = 0, hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].end_ms >= c) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/** <= t 的最大切点；无则 null */
function lastCutAtOrBelow(cuts, t) {
  let lo = 0, hi = cuts.length; // 找第一个 > t 的位置
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cuts[mid] <= t) lo = mid + 1; else hi = mid;
  }
  return lo > 0 ? cuts[lo - 1] : null;
}

/** >= t 的最小切点；无则 null */
function firstCutAtOrAbove(cuts, t) {
  let lo = 0, hi = cuts.length; // 找第一个 >= t 的位置
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cuts[mid] >= t) hi = mid; else lo = mid + 1;
  }
  return lo < cuts.length ? cuts[lo] : null;
}

/**
 * 由镜头切点计算强制断点与"切点落在词内"冲突。
 * 词 k 与 k+1 之间必须断开  <=>  存在切点 c 满足 end_k <= c <= start_{k+1}。
 * 若 start_k < c < end_k，则切点落在词 k 内部，任何含该词的字幕都会跨切点 → 冲突。
 */
function analyzeCuts(words, cuts, conflicts) {
  const forcedBreaks = new Set(); // 元素 k 表示词 k 与 k+1 之间必须断开
  const n = words.length;
  for (const c of cuts) {
    const k = firstWordWithEndGE(words, c);
    if (k >= n) continue; // 切点在全部词之后，无影响
    const w = words[k];
    if (w.start_ms < c && c < w.end_ms) {
      conflicts.push({
        type: 'cut_inside_word',
        word_start: k,
        word_end: k,
        message:
          `镜头切点 ${c}ms 落在词 "${w.text}" 的时段 [${w.start_ms}, ${w.end_ms}] 内部：` +
          `字幕不得跨镜头切点，也不得缩短词本身的时段，两个条件无法同时满足`,
      });
    } else if (c <= w.start_ms) {
      if (k >= 1) forcedBreaks.add(k - 1);
    } else {
      // c == w.end_ms（start < c <= end 且非内部，只可能等于 end）
      if (k + 1 <= n - 1) forcedBreaks.add(k);
    }
  }
  return forcedBreaks;
}

/** 在一个词区间 [a, b] 内按 max_chars 与强制断点做贪心最大装填切分 */
function segmentRegion(words, a, b, forcedBreaks, rules, conflicts) {
  const segs = [];
  let segStart = a;
  let curText = '';
  for (let k = a; k <= b; k++) {
    const wtext = words[k].text;
    if (wtext.length > rules.max_chars) {
      conflicts.push({
        type: 'max_chars',
        word_start: k,
        word_end: k,
        message:
          `词 "${wtext}" 本身长 ${wtext.length} 字，超过单条字幕最大字数 ${rules.max_chars}：` +
          `词不可拆分，无法同时满足"覆盖全部词"与"最大字数"两个条件`,
      });
    }
    const sep = curText && needsSpace(curText[curText.length - 1], wtext[0]) ? 1 : 0;
    if (curText !== '' &&
        (forcedBreaks.has(k - 1) || curText.length + sep + wtext.length > rules.max_chars)) {
      segs.push([segStart, k - 1]);
      segStart = k;
      curText = wtext;
    } else {
      curText = curText ? (sep ? curText + ' ' + wtext : curText + wtext) : wtext;
    }
  }
  if (segStart <= b) segs.push([segStart, b]);
  return segs;
}

/**
 * 为一个区域内的分段从左到右分配时间。
 * lowerBound / upperBound：区域两端由锁定字幕（或视频边界）给出的时间界限。
 * 每条字幕：默认取 [首词.start, 末词.end]，必要时先向后、再向前扩展以满足
 * 最短时长与每秒字数；扩展空间被相邻字幕与镜头切点限制，仍不够则记冲突。
 */
function timeRegion(words, segs, cuts, rules, lowerBound, upperBound, conflicts) {
  const cues = [];
  let prevE = lowerBound;
  for (let i = 0; i < segs.length; i++) {
    const [p, q] = segs[i];
    const text = joinWords(words.slice(p, q + 1).map((w) => w.text));
    const sDef = words[p].start_ms;
    const eDef = words[q].end_ms;
    const span = eDef - sDef;
    const cpsNeed = Math.ceil((text.length / rules.max_cps) * 1000);
    const need = Math.max(span, rules.min_duration_ms, cpsNeed);

    // S 的下界：前一条字幕的结束、区域下界、以及 <= sDef 的最近切点
    let lowS = Math.max(prevE, 0);
    const cutBelow = lastCutAtOrBelow(cuts, sDef);
    if (cutBelow !== null) lowS = Math.max(lowS, cutBelow);
    // E 的上界：区域上界、下一段首词的开始（下一段的 S 不可能超过其首词开始）、>= eDef 的最近切点
    let hiE = upperBound;
    if (i + 1 < segs.length) hiE = Math.min(hiE, words[segs[i + 1][0]].start_ms);
    const cutAbove = firstCutAtOrAbove(cuts, eDef);
    if (cutAbove !== null) hiE = Math.min(hiE, cutAbove);

    let S = sDef;
    let E = S + need;
    if (E > hiE) { E = hiE; S = E - need; } // 先尽量向后扩，不够再向前借
    if (S < lowS) {
      const reasons = [];
      if (rules.min_duration_ms > span) reasons.push(`最短显示时长 ${rules.min_duration_ms}ms`);
      if (cpsNeed > span) {
        reasons.push(
          `每秒最多 ${rules.max_cps} 字（该段 ${text.length} 字 / ${(span / 1000).toFixed(2)}s` +
          ` = ${(text.length / (span / 1000)).toFixed(1)} 字/秒）`
        );
      }
      conflicts.push({
        type: 'duration',
        word_start: p,
        word_end: q,
        message:
          `词段 [${p}..${q}] "${preview(words, p, q)}" 需要至少 ${need}ms 才能满足` +
          `${reasons.join(' 与 ')}，但受相邻字幕/镜头切点限制，可用空间只有 ${Math.max(0, hiE - lowS)}ms`,
      });
      // 冲突收集模式下仍放一个占位，保证后续段的边界推算正常
      S = Math.max(lowS, hiE - need);
      E = hiE;
    }
    cues.push({ word_start: p, word_end: q, text, start_ms: S, end_ms: E, locked: 0 });
    prevE = E;
  }
  return cues;
}

/**
 * 计算整版字幕。locked 中的字幕原样保留，只重排未锁定词段。
 */
function computeLayout({ words, cuts, rules, locked }) {
  const conflicts = [];
  const n = words.length;

  // 1. 锁定字幕自身一致性：词区间不相交、时间不重叠
  const lockedSorted = [...locked].sort((x, y) => x.word_start - y.word_start);
  for (let i = 0; i < lockedSorted.length; i++) {
    const L = lockedSorted[i];
    if (L.word_start < 0 || L.word_end >= n || L.word_start > L.word_end) {
      conflicts.push({
        type: 'locked_invalid', word_start: L.word_start, word_end: L.word_end,
        message: `锁定字幕覆盖的词区间 [${L.word_start}..${L.word_end}] 超出转写范围`,
      });
    }
    if (i > 0) {
      const P = lockedSorted[i - 1];
      if (L.word_start <= P.word_end) {
        conflicts.push({
          type: 'locked_overlap', word_start: L.word_start, word_end: L.word_end,
          message: `两条锁定字幕的词区间重叠：[${P.word_start}..${P.word_end}] 与 [${L.word_start}..${L.word_end}]`,
        });
      } else if (L.start_ms < P.end_ms) {
        conflicts.push({
          type: 'locked_overlap', word_start: L.word_start, word_end: L.word_end,
          message: `锁定字幕时间重叠：[${P.start_ms}, ${P.end_ms}] 与 [${L.start_ms}, ${L.end_ms}]`,
        });
      }
    }
  }
  if (conflicts.length > 0) return { ok: false, conflicts };
  if (n === 0) return { ok: true, cues: [] };

  // 2. 切点分析：强制断点 + 切点落词内冲突
  const forcedBreaks = analyzeCuts(words, cuts, conflicts);

  // 3. 求未锁定词区域（被锁定字幕覆盖的词排除在外）
  const regions = [];
  let cursor = 0;
  let prevLockedEnd = 0;
  for (const L of lockedSorted) {
    if (cursor <= L.word_start - 1) {
      regions.push({ a: cursor, b: L.word_start - 1, lower: prevLockedEnd, upper: L.start_ms });
    }
    prevLockedEnd = L.end_ms;
    cursor = L.word_end + 1;
  }
  if (cursor <= n - 1) {
    regions.push({ a: cursor, b: n - 1, lower: prevLockedEnd, upper: Infinity });
  }

  // 4. 逐区域切分 + 定时（即使已有冲突也继续，尽量收集完整报告）
  const newCues = [];
  for (const r of regions) {
    const segs = segmentRegion(words, r.a, r.b, forcedBreaks, rules, conflicts);
    const timed = timeRegion(words, segs, cuts, rules, r.lower, r.upper, conflicts);
    newCues.push(...timed);
  }

  if (conflicts.length > 0) return { ok: false, conflicts };

  // 5. 合并固定字幕，按时间升序（入参固定行一般为锁定行；逐词修正重排时也会
  //    传入未受影响的未锁定行——此时显式携带 locked: 0）
  const cues = [
    ...lockedSorted.map((L) => ({
      word_start: L.word_start, word_end: L.word_end, text: L.text,
      start_ms: L.start_ms, end_ms: L.end_ms, locked: L.locked === 0 ? 0 : 1,
    })),
    ...newCues,
  ].sort((x, y) => x.start_ms - y.start_ms || x.word_start - y.word_start);

  // 6. 兜底自检（防御性）：结构不变量必须成立
  const structural = validateStructure(cues, words, cuts);
  if (structural.length > 0) return { ok: false, conflicts: structural };

  return { ok: true, cues };
}

/**
 * 结构不变量校验（供排版自检与导出前校验共用）：
 * 覆盖全部词且每词一次、顺序、不重叠、不跨切点、不缩短词时段。
 */
function validateStructure(cues, words, cuts) {
  const problems = [];
  const n = words.length;
  const covered = new Array(n).fill(0);
  const sorted = [...cues].sort((x, y) => x.start_ms - y.start_ms);

  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    if (c.word_start < 0 || c.word_end >= n || c.word_start > c.word_end) {
      problems.push({
        type: 'structure', word_start: c.word_start, word_end: c.word_end,
        message: `字幕 #${i + 1} 词区间 [${c.word_start}..${c.word_end}] 非法`,
      });
      continue;
    }
    for (let k = c.word_start; k <= c.word_end; k++) covered[k]++;
    const ws = words[c.word_start], we = words[c.word_end];
    if (c.start_ms > ws.start_ms || c.end_ms < we.end_ms) {
      problems.push({
        type: 'word_span_shortened', word_start: c.word_start, word_end: c.word_end,
        message:
          `字幕 #${i + 1} [${c.start_ms}, ${c.end_ms}] 缩短了词本身的时段` +
          `（词区间要求 [${ws.start_ms}, ${we.end_ms}] 被完整包含）`,
      });
    }
    for (const cut of cuts) {
      if (c.start_ms < cut && cut < c.end_ms) {
        problems.push({
          type: 'cut_crossed', word_start: c.word_start, word_end: c.word_end,
          message: `字幕 #${i + 1} [${c.start_ms}, ${c.end_ms}] 跨过镜头切点 ${cut}ms`,
        });
      }
    }
    if (i > 0 && sorted[i - 1].end_ms > c.start_ms) {
      problems.push({
        type: 'overlap', word_start: c.word_start, word_end: c.word_end,
        message: `字幕 #${i} 与 #${i + 1} 时间重叠：[${sorted[i - 1].start_ms}, ${sorted[i - 1].end_ms}] 与 [${c.start_ms}, ${c.end_ms}]`,
      });
    }
  }
  for (let k = 0; k < n; k++) {
    if (covered[k] === 0) {
      problems.push({
        type: 'coverage', word_start: k, word_end: k,
        message: `词 #${k} "${words[k].text}" 未被任何字幕覆盖`,
      });
    } else if (covered[k] > 1) {
      problems.push({
        type: 'coverage', word_start: k, word_end: k,
        message: `词 #${k} "${words[k].text}" 被 ${covered[k]} 条字幕重复覆盖`,
      });
    }
  }
  return problems;
}

/**
 * 规则校验（导出前对全部字幕执行，含锁定字幕）。
 */
function validateRules(cues, rules) {
  const problems = [];
  const sorted = [...cues].sort((x, y) => x.start_ms - y.start_ms);
  sorted.forEach((c, i) => {
    const len = c.text.length;
    const dur = c.end_ms - c.start_ms;
    if (len > rules.max_chars) {
      problems.push({
        type: 'max_chars', word_start: c.word_start, word_end: c.word_end,
        message: `字幕 #${i + 1}${c.locked ? '（已锁定）' : ''} ${len} 字，超过最大字数 ${rules.max_chars}`,
      });
    }
    if (dur < rules.min_duration_ms) {
      problems.push({
        type: 'min_duration', word_start: c.word_start, word_end: c.word_end,
        message: `字幕 #${i + 1}${c.locked ? '（已锁定）' : ''} 显示 ${dur}ms，短于最短时长 ${rules.min_duration_ms}ms`,
      });
    }
    const cps = len / (dur / 1000);
    if (cps > rules.max_cps + 1e-9) {
      problems.push({
        type: 'max_cps', word_start: c.word_start, word_end: c.word_end,
        message: `字幕 #${i + 1}${c.locked ? '（已锁定）' : ''} ${cps.toFixed(1)} 字/秒，超过上限 ${rules.max_cps}`,
      });
    }
  });
  return problems;
}

module.exports = { computeLayout, validateStructure, validateRules, joinWords };
