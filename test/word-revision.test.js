'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/routes');

let server;
let base;
let seq = 0;

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
  { text: '再见', start_ms: 3000, end_ms: 3400 },
  { text: '朋友', start_ms: 3450, end_ms: 3900 },
];
const CUTS = [1200, 2800];

async function setupProject() {
  const { status, body } = await api('/api/projects', 'POST', {
    name: `词修正测试 ${seq++}`, words: GOOD_WORDS, cuts: CUTS,
  });
  assert.equal(status, 201, JSON.stringify(body));
  const pid = body.id;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  return pid;
}

/** 按词区间取当前项目字幕行：cueAt(pid, 0,1) 等 */
async function cueAt(pid, wordStart) {
  const p = await api(`/api/projects/${pid}`);
  return p.body.subtitles.find((s) => s.word_start === wordStart);
}

async function submit(pid, payload) {
  return api(`/api/projects/${pid}/word-revisions`, 'POST', payload);
}
async function preview(pid, wrid) {
  return api(`/api/projects/${pid}/word-revisions/${wrid}/preview`, 'POST', {});
}
async function confirm(pid, wrid) {
  return api(`/api/projects/${pid}/word-revisions/${wrid}/confirm`, 'POST', {});
}

// ---------- 提交：形状校验 ----------

test('提交：空组/缺 sub_version/重复序号/非法时间/负值 → 400', async () => {
  const pid = await setupProject();

  const noVer = await submit(pid, { items: [{ word_idx: 0, start_ms: 0, end_ms: 10 }] });
  assert.equal(noVer.status, 400);
  assert.match(noVer.body.errors[0], /sub_version/);

  const empty = await submit(pid, { sub_version: 1, items: [] });
  assert.equal(empty.status, 400);
  assert.match(empty.body.errors[0], /空/);

  const dup = await submit(pid, { sub_version: 1, items: [
    { word_idx: 1, start_ms: 0, end_ms: 10 },
    { word_idx: 1, start_ms: 20, end_ms: 30 },
  ] });
  assert.equal(dup.status, 400);
  assert.ok(dup.body.errors.some((e) => e.includes('重复')));

  const badTime = await submit(pid, { sub_version: 1, items: [
    { word_idx: 1, start_ms: 500, end_ms: 500 },
  ] });
  assert.equal(badTime.status, 400);
  assert.ok(badTime.body.errors.some((e) => e.includes('开始必须早于结束')));

  const negative = await submit(pid, { sub_version: 1, items: [
    { word_idx: 1, start_ms: -1, end_ms: 10 },
  ] });
  assert.equal(negative.status, 400);

  const nonInt = await submit(pid, { sub_version: 1, items: [
    { word_idx: 1.5, start_ms: 0, end_ms: 10 },
  ] });
  assert.equal(nonInt.status, 400);

  const list = await api(`/api/projects/${pid}/word-revisions`);
  assert.equal(list.body.length, 0, '被 400 拒绝的请求不得产生提议');
});

test('提交：sub_version 过期 → 409 并返回当前值', async () => {
  const pid = await setupProject();
  const r = await submit(pid, { sub_version: 0, items: [{ word_idx: 0, start_ms: 0, end_ms: 400 }] });
  assert.equal(r.status, 409);
  assert.equal(r.body.current.sub_version, 1);
  assert.ok(r.body.current.words.length === 6);
});

test('提交：词序号越界 / 应用后与邻词重叠倒序 → 422 且不保存', async () => {
  const pid = await setupProject();
  const outOfRange = await submit(pid, { sub_version: 1, items: [{ word_idx: 99, start_ms: 0, end_ms: 10 }] });
  assert.equal(outOfRange.status, 422);
  assert.match(outOfRange.body.errors[0], /超出范围/);

  // 词2提前到 900 开始，早于词1结束 1000 → 修正后词序重叠
  const overlap = await submit(pid, { sub_version: 1, items: [{ word_idx: 2, start_ms: 900, end_ms: 1400 }] });
  assert.equal(overlap.status, 422);
  assert.match(overlap.body.errors[0], /按序且互不重叠/);

  const list = await api(`/api/projects/${pid}/word-revisions`);
  assert.equal(list.body.length, 0);
});

test('提交：保存原词时间快照，不动正式词与字幕、不推进版本', async () => {
  const pid = await setupProject();
  const before = await api(`/api/projects/${pid}`);
  const r = await submit(pid, {
    note: '第二段提前', sub_version: 1,
    items: [
      { word_idx: 2, start_ms: 1400, end_ms: 1900 },
      { word_idx: 3, start_ms: 1950, end_ms: 2400 },
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'pending');
  assert.equal(r.body.sub_version_snapshot, 1);
  const it0 = r.body.items.find((x) => x.word_idx === 2);
  assert.deepEqual(it0.orig, { start_ms: 1500, end_ms: 2000 });
  assert.deepEqual(it0.proposed, { start_ms: 1400, end_ms: 1900 });
  assert.equal(it0.word_text, '欢迎');

  const after = await api(`/api/projects/${pid}`);
  assert.equal(after.body.sub_version, before.body.sub_version);
  assert.deepEqual(after.body.words, before.body.words);
  assert.deepEqual(after.body.subtitles, before.body.subtitles);
});

// ---------- 预览 ----------

test('预览：干净修正给出受影响字幕与候选整版，ok=true', async () => {
  const pid = await setupProject();
  const c0 = await cueAt(pid, 0);
  const c2 = await cueAt(pid, 2);
  const c4 = await cueAt(pid, 4);
  const r = await submit(pid, {
    sub_version: 1,
    items: [{ word_idx: 2, start_ms: 1400, end_ms: 1900 }, { word_idx: 3, start_ms: 1950, end_ms: 2400 }],
  });
  const pv = await preview(pid, r.body.id);
  assert.equal(pv.status, 200);
  const ev = pv.body.evaluation;
  assert.equal(ev.ok, true, JSON.stringify(ev.conflicts));
  assert.deepEqual(ev.replaced.map((s) => s.id), [c2.id]);
  assert.deepEqual(ev.affected_locked, []);
  // 候选：cue1/cue3 保留（id 与版本不变），cue2 重排为新行
  const origins = ev.subtitles.map((c) => c.origin);
  assert.deepEqual(origins, ['kept', 'new', 'kept']);
  const keptIds = ev.subtitles.filter((c) => c.origin === 'kept').map((c) => c.id).sort((a, b) => a - b);
  assert.deepEqual(keptIds, [c0.id, c4.id]);
  const neu = ev.subtitles.find((c) => c.origin === 'new');
  assert.equal(neu.id, null);
  assert.equal(neu.start_ms <= 1400 && neu.end_ms >= 2400, true);
  assert.ok(neu.end_ms <= 2800, '重排不得跨切点 2800');
});

test('预览：修正突破锁定字幕边界 → locked_word_span；切点被带入锁定词 → locked_cut_inside_word', async () => {
  const pid = await setupProject();
  const c0 = await cueAt(pid, 0);
  await api(`/api/projects/${pid}/subtitles/${c0.id}`, 'PATCH',
    { version: 1, locked: true, text: '人工锁定文本' });
  // 词0结束推到 1100：超出锁定结束 1000；词1 [1100,1200] 紧贴切点（切点 1200 不在词内部）
  const r = await submit(pid, { sub_version: 2, items: [
    { word_idx: 0, start_ms: 0, end_ms: 1100 },
    { word_idx: 1, start_ms: 1100, end_ms: 1200 },
  ] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const pv = await preview(pid, r.body.id);
  const ev = pv.body.evaluation;
  assert.equal(ev.ok, false);
  assert.deepEqual(ev.affected_locked.map((s) => s.id), [c0.id]);
  assert.ok(ev.items[0].conflicts.some((c) => c.type === 'locked_word_span'));

  // 切点 1200 落入修正后的词1 内部，且该词属于锁定字幕
  const r2 = await submit(pid, { sub_version: 2, items: [
    { word_idx: 1, start_ms: 1100, end_ms: 1300 },
  ] });
  const pv2 = await preview(pid, r2.body.id);
  assert.ok(pv2.body.evaluation.items[0].conflicts.some((c) => c.type === 'locked_cut_inside_word'));
});

test('预览：未锁定区间切点落入修正词 → cut_inside_word，候选整版为空', async () => {
  const pid = await setupProject();
  const r = await submit(pid, { sub_version: 1, items: [{ word_idx: 2, start_ms: 1100, end_ms: 1250 }] });
  const pv = await preview(pid, r.body.id);
  const ev = pv.body.evaluation;
  assert.equal(ev.ok, false);
  assert.ok(ev.items[0].conflicts.some((c) => c.type === 'cut_inside_word'),
    JSON.stringify(ev.items[0].conflicts));
  assert.deepEqual(ev.subtitles, []);
});

test('预览：现行规则无法兼顾（最短时长空间不足）→ duration 定位到词', async () => {
  // 词 0/1 紧贴且各 300ms，min_duration=1000 时无空间 → duration 冲突
  const { status, body } = await api('/api/projects', 'POST', {
    name: '词修正规则冲突',
    words: [
      { text: '甲', start_ms: 0, end_ms: 300 },
      { text: '乙', start_ms: 500, end_ms: 800 },
    ],
    cuts: [],
    rules: { max_chars: 1, min_duration_ms: 1000, max_cps: 20 },
  });
  assert.equal(status, 201);
  const pid = body.id;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  // 初始数据本身就无法排版：直接构造"有字幕后"场景——跳过，改为在可行项目上把规则改严
  assert.equal(layout.status, 422);
  // 改用可行项目并收紧规则：GOOD_WORDS 项目，min_duration 提高到词间隙放不下
  const pid2 = await setupProject();
  await api(`/api/projects/${pid2}/rules`, 'PUT', {
    version: 1, max_chars: 30, min_duration_ms: 2000, max_cps: 20,
  });
  const r = await submit(pid2, { sub_version: 1, items: [{ word_idx: 0, start_ms: 0, end_ms: 400 }] });
  assert.equal(r.status, 201);
  const pv = await preview(pid2, r.body.id);
  assert.equal(pv.body.evaluation.ok, false);
  assert.ok(pv.body.evaluation.items[0].conflicts.some((c) => c.type === 'duration'),
    JSON.stringify(pv.body.evaluation.items[0].conflicts));
});

// ---------- 确认：原子写入 ----------

test('确认：原子更新词时间、受影响字幕换 ID/版本、未受影响保留、推进 sub_version', async () => {
  const pid = await setupProject();
  const r = await submit(pid, {
    note: '第二段提前', sub_version: 1,
    items: [{ word_idx: 2, start_ms: 1400, end_ms: 1900 }, { word_idx: 3, start_ms: 1950, end_ms: 2400 }],
  });
  // 确认前从预览取得候选的保留行 ID 与被替换行 ID（全库自增 ID，不能硬编码）
  const pvBefore = await preview(pid, r.body.id);
  assert.equal(pvBefore.body.evaluation.ok, true);
  const keptIds = pvBefore.body.evaluation.subtitles
    .filter((c) => c.origin === 'kept').map((c) => c.id);
  const replacedOld = pvBefore.body.evaluation.replaced.map((s) => s.id);

  const cf = await confirm(pid, r.body.id);
  assert.equal(cf.status, 200, JSON.stringify(cf.body));
  assert.equal(cf.body.status, 'confirmed');
  assert.equal(cf.body.words_updated, 2);
  assert.equal(cf.body.cues_replaced, 1);
  assert.equal(cf.body.sub_version, 2);

  const after = await api(`/api/projects/${pid}`);
  // 词序、词文本不变，仅时间更新
  assert.equal(after.body.words.map((w) => w.text).join(','), GOOD_WORDS.map((w) => w.text).join(','));
  assert.deepEqual([after.body.words[2].start_ms, after.body.words[2].end_ms], [1400, 1900]);
  assert.deepEqual([after.body.words[3].start_ms, after.body.words[3].end_ms], [1950, 2400]);
  // 保留行 ID 与版本 1 不变；受影响未锁定行旧 ID 消失、换成新 ID
  const byId = new Map(after.body.subtitles.map((s) => [s.id, s]));
  for (const kid of keptIds) {
    assert.equal(byId.get(kid).version, 1, `保留字幕 ${kid} 行版本不变`);
  }
  for (const oldId of replacedOld) assert.equal(byId.has(oldId), false, '受影响未锁定字幕必须更换 ID');
  const newCue = after.body.subtitles.find((s) => s.word_start === 2);
  assert.equal(newCue.version, 1);
  assert.ok(!keptIds.includes(newCue.id), '重排行必须是新 ID');
  assert.deepEqual([newCue.start_ms, newCue.end_ms], [1400, 2400]);
  // idx 连续、按时间升序
  assert.deepEqual(after.body.subtitles.map((s) => s.idx), [0, 1, 2]);

  // 提议标记 confirmed
  const head = await api(`/api/projects/${pid}/word-revisions/${r.body.id}`);
  assert.equal(head.body.status, 'confirmed');
  assert.equal(head.body.confirmed_sub_version, 2);
});

test('确认后整版通过导出校验并可导出 WebVTT', async () => {
  const pid = await setupProject();
  const r = await submit(pid, { sub_version: 1, items: [{ word_idx: 0, start_ms: 0, end_ms: 400 }] });
  const cf = await confirm(pid, r.body.id);
  assert.equal(cf.status, 200);
  const ex = await api(`/api/projects/${pid}/exports`, 'POST', { sub_version: cf.body.sub_version });
  assert.equal(ex.status, 201, JSON.stringify(ex.body));
  assert.match(ex.body.content, /^WEBVTT/);
});

test('确认：锁定字幕文本与时间原样保留；含修正词的锁定行不变', async () => {
  const pid = await setupProject();
  const c0 = await cueAt(pid, 0);
  await api(`/api/projects/${pid}/subtitles/${c0.id}`, 'PATCH',
    { version: 1, locked: true, text: '人工锁定' });
  // 兼容修正：词0收窄 [0,400]，完全在锁定 [0,1000] 内；重排只动 cue2
  const r = await submit(pid, { sub_version: 2, items: [{ word_idx: 0, start_ms: 0, end_ms: 400 }] });
  const pv = await preview(pid, r.body.id);
  assert.equal(pv.body.evaluation.ok, true, JSON.stringify(pv.body.evaluation.conflicts));
  const cf = await confirm(pid, r.body.id);
  assert.equal(cf.status, 200, JSON.stringify(cf.body));
  assert.equal(cf.body.cues_replaced, 0, '没有未锁定字幕含修正词（词0属于锁定行）');
  const after = await api(`/api/projects/${pid}`);
  const lk = after.body.subtitles.find((s) => s.id === c0.id);
  assert.equal(lk.locked, 1);
  assert.equal(lk.text, '人工锁定');
  assert.deepEqual([lk.start_ms, lk.end_ms], [0, 1000]);
  assert.equal(lk.version, 2, '锁定行版本不变（PATCH 锁定时已到 v2，词确认不再推进）');
  // 词时间确实更新了
  assert.equal(after.body.words[0].end_ms, 400);
});

test('确认：突破锁定边界 → 422，词与字幕均不变', async () => {
  const pid = await setupProject();
  const c0 = await cueAt(pid, 0);
  await api(`/api/projects/${pid}/subtitles/${c0.id}`, 'PATCH',
    { version: 1, locked: true, text: '锁' });
  const r = await submit(pid, { sub_version: 2, items: [
    { word_idx: 0, start_ms: 0, end_ms: 1100 },
    { word_idx: 1, start_ms: 1100, end_ms: 1200 },
  ] });
  const cf = await confirm(pid, r.body.id);
  assert.equal(cf.status, 422);
  assert.ok(cf.body.items.some((it) => it.reasons.some((x) => x.type === 'locked_word_span')));
  assert.equal(cf.body.current.sub_version, 2);
  const after = await api(`/api/projects/${pid}`);
  assert.equal(after.body.sub_version, 2);
  assert.equal(after.body.words[0].end_ms, 500, '词时间不变');
  const lk = after.body.subtitles.find((s) => s.id === c0.id);
  assert.deepEqual([lk.start_ms, lk.end_ms], [0, 1000]);
});

test('确认：未受影响字幕保留 ID/行版本/人工文本；词完整覆盖、不重叠', async () => {
  const pid = await setupProject();
  const c2before = await cueAt(pid, 2);
  const c4 = await cueAt(pid, 4);
  // 人工编辑 cue3（不锁定）→ v2 + 人工文本
  const edit = await api(`/api/projects/${pid}/subtitles/${c4.id}`, 'PATCH',
    { version: 1, text: '人工再见朋友' });
  assert.equal(edit.status, 200);
  const r = await submit(pid, { sub_version: edit.body.sub_version,
    items: [{ word_idx: 0, start_ms: 0, end_ms: 400 }] });
  const cf = await confirm(pid, r.body.id);
  assert.equal(cf.status, 200, JSON.stringify(cf.body));
  const after = await api(`/api/projects/${pid}`);
  const c2 = after.body.subtitles.find((s) => s.word_start === 2);
  const c3 = after.body.subtitles.find((s) => s.word_start === 4);
  assert.equal(c2.id, c2before.id); assert.equal(c2.version, 1);
  assert.equal(c3.id, c4.id); assert.equal(c3.version, 2);
  assert.equal(c3.text, '人工再见朋友');
  // 完整覆盖、有序不重叠
  const covered = new Array(6).fill(0);
  for (const s of after.body.subtitles) for (let k = s.word_start; k <= s.word_end; k++) covered[k]++;
  assert.deepEqual(covered, [1, 1, 1, 1, 1, 1]);
  const sorted = after.body.subtitles;
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i - 1].end_ms <= sorted[i].start_ms);
});

// ---------- 过期/失效 ----------

test('确认：sub_version 过期（提交后字幕集被改）→ 409 且整组不生效', async () => {
  const pid = await setupProject();
  const r = await submit(pid, { sub_version: 1, items: [{ word_idx: 4, start_ms: 2900, end_ms: 3300 }] });
  // 其间做一次单条编辑推进 sub_version
  const c0 = await cueAt(pid, 0);
  await api(`/api/projects/${pid}/subtitles/${c0.id}`, 'PATCH', { version: 1, text: '期间改过' });
  const cf = await confirm(pid, r.body.id);
  assert.equal(cf.status, 409);
  assert.equal(cf.body.current.sub_version, 2);
  const after = await api(`/api/projects/${pid}`);
  assert.equal(after.body.words[4].start_ms, 3000, '过期提议不得改词');
});

test('确认：词漂移（同一词被先到的修正确认）→ 409，后到提议不生效', async () => {
  const pid = await setupProject();
  const r1 = await submit(pid, { sub_version: 1, items: [{ word_idx: 4, start_ms: 2900, end_ms: 3300 }] });
  const r2 = await submit(pid, { sub_version: 1, items: [{ word_idx: 4, start_ms: 2950, end_ms: 3350 }] });
  const c1 = await confirm(pid, r1.body.id);
  assert.equal(c1.status, 200);
  const pv = await preview(pid, r2.body.id);
  assert.equal(pv.body.evaluation.items[0].state, 'drifted');
  const c2 = await confirm(pid, r2.body.id);
  assert.equal(c2.status, 409);
  assert.equal(c2.body.items[0].current.start_ms, 2900);
  const after = await api(`/api/projects/${pid}`);
  assert.deepEqual([after.body.words[4].start_ms, after.body.words[4].end_ms], [2900, 3300]);
});

test('重复确认 → 409，不再改词与字幕', async () => {
  const pid = await setupProject();
  const r = await submit(pid, { sub_version: 1, items: [{ word_idx: 0, start_ms: 0, end_ms: 400 }] });
  const c1 = await confirm(pid, r.body.id);
  assert.equal(c1.status, 200);
  const sv1 = c1.body.sub_version;
  const c2 = await confirm(pid, r.body.id);
  assert.equal(c2.status, 409);
  assert.equal(c2.body.already_confirmed, true);
  const after = await api(`/api/projects/${pid}`);
  assert.equal(after.body.sub_version, sv1);
});

test('重新导入后词缺失：预览 missing，确认 → 409', async () => {
  const pid = await setupProject();
  const r = await submit(pid, { sub_version: 1, items: [{ word_idx: 5, start_ms: 3500, end_ms: 3950 }] });
  // 重新导入（更少词）
  const imp = await api(`/api/projects/${pid}/import`, 'POST', {
    force: true,
    words: GOOD_WORDS.slice(0, 3),
    cuts: CUTS,
  });
  assert.equal(imp.status, 200);
  const pv = await preview(pid, r.body.id);
  assert.equal(pv.body.evaluation.items[0].state, 'missing');
  const cf = await confirm(pid, r.body.id);
  assert.equal(cf.status, 409);
  assert.ok(cf.body.items[0].reasons.some((x) => x.type === 'word_missing'));
});

// ---------- 与既有功能的关系 ----------

test('旧字幕修订提议在词确认更换 cue ID 后不得误采纳（missing → 409）', async () => {
  const pid = await setupProject();
  const c2 = await cueAt(pid, 2);
  const rev = await api(`/api/projects/${pid}/revisions`, 'POST', {
    items: [{ subtitle_id: c2.id, cue_version: 1, text: '欢迎光临改' }],
  });
  assert.equal(rev.status, 201);
  // 词2 修正 → cue2 被删除重排为新 ID
  const wr = await submit(pid, { sub_version: 1, items: [{ word_idx: 2, start_ms: 1400, end_ms: 1900 }] });
  const cf = await confirm(pid, wr.body.id);
  assert.equal(cf.status, 200);
  assert.equal(cf.body.cues_replaced, 1);
  const acc = await api(`/api/projects/${pid}/revisions/${rev.body.id}/accept`, 'POST', {});
  assert.equal(acc.status, 409);
  assert.ok(acc.body.items.some((it) => it.reasons.some((x) => x.type === 'subtitle_missing')));
});

test('词确认不影响既有导出快照；历史可查', async () => {
  const pid = await setupProject();
  const e1 = await api(`/api/projects/${pid}/exports`, 'POST', {});
  assert.equal(e1.status, 201);
  const snap = e1.body.content;

  const wr = await submit(pid, { sub_version: 1, items: [{ word_idx: 2, start_ms: 1400, end_ms: 1900 }] });
  const cf = await confirm(pid, wr.body.id);
  assert.equal(cf.status, 200);

  const dl = await api(`/api/projects/${pid}/exports/1`);
  assert.equal(dl.body, snap, '既有导出快照必须保持不变');

  const list = await api(`/api/projects/${pid}/word-revisions`);
  assert.equal(list.body[0].status, 'confirmed');
  assert.equal(list.body[0].item_count, 1);
  const detail = await api(`/api/projects/${pid}/word-revisions/${wr.body.id}`);
  assert.equal(detail.body.items[0].current.start_ms, 1400);
});

test('404：项目或提议不存在', async () => {
  const pid = await setupProject();
  assert.equal((await api(`/api/projects/${pid}/word-revisions/9999`)).status, 404);
  assert.equal((await api('/api/projects/9999/word-revisions')).status, 404);
});
