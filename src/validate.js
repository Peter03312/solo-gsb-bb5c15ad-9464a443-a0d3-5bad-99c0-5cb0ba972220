'use strict';

/**
 * 导入与编辑校验。所有函数返回 { ok, errors } 或抛不出错地给出具体错误列表，
 * 错误信息包含出问题的下标/数值，便于前端直接展示。
 */

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

/**
 * 校验逐词转写：
 *  - 非空数组；每词 text 为非空字符串，start_ms/end_ms 为整数且 0 <= start < end；
 *  - 词序列按时间排列且互不重叠：word[i].start_ms >= word[i-1].end_ms。
 *    （倒序或重叠的词段会让"字幕不重叠"无法满足，直接拒绝导入。）
 */
function validateWords(words) {
  const errors = [];
  if (!Array.isArray(words) || words.length === 0) {
    return { ok: false, errors: ['words 必须是非空数组'] };
  }
  if (words.length > 200000) {
    return { ok: false, errors: [`词数量 ${words.length} 超过上限 200000`] };
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i] || {};
    if (typeof w.text !== 'string' || w.text.trim() === '') {
      errors.push(`第 ${i} 个词缺少文本（text 必须是非空字符串）`);
      continue;
    }
    if (!isInt(w.start_ms) || !isInt(w.end_ms)) {
      errors.push(`第 ${i} 个词 "${w.text}" 的时间必须是整数毫秒`);
      continue;
    }
    if (w.start_ms < 0) {
      errors.push(`第 ${i} 个词 "${w.text}" 开始时间为负：${w.start_ms}ms`);
    }
    if (w.start_ms >= w.end_ms) {
      errors.push(`第 ${i} 个词 "${w.text}" 时间无效：[${w.start_ms}, ${w.end_ms}]，开始必须早于结束`);
    }
    if (i > 0) {
      const prev = words[i - 1];
      if (isInt(prev.start_ms) && isInt(prev.end_ms) && w.start_ms < prev.end_ms) {
        errors.push(
          `第 ${i} 个词 "${w.text}" [${w.start_ms}, ${w.end_ms}] 与前一个词 "${prev.text}" ` +
          `[${prev.start_ms}, ${prev.end_ms}] 倒序或重叠，拒绝导入`
        );
      }
    }
    if (errors.length >= 20) {
      errors.push('……错误过多，仅显示前 20 条');
      break;
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 校验镜头切点：数组、非负整数；自动升序排序并去重后返回。
 */
function validateCuts(cuts) {
  const errors = [];
  if (cuts === undefined || cuts === null) return { ok: true, errors, cuts: [] };
  if (!Array.isArray(cuts)) return { ok: false, errors: ['cuts 必须是数组（毫秒时间戳）'] };
  const clean = [];
  for (let i = 0; i < cuts.length; i++) {
    const c = cuts[i];
    if (!isInt(c) || c < 0) {
      errors.push(`切点 #${i} 无效：${JSON.stringify(c)}，必须是非负整数毫秒`);
    } else {
      clean.push(c);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const sorted = [...new Set(clean)].sort((a, b) => a - b);
  return { ok: true, errors, cuts: sorted };
}

/**
 * 校验排版规则。
 */
function validateRules(rules) {
  const errors = [];
  const r = rules || {};
  if (!isInt(r.max_chars) || r.max_chars < 1 || r.max_chars > 500) {
    errors.push('max_chars（单条最大字数）必须是 1..500 的整数');
  }
  if (!isInt(r.min_duration_ms) || r.min_duration_ms < 0 || r.min_duration_ms > 60000) {
    errors.push('min_duration_ms（最短显示时长）必须是 0..60000 的整数毫秒');
  }
  if (typeof r.max_cps !== 'number' || !(r.max_cps > 0) || r.max_cps > 200) {
    errors.push('max_cps（每秒最多字数）必须是 0..200 之间的数');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 校验单条字幕的手工编辑（文本/时间）。
 *  - start < end，非负整数；
 *  - 不得缩短词本身时段：cue 必须完整包含 [首词.start, 末词.end]；
 *  - 不与相邻字幕重叠；不跨镜头切点。
 * neighbors: { prev, next } 按时间相邻的字幕（可为 null）。
 */
function validateSubtitleEdit({ start_ms, end_ms }, wordRange, words, cuts, neighbors) {
  const errors = [];
  if (!isInt(start_ms) || !isInt(end_ms) || start_ms < 0 || start_ms >= end_ms) {
    errors.push(`时间无效：[${start_ms}, ${end_ms}]，必须是非负整数且开始早于结束`);
    return errors; // 时间本身无效时后续检查无意义
  }
  const first = words[wordRange.word_start];
  const last = words[wordRange.word_end];
  if (first && start_ms > first.start_ms) {
    errors.push(`开始时间 ${start_ms}ms 晚于首词 "${first.text}" 的开始 ${first.start_ms}ms，会缩短词本身的时段`);
  }
  if (last && end_ms < last.end_ms) {
    errors.push(`结束时间 ${end_ms}ms 早于末词 "${last.text}" 的结束 ${last.end_ms}ms，会缩短词本身的时段`);
  }
  if (neighbors.prev && neighbors.prev.end_ms > start_ms) {
    errors.push(`与前一条字幕 [${neighbors.prev.start_ms}, ${neighbors.prev.end_ms}] 重叠`);
  }
  if (neighbors.next && neighbors.next.start_ms < end_ms) {
    errors.push(`与后一条字幕 [${neighbors.next.start_ms}, ${neighbors.next.end_ms}] 重叠`);
  }
  for (const c of cuts) {
    if (start_ms < c && c < end_ms) {
      errors.push(`时段 [${start_ms}, ${end_ms}] 跨过镜头切点 ${c}ms`);
    }
  }
  return errors;
}

module.exports = { validateWords, validateCuts, validateRules, validateSubtitleEdit };
