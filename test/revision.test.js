'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/routes');

let server;
let base;

before(async () => {
  const db = initDb(':memory:');
  const app = createApp(db);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function api(path, method = 'GET', body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

const GOOD_WORDS = [
  { text: '你好', start_ms: 0, end_ms: 500 },
  { text: '世界', start_ms: 550, end_ms: 1000 },
  { text: '欢迎', start_ms: 1500, end_ms: 2000 },
  { text: '光临', start_ms: 2050, end_ms: 2500 },
];

async function setupProject(rules) {
  const { status, body } = await api('/api/projects', 'POST', {
    name: '修订测试', words: GOOD_WORDS, cuts: [1200], rules,
  });
  assert.equal(status, 201, JSON.stringify(body));
  const layout = await api(`/api/projects/${body.id}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  return { project: body, cues: layout.body.subtitles };
}

// ---------- 提交：形状校验 ----------

test('提交：空组、重复 ID、空文本、非法时间 → 400', async () => {
  const { project: p, cues } = await setupProject();

  const empty = await api(`/api/projects/${p.id}/revisions`, 'POST', { items: [] });
  assert.equal(empty.status, 400);
  assert.match(empty.body.errors[0], /空/);

  const noItems = await api(`/api/projects/${p.id}/revisions`, 'POST', {});
  assert.equal(noItems.status, 400);

  const dup = await api(`/api/projects/${p.id}/revisions`, 'POST', { items: [
    { subtitle_id: cues[0].id, cue_version: 1, text: '甲' },
    { subtitle_id: cues[0].id, cue_version: 1, text: '乙' },
  ] });
  assert.equal(dup.status, 400);
  assert.ok(dup.body.errors.some((e) => e.includes('重复')));

  const blankText = await api(`/api/projects/${p.id}/revisions`, 'POST', {
    items: [{ subtitle_id: cues[0].id, cue_version: 1, text: '   ' }],
  });
  assert.equal(blankText.status, 400);

  const badRange = await api(`/api/projects/${p.id}/revisions`, 'POST', {
    items: [{ subtitle_id: cues[0].id, cue_version: 1, text: '甲', start_ms: 900, end_ms: 800 }],
  });
  assert.equal(badRange.status, 400);
  assert.ok(badRange.body.errors.some((e) => e.includes('非法时间')));

  const negative = await api(`/api/projects/${p.id}/revisions`, 'POST', {
    items: [{ subtitle_id: cues[0].id, cue_version: 1, text: '甲', start_ms: -1 }],
  });
  assert.equal(negative.status, 400);

  const badVersion = await api(`/api/projects/${p.id}/revisions`, 'POST', {
    items: [{ subtitle_id: cues[0].id, cue_version: 0, text: '甲' }],
  });
  assert.equal(badVersion.status, 400);
});

test('提交：目标不存在或已锁定 → 422，不保存提议', async () => {
  const { project: p, cues } = await setupProject();

  const missing = await api(`/api/projects/${p.id}/revisions`, 'POST', {
    items: [{ subtitle_id: 999999, cue_version: 1, text: '甲' }],
  });
  assert.equal(missing.status, 422);

  await api(`/api/projects/${p.id}/subtitles/${cues[0].id}`, 'PATCH', {
    version: cues[0].version, locked: true,
  });
  const locked = await api(`/api/projects/${p.id}/revisions`, 'POST', {
    items: [{ subtitle_id: cues[0].id, cue_version: cues[0].version + 1, text: '甲' }],
  });
  assert.equal(locked.status, 422);
  assert.ok(locked.body.errors[0].includes('锁定'));

  const list = await api(`/api/projects/${p.id}/revisions`);
  assert.equal(list.body.length, 0, '被拒绝的请求不得产生提议历史');
});

test('提交：保存原值与规则版本快照，且不动正式字幕', async () => {
  const { project: p, cues } = await setupProject();
  const before = await api(`/api/projects/${p.id}`);

  const r = await api(`/api/projects/${p.id}/revisions`, 'POST', {
    note: '第一轮校对',
    items: [
      { subtitle_id: cues[0].id, cue_version: cues[0].version, text: '你好呀世界', end_ms: 1100 },
      { subtitle_id: cues[1].id, cue_version: cues[1].version, text: '欢迎光临呀' },
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.note, '第一轮校对');
  assert.equal(r.body.status, 'pending');
  assert.equal(r.body.rules_version_snapshot, p.rules.version);
  assert.equal(r.body.sub_version_snapshot, before.body.sub_version);

  const item0 = r.body.items.find((i) => i.subtitle_id === cues[0].id);
  assert.deepEqual(item0.orig, { text: '你好世界', start_ms: 0, end_ms: 1000 });
  assert.equal(item0.proposed.start_ms, null, '省略的 start_ms 存为 null（沿用原值）');
  assert.equal(item0.proposed.end_ms, 1100);
  assert.equal(item0.proposed.has_start_ms, false);

  const after = await api(`/api/projects/${p.id}`);
  assert.equal(after.body.sub_version, before.body.sub_version, '提交不得推进字幕集版本');
  assert.deepEqual(after.body.subtitles, before.body.subtitles, '提交不得改动正式字幕');
});

// ---------- 预览 ----------

test('预览：干净提议并列原值/当前值/建议值，ok=true', async () => {
  const { project: p, cues } = await setupProject();
  const r = await api(`/api/projects/${p.id}/revisions`, 'POST', {
    items: [{ subtitle_id: cues[1].id, cue_version: cues[1].version, text: '欢迎光临呀' }],
  });
  const pv = await api(`/api/projects/${p.id}/revisions/${r.body.id}/preview`, 'POST', {});
  assert.equal(pv.status, 200);
  assert.equal(pv.body.evaluation.ok, true);
  const it = pv.body.evaluation.items[0];
  assert.equal(it.state, 'ok');
  assert.equal(it.orig.text, '欢迎光临');
  assert.equal(it.cue.text, '欢迎光临');
  assert.equal(it.proposed.text, '欢迎光临呀');
  assert.equal(it.proposed.start_ms, 1500, '省略的建议时间按当前行补全展示');
});

test('预览：整组候选间相邻重叠 / 跨切点 / 缩短词时段 → 逐处冲突', async () => {
  const { project: p, cues } = await setupProject();
  // cue0 结束从 1000 延到 1600：跨切点 1200、与 cue1（1500 开始）重叠；
  // cue1 也会报与前一条重叠
  const r = await api(`/api/projects/${p.id}/revisions`, 'POST', {
    items: [
      { subtitle_id: cues[0].id, cue_version: 1, text: '你好世界呀', end_ms: 1600 },
      { subtitle_id: cues[1].id, cue_version: 1, text: '欢迎光临呀' },
    ],
  });
  const pv = await api(`/api/projects/${p.id}/revisions/${r.body.id}/preview`, 'POST', {});
  assert.equal(pv.body.evaluation.ok, false);
  const types = pv.body.evaluation.items.map((i) => i.conflicts.map((c) => c.type));
  assert.ok(types[0].includes('cut_crossed'));
  assert.ok(types[0].includes('overlap'));
  assert.ok(types[1].includes('overlap'));

  // 开始晚于首词开始 → 缩短词时段
  const r2 = await api(`/api/projects/${p.id}/revisions`, 'POST', {
    items: [{ subtitle_id: cues[0].id, cue_version: 1, text: '你好世界', start_ms: 100 }],
  });
  const pv2 = await api(`/api/projects/${p.id}/revisions/${r2.body.id}/preview`, 'POST', {});
  assert.ok(pv2.body.evaluation.items[0].conflicts.some((c) => c.type === 'word_span_shortened'));
});

test('预览：字数 / 时长 / 字速规则逐处标注', async () => {
  const { project: strict, cues: strictCues } = await setupProject(
    { max_chars: 5, min_duration_ms: 800, max_cps: 20 }
  );
  // 6 字超 max_chars；cue1 词时段 1000ms，6 字 = 6 字/秒，时长 1000ms，仅超字数
  const r = await api(`/api/projects/${strict.id}/revisions`, 'POST', {
    items: [{ subtitle_id: strictCues[1].id, cue_version: 1, text: '一二三四五六' }],
  });
  const pv = await api(`/api/projects/${strict.id}/revisions/${r.body.id}/preview`, 'POST', {});
  assert.deepEqual(pv.body.evaluation.items[0].conflicts.map((c) => c.type), ['max_chars']);

  // 21 字 / 1000ms = 21 字/秒 > 20 → max_cps（字数 21 ≤ 30，时长 1000 ≥ 800）
  const { project: cpsP, cues: cpsCues } = await setupProject();
  const r2 = await api(`/api/projects/${cpsP.id}/revisions`, 'POST', {
    items: [{ subtitle_id: cpsCues[1].id, cue_version: 1, text: '一二三四五六七八九十一二三四五六七八九十壹' }],
  });
  const pv2 = await api(`/api/projects/${cpsP.id}/revisions/${r2.body.id}/preview`, 'POST', {});
  assert.ok(pv2.body.evaluation.items[0].conflicts.some((c) => c.type === 'max_cps'));

  // 规则要求最短 1200ms：建议结束取末词结束 2500（不缩短词时段），显示仅 1000ms → min_duration
  const { project: durP, cues: durCues } = await setupProject(
    { max_chars: 30, min_duration_ms: 1200, max_cps: 20 }
  );
  // 排版为满足最短时长会把 cue1 向后扩展；显式提议回 2500ms 应被判时长不足
  const r3 = await api(`/api/projects/${durP.id}/revisions`, 'POST', {
    items: [{ subtitle_id: durCues[1].id, cue_version: 1, text: '欢迎光临', start_ms: 1500, end_ms: 2500 }],
  });
  const pv3 = await api(`/api/projects/${durP.id}/revisions/${r3.body.id}/preview`, 'POST', {});
  assert.ok(pv3.body.evaluation.items[0].conflicts.some((c) => c.type === 'min_duration'),
    JSON.stringify(pv3.body.evaluation.items[0].conflicts));
});

test('预览：行版本过期 / 规则版本过期 / 目标已锁定 / 目标已消失', async () => {
  const { project: p, cues } = await setupProject();

  // 行版本过期：先用单条编辑推进版本
  await api(`/api/projects/${p.id}/subtitles/${cues[1].id}`, 'PATCH', {
    version: 1, text: '手工改过',
  });
  const stale = await api(`/api/projects/${p.id}/revisions`, 'POST', {
    items: [{ subtitle_id: cues[1].id, cue_version: 1, text: '基于旧版本' }],
  });
  const pvStale = await api(`/api/projects/${p.id}/revisions/${stale.body.id}/preview`, 'POST', {});
  assert.equal(pvStale.body.evaluation.items[0].state, 'stale');
  assert.ok(pvStale.body.evaluation.items[0].conflicts.some((c) => c.type === 'cue_version_stale'));
  assert.equal(pvStale.body.evaluation.items[0].cue.text, '手工改过', '预览返回当前值');

  // 规则版本过期
  const ruleStale = await api(`/api/projects/${p.id}/revisions`, 'POST', {
    items: [{ subtitle_id: cues[0].id, cue_version: 1, text: '你好世界' }],
  });
  await api(`/api/projects/${p.id}/rules`, 'PUT', {
    version: 1, max_chars: 30, min_duration_ms: 800, max_cps: 20,
  });
  const pvRule = await api(`/api/projects/${p.id}/revisions/${ruleStale.body.id}/preview`, 'POST', {});
  assert.equal(pvRule.body.evaluation.rule_version_stale, true);
  assert.ok(pvRule.body.evaluation.items[0].conflicts.some((c) => c.type === 'rules_version_stale'));

  // 提交后锁定
  const locked = await api(`/api/projects/${p.id}/revisions`, 'POST', {
    items: [{ subtitle_id: cues[0].id, cue_version: 1, text: '你好世界' }],
  });
  await api(`/api/projects/${p.id}/subtitles/${cues[0].id}`, 'PATCH', { version: 1, locked: true });
  const pvLocked = await api(`/api/projects/${p.id}/revisions/${locked.body.id}/preview`, 'POST', {});
  assert.equal(pvLocked.body.evaluation.items[0].state, 'locked');

  // 目标在重排后消失（未锁定行被删除重建）
  const gone = await api(`/api/projects/${p.id}/revisions`, 'POST', {
    items: [{ subtitle_id: cues[1].id, cue_version: 2, text: '将消失' }],
  });
  await api(`/api/projects/${p.id}/subtitles/${cues[0].id}`, 'PATCH', { version: 2, locked: false });
  await api(`/api/projects/${p.id}/rules`, 'PUT', {
    version: 2, max_chars: 2, min_duration_ms: 500, max_cps: 20,
  });
  const cur = await api(`/api/projects/${p.id}`);
  await api(`/api/projects/${p.id}/layout`, 'POST', { sub_version: cur.body.sub_version });
  const pvGone = await api(`/api/projects/${p.id}/revisions/${gone.body.id}/preview`, 'POST', {});
  assert.equal(pvGone.body.evaluation.items[0].state, 'missing');
});

// ---------- 采纳 ----------

test('采纳：整组写入、推进行版本与字幕集版本，并标记已采纳', async () => {
  const { project: p, cues } = await setupProject();
  const r = await api(`/api/projects/${p.id}/revisions`, 'POST', {
    items: [
      { subtitle_id: cues[0].id, cue_version: 1, text: '你好呀世界' },
      { subtitle_id: cues[1].id, cue_version: 1, text: '欢迎呀光临' },
    ],
  });
  const acc = await api(`/api/projects/${p.id}/revisions/${r.body.id}/accept`, 'POST', {});
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  assert.equal(acc.body.status, 'accepted');
  assert.equal(acc.body.applied, 2);
  assert.ok(acc.body.sub_version > 0);
  assert.deepEqual(acc.body.subtitles.map((s) => s.text).sort(), ['你好呀世界', '欢迎呀光临']);
  assert.ok(acc.body.subtitles.every((s) => s.version === 2), '行版本应各 +1');

  const fresh = await api(`/api/projects/${p.id}`);
  assert.equal(fresh.body.sub_version, acc.body.sub_version);
  const head = await api(`/api/projects/${p.id}/revisions/${r.body.id}`);
  assert.equal(head.body.status, 'accepted');
  assert.equal(head.body.accepted_sub_version, acc.body.sub_version);
});

test('采纳：任一项过期或违规 → 409/422 且整组不生效，返回当前值与原因', async () => {
  const { project: p, cues } = await setupProject();

  // 一组中一项行版本过期，一项合法 → 409，整组不写入
  await api(`/api/projects/${p.id}/subtitles/${cues[0].id}`, 'PATCH', { version: 1, text: '当前文本' });
  const r = await api(`/api/projects/${p.id}/revisions`, 'POST', {
    items: [
      { subtitle_id: cues[0].id, cue_version: 1, text: '基于旧版本' },
      { subtitle_id: cues[1].id, cue_version: 1, text: '合法的新文本' },
    ],
  });
  const rejected = await api(`/api/projects/${p.id}/revisions/${r.body.id}/accept`, 'POST', {});
  assert.equal(rejected.status, 409);
  assert.ok(rejected.body.items.some((i) => i.reasons.some((x) => x.type === 'cue_version_stale')));
  const bad = rejected.body.items.find((i) => i.subtitle_id === cues[0].id);
  assert.equal(bad.current.text, '当前文本', '409 须带回当前值');
  assert.ok(rejected.body.current.subtitles.length >= 2, '409 须带回当前整版');

  const fresh = await api(`/api/projects/${p.id}`);
  const c0 = fresh.body.subtitles.find((s) => s.id === cues[0].id);
  const c1 = fresh.body.subtitles.find((s) => s.id === cues[1].id);
  assert.equal(c0.text, '当前文本');
  assert.equal(c1.text, '欢迎光临', '合法项也不得生效（整组原子）');
  assert.equal(fresh.body.sub_version, rejected.body.current.sub_version);

  // 规则违规 → 422 整组不生效
  const r2 = await api(`/api/projects/${p.id}/revisions`, 'POST', {
    items: [{ subtitle_id: cues[1].id, cue_version: c1.version, text: '欢迎光临', start_ms: 1100 }],
  });
  const rejected2 = await api(`/api/projects/${p.id}/revisions/${r2.body.id}/accept`, 'POST', {});
  assert.equal(rejected2.status, 422);
  assert.ok(rejected2.body.items[0].reasons.some((x) => x.type === 'cut_crossed'));
  const fresh2 = await api(`/api/projects/${p.id}`);
  assert.equal(fresh2.body.subtitles.find((s) => s.id === cues[1].id).start_ms, 1500);
});

test('采纳：规则版本过期 → 409 整组不生效', async () => {
  const { project: p, cues } = await setupProject();
  const r = await api(`/api/projects/${p.id}/revisions`, 'POST', {
    items: [{ subtitle_id: cues[0].id, cue_version: 1, text: '你好世界' }],
  });
  await api(`/api/projects/${p.id}/rules`, 'PUT', {
    version: 1, max_chars: 30, min_duration_ms: 800, max_cps: 20,
  });
  const acc = await api(`/api/projects/${p.id}/revisions/${r.body.id}/accept`, 'POST', {});
  assert.equal(acc.status, 409);
  assert.equal(acc.body.rules_version, 2);
  const unchanged = await api(`/api/projects/${p.id}`);
  assert.equal(unchanged.body.subtitles.find((s) => s.id === cues[0].id).text, '你好世界');
});

test('已采纳提议重复提交不得再改字幕；历史可查', async () => {
  const { project: p, cues } = await setupProject();
  const r = await api(`/api/projects/${p.id}/revisions`, 'POST', {
    items: [{ subtitle_id: cues[0].id, cue_version: 1, text: '第一次采纳的文本' }],
  });
  const acc = await api(`/api/projects/${p.id}/revisions/${r.body.id}/accept`, 'POST', {});
  assert.equal(acc.status, 200);
  const subvAfterFirst = acc.body.sub_version;

  // 即使行版本已推进，重复 accept 也必须原样拒绝
  const again = await api(`/api/projects/${p.id}/revisions/${r.body.id}/accept`, 'POST', {});
  assert.equal(again.status, 409);
  assert.equal(again.body.already_accepted, true);
  const fresh = await api(`/api/projects/${p.id}`);
  assert.equal(fresh.body.sub_version, subvAfterFirst, '重复采纳不得再推进版本');
  assert.equal(fresh.body.subtitles.find((s) => s.id === cues[0].id).text, '第一次采纳的文本');

  const list = await api(`/api/projects/${p.id}/revisions`);
  assert.equal(list.body[0].status, 'accepted');
  assert.equal(list.body[0].item_count, 1);
  assert.equal(list.body[0].accepted_sub_version, subvAfterFirst);
});

test('采纳后旧导出快照保持不变', async () => {
  const { project: p, cues } = await setupProject();
  const e1 = await api(`/api/projects/${p.id}/exports`, 'POST', {});
  assert.equal(e1.status, 201);

  const r = await api(`/api/projects/${p.id}/revisions`, 'POST', {
    items: [{ subtitle_id: cues[0].id, cue_version: 1, text: '采纳后新文本' }],
  });
  await api(`/api/projects/${p.id}/revisions/${r.body.id}/accept`, 'POST', {});

  const dl1 = await api(`/api/projects/${p.id}/exports/1`);
  assert.equal(dl1.body, e1.body.content, '旧导出快照不受采纳影响');
  assert.ok(!dl1.body.includes('采纳后新文本'));
});

test('兼容：提议流程不影响单条编辑 / 锁定 / 导出 / 重排', async () => {
  const { project: p, cues } = await setupProject();
  // 待采纳提议存在时，单条编辑照常
  await api(`/api/projects/${p.id}/revisions`, 'POST', {
    items: [{ subtitle_id: cues[0].id, cue_version: 1, text: '待采纳文本' }],
  });
  const edit = await api(`/api/projects/${p.id}/subtitles/${cues[0].id}`, 'PATCH', {
    version: 1, text: '单条编辑文本',
  });
  assert.equal(edit.status, 200);

  const lock = await api(`/api/projects/${p.id}/subtitles/${cues[1].id}`, 'PATCH', {
    version: 1, locked: true,
  });
  assert.equal(lock.status, 200);

  const relayout = await api(`/api/projects/${p.id}/layout`, 'POST', { sub_version: lock.body.sub_version });
  assert.equal(relayout.status, 200);
  const kept = relayout.body.subtitles.find((s) => s.id === cues[1].id);
  assert.equal(kept.locked, 1, '锁定行仍原样保留');

  const ex = await api(`/api/projects/${p.id}/exports`, 'POST', {});
  assert.equal(ex.status, 201);
});
