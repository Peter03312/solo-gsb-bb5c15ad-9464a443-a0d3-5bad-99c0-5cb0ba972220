'use strict';

const { validateStructure, validateRules } = require('./layout');

/**
 * 校对者批量修订提议：请求解析与整组候选核对（纯函数，不依赖数据库）。
 *
 * 一项提议：{ subtitle_id, cue_version, text, start_ms?, end_ms? }
 *   - subtitle_id  目标字幕 ID；cue_version 为校对者读取该行时的版本号
 *   - text         替代文本（必填非空）
 *   - start_ms/end_ms 可选替代起止毫秒；省略表示沿用当前行原值
 *
 * 核对维度（针对整组应用后的候选整版）：
 *   词区间（不得缩短词时段）、词时段合法性、镜头切点、相邻字幕重叠、
 *   字数/时长/字速规则；另核对目标是否仍存在、是否锁定、行版本与规则版本。
 */

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

const MAX_ITEMS = 1000;

/**
 * 解析并校验提交请求的“形状”（与项目当前状态无关的部分）：
 * 空组、重复 ID、字段类型、空文本、非法时间。
 * 返回 { ok, items, errors }，errors 为中文说明（可直接回 400）。
 */
function parseRevisionItems(body) {
  const errors = [];
  const rawItems = body && body.items;
  if (!Array.isArray(rawItems)) {
    return { ok: false, errors: ['请求体必须包含 items 数组'] };
  }
  if (rawItems.length === 0) {
    return { ok: false, errors: ['修订组为空：items 至少包含一项'] };
  }
  if (rawItems.length > MAX_ITEMS) {
    return { ok: false, errors: [`单组修订项 ${rawItems.length} 超过上限 ${MAX_ITEMS}`] };
  }
  const seen = new Set();
  const items = [];
  const pushErr = (msg) => {
    if (errors.length < 20) errors.push(msg);
  };
  rawItems.forEach((raw, i) => {
    const it = raw || {};
    let rowBad = false;
    if (!isInt(it.subtitle_id) || it.subtitle_id <= 0) {
      pushErr(`第 ${i + 1} 项：subtitle_id 必须是正整数`);
      rowBad = true;
    } else if (seen.has(it.subtitle_id)) {
      pushErr(`第 ${i + 1} 项：subtitle_id ${it.subtitle_id} 在同一组内重复`);
      rowBad = true;
    } else {
      seen.add(it.subtitle_id);
    }
    if (!isInt(it.cue_version) || it.cue_version < 1) {
      pushErr(`第 ${i + 1} 项：cue_version（读取时行版本）必须是 ≥1 的整数`);
      rowBad = true;
    }
    if (typeof it.text !== 'string' || it.text.trim() === '') {
      pushErr(`第 ${i + 1} 项：替代文本 text 不能为空`);
      rowBad = true;
    }
    let start = null;
    let end = null;
    if (it.start_ms !== undefined && it.start_ms !== null) {
      if (!isInt(it.start_ms) || it.start_ms < 0) {
        pushErr(`第 ${i + 1} 项：start_ms 必须是非负整数毫秒`);
        rowBad = true;
      } else start = it.start_ms;
    }
    if (it.end_ms !== undefined && it.end_ms !== null) {
      if (!isInt(it.end_ms) || it.end_ms < 0) {
        pushErr(`第 ${i + 1} 项：end_ms 必须是非负整数毫秒`);
        rowBad = true;
      } else end = it.end_ms;
    }
    if (start !== null && end !== null && start >= end) {
      pushErr(`第 ${i + 1} 项：非法时间 [${start}, ${end}]，开始必须早于结束`);
      rowBad = true;
    }
    if (!rowBad) {
      items.push({
        subtitle_id: it.subtitle_id,
        cue_version: it.cue_version,
        text: it.text,
        start_ms: start,
        end_ms: end,
      });
    }
  });
  if (errors.length >= 20 && rawItems.length > errors.length) {
    errors.push('……错误过多，仅显示前 20 条');
  }
  return { ok: errors.length === 0, items, errors };
}

function cueRef(id) {
  return `字幕 #${id}`;
}

/**
 * 单条候选的逐维度核对（时间/词区间/切点/相邻/规则）。
 * prev/next 为“整组应用后”按顺序相邻的候选字幕。
 */
function checkCandidate(cue, prev, next, words, cuts, rules) {
  const out = [];
  const S = cue.start_ms;
  const E = cue.end_ms;
  const text = cue.text;
  let timesValid = true;
  if (!isInt(S) || !isInt(E) || S < 0 || S >= E) {
    timesValid = false;
    out.push({
      type: 'invalid_time', subtitle_id: cue.id,
      message: `${cueRef(cue.id)} 建议时间非法：[${S}, ${E}]，必须是非负整数且开始早于结束`,
    });
  }
  if (timesValid) {
    const first = words[cue.word_start];
    const last = words[cue.word_end];
    if (first && S > first.start_ms) {
      out.push({
        type: 'word_span_shortened', subtitle_id: cue.id,
        message: `${cueRef(cue.id)} 建议开始 ${S}ms 晚于首词 "${first.text}" 的开始 ${first.start_ms}ms，会缩短词本身的时段`,
      });
    }
    if (last && E < last.end_ms) {
      out.push({
        type: 'word_span_shortened', subtitle_id: cue.id,
        message: `${cueRef(cue.id)} 建议结束 ${E}ms 早于末词 "${last.text}" 的结束 ${last.end_ms}ms，会缩短词本身的时段`,
      });
    }
    if (prev && prev.end_ms > S) {
      out.push({
        type: 'overlap', subtitle_id: cue.id,
        message: `${cueRef(cue.id)} 建议时段 [${S}, ${E}] 与前一条字幕 ${cueRef(prev.id)} [${prev.start_ms}, ${prev.end_ms}] 重叠`,
      });
    }
    if (next && next.start_ms < E) {
      out.push({
        type: 'overlap', subtitle_id: cue.id,
        message: `${cueRef(cue.id)} 建议时段 [${S}, ${E}] 与后一条字幕 ${cueRef(next.id)} [${next.start_ms}, ${next.end_ms}] 重叠`,
      });
    }
    for (const c of cuts) {
      if (S < c && c < E) {
        out.push({
          type: 'cut_crossed', subtitle_id: cue.id,
          message: `${cueRef(cue.id)} 建议时段 [${S}, ${E}] 跨过镜头切点 ${c}ms`,
        });
      }
    }
  }
  // 规则：字数 / 时长 / 字速
  const len = text.length;
  if (len > rules.max_chars) {
    out.push({
      type: 'max_chars', subtitle_id: cue.id,
      message: `${cueRef(cue.id)} 建议文本 ${len} 字，超过单条最大字数 ${rules.max_chars}`,
    });
  }
  if (timesValid) {
    const dur = E - S;
    if (dur < rules.min_duration_ms) {
      out.push({
        type: 'min_duration', subtitle_id: cue.id,
        message: `${cueRef(cue.id)} 建议显示 ${dur}ms，短于最短显示时长 ${rules.min_duration_ms}ms`,
      });
    }
    const cps = len / (dur / 1000);
    if (cps > rules.max_cps + 1e-9) {
      out.push({
        type: 'max_cps', subtitle_id: cue.id,
        message: `${cueRef(cue.id)} 建议内容 ${cps.toFixed(1)} 字/秒，超过每秒最多 ${rules.max_cps} 字`,
      });
    }
  }
  return out;
}

/**
 * 整组核对。输入当前项目完整载荷与 loadRevision() 得到的提议。
 * 仅对 status='pending' 的提议有意义（已采纳由路由直接拒绝重复提交）。
 *
 * 返回：
 *   ok                     是否可整组采纳
 *   rule_version_stale     提议保存时规则版本是否已过期
 *   items[]                每项并列原值/当前值/建议值、state 与 conflicts
 *   conflicts[]            无法归到具体项的整版级冲突
 */
function evaluateRevision({ project, revision }) {
  const { words, cuts, rules, subtitles } = project;
  const cueById = new Map(subtitles.map((s) => [s.id, s]));
  const rangeToId = new Map(subtitles.map((s) => [`${s.word_start}:${s.word_end}`, s.id]));

  const ruleStale = revision.rules_version_snapshot !== rules.version;

  // 组内重复目标（历史数据防御；提交时已拒绝）
  const targetByCue = new Map();
  for (const it of revision.items) {
    if (!targetByCue.has(it.subtitle_id)) targetByCue.set(it.subtitle_id, it);
  }

  // 1. 构造“整组应用后”的候选整版：建议落到未锁定目标，其余行保持当前值
  const effective = subtitles.map((cue) => {
    const it = targetByCue.get(cue.id);
    if (!it || cue.locked === 1) return { ...cue, item: null };
    return {
      ...cue,
      text: it.proposed.text,
      start_ms: it.proposed.has_start_ms ? it.proposed.start_ms : cue.start_ms,
      end_ms: it.proposed.has_end_ms ? it.proposed.end_ms : cue.end_ms,
      item: it,
    };
  });
  const effIndexById = new Map(effective.map((c, i) => [c.id, i]));

  const itemResults = [];
  for (const it of revision.items) {
    const cue = cueById.get(it.subtitle_id) || null;
    const entry = {
      ord: it.ord,
      subtitle_id: it.subtitle_id,
      cue_version: it.cue_version,
      orig: it.orig,
      proposed: it.proposed,
      cue,
      state: 'ok',
      conflicts: [],
    };
    if (ruleStale && cue) {
      entry.conflicts.push({
        type: 'rules_version_stale', subtitle_id: cue.id,
        message: `${cueRef(cue.id)} 基于规则 v${revision.rules_version_snapshot} 提议，当前规则已是 v${rules.version}，请按当前规则重新核对`,
      });
    }
    if (!cue) {
      entry.state = 'missing';
      entry.proposed = {
        text: it.proposed.text,
        start_ms: it.proposed.has_start_ms ? it.proposed.start_ms : null,
        end_ms: it.proposed.has_end_ms ? it.proposed.end_ms : null,
        has_start_ms: it.proposed.has_start_ms,
        has_end_ms: it.proposed.has_end_ms,
      };
      entry.conflicts.push({
        type: 'subtitle_missing', subtitle_id: it.subtitle_id,
        message: `字幕 ${it.subtitle_id} 已不存在（提议提交后可能被重新排版或重新导入），无法应用`,
      });
      itemResults.push(entry);
      continue;
    }
    if (cue.locked === 1) {
      entry.state = 'locked';
      entry.conflicts.push({
        type: 'subtitle_locked', subtitle_id: cue.id,
        message: `字幕 ${it.subtitle_id} 当前已锁定，不能通过修订提议修改，请先解锁或撤回该项`,
      });
    } else if (it.cue_version !== cue.version) {
      entry.state = 'stale';
      entry.conflicts.push({
        type: 'cue_version_stale', subtitle_id: cue.id,
        message: `字幕 ${it.subtitle_id} 行版本过期：提议基于 v${it.cue_version} 读取，当前已是 v${cue.version}`,
      });
    }
    // 预览并列值：建议省略的时间用当前行值补全展示
    const eff = effective[effIndexById.get(cue.id)];
    entry.proposed = {
      text: it.proposed.text,
      start_ms: eff.start_ms,
      end_ms: eff.end_ms,
      has_start_ms: it.proposed.has_start_ms,
      has_end_ms: it.proposed.has_end_ms,
    };
    // 目标存在且未锁定时，按候选整版核对该项（过期也照算，便于预览中看到全部问题）
    if (cue.locked !== 1) {
      const idx = effIndexById.get(cue.id);
      const prev = idx > 0 ? effective[idx - 1] : null;
      const next = idx >= 0 && idx + 1 < effective.length ? effective[idx + 1] : null;
      entry.conflicts.push(...checkCandidate(eff, prev, next, words, cuts, rules));
    }
    itemResults.push(entry);
  }

  // 2. 整版兜底：结构（覆盖/重叠/切点/词时段）+ 当前规则全量校验
  const conflictsByItem = new Map(itemResults.map((r) => [r.subtitle_id, r.conflicts]));
  const groupConflicts = [];
  const hasConflict = (sid, type) =>
    conflictsByItem.has(sid) && conflictsByItem.get(sid).some((c) => c.type === type);
  const attribute = (problem) => {
    const sid = rangeToId.get(`${problem.word_start}:${problem.word_end}`);
    const cue = sid === undefined ? null : cueById.get(sid);
    const isTarget = cue !== null && cue.locked !== 1 && targetByCue.has(sid);
    if (isTarget && !hasConflict(sid, problem.type)) {
      conflictsByItem.get(sid).push({ ...problem, subtitle_id: sid });
    } else if (!isTarget) {
      groupConflicts.push(problem);
    }
    // 命中目标且逐项核对已报同类冲突 → 去重，不再重复列入
  };
  validateStructure(effective, words, cuts).forEach(attribute);
  validateRules(effective, rules).forEach(attribute);

  const anyItemBlocking = itemResults.some((r) => r.state !== 'ok' || r.conflicts.length > 0);
  return {
    ok: !ruleStale && !anyItemBlocking && groupConflicts.length === 0,
    rule_version_stale: ruleStale,
    items: itemResults,
    conflicts: groupConflicts,
  };
}

module.exports = { parseRevisionItems, evaluateRevision, MAX_ITEMS, isInt };
