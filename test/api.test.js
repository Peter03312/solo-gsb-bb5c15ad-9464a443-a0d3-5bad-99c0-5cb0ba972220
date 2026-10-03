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
  return { status: res.status, body: json, headers: res.headers };
}

const GOOD_WORDS = [
  { text: '你好', start_ms: 0, end_ms: 500 },
  { text: '世界', start_ms: 550, end_ms: 1000 },
  { text: '欢迎', start_ms: 1500, end_ms: 2000 },
  { text: '光临', start_ms: 2050, end_ms: 2500 },
];

async function createProject(overrides = {}) {
  const { status, body } = await api('/api/projects', 'POST', {
    name: '测试项目', words: GOOD_WORDS, cuts: [1200], ...overrides,
  });
  assert.equal(status, 201, JSON.stringify(body));
  return body;
}

// ---------- 导入校验 ----------

test('导入：倒序/重叠词段被拒绝（422）', async () => {
  const { status, body } = await api('/api/projects', 'POST', {
    name: '坏数据',
    words: [
      { text: 'a', start_ms: 0, end_ms: 500 },
      { text: 'b', start_ms: 300, end_ms: 800 }, // 与 a 重叠
    ],
  });
  assert.equal(status, 422);
  assert.match(body.error, /拒绝导入/);
  assert.ok(body.errors.some((e) => e.includes('倒序或重叠')));
});

test('导入：开始不早于结束被拒绝', async () => {
  const { status, body } = await api('/api/projects', 'POST', {
    name: '坏数据2',
    words: [{ text: 'a', start_ms: 500, end_ms: 500 }],
  });
  assert.equal(status, 422);
  assert.ok(body.errors.some((e) => e.includes('开始必须早于结束')));
});

test('导入：负时间与非整数被拒绝', async () => {
  const { status, body } = await api('/api/projects', 'POST', {
    name: '坏数据3',
    words: [{ text: 'a', start_ms: -1, end_ms: 500 }],
  });
  assert.equal(status, 422);
});

// ---------- 排版与冲突 ----------

test('排版：切点落词内 → 422 且不落库', async () => {
  const p = await createProject({ cuts: [250] }); // 250 在 '你好' [0,500] 内
  const { status, body } = await api(`/api/projects/${p.id}/layout`, 'POST', { sub_version: p.sub_version });
  assert.equal(status, 422);
  assert.ok(body.conflicts.some((c) => c.type === 'cut_inside_word'));
  const after = await api(`/api/projects/${p.id}`);
  assert.equal(after.body.subtitles.length, 0, '冲突时不得写入字幕');
});

test('排版：成功后覆盖全部词且不重叠', async () => {
  const p = await createProject();
  const { status, body } = await api(`/api/projects/${p.id}/layout`, 'POST', { sub_version: p.sub_version });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.subtitles.length, 2); // 切点 1200 → 两条
  const covered = new Array(4).fill(0);
  for (const c of body.subtitles) for (let k = c.word_start; k <= c.word_end; k++) covered[k]++;
  assert.deepEqual(covered, [1, 1, 1, 1]);
  for (let i = 1; i < body.subtitles.length; i++) {
    assert.ok(body.subtitles[i - 1].end_ms <= body.subtitles[i].start_ms);
  }
});

// ---------- 版本号（乐观锁） ----------

test('规则：过期版本被拒绝并返回当前内容', async () => {
  const p = await createProject();
  const v = p.rules.version;
  const ok = await api(`/api/projects/${p.id}/rules`, 'PUT', {
    version: v, max_chars: 20, min_duration_ms: 500, max_cps: 15,
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.version, v + 1);
  // 用旧版本再提交 → 409 + 当前内容
  const stale = await api(`/api/projects/${p.id}/rules`, 'PUT', {
    version: v, max_chars: 99, min_duration_ms: 500, max_cps: 15,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.version, v + 1);
  assert.equal(stale.body.current.max_chars, 20);
});

test('字幕编辑：行级版本过期 → 409 返回当前行', async () => {
  const p = await createProject();
  const layout = await api(`/api/projects/${p.id}/layout`, 'POST', { sub_version: p.sub_version });
  const cue = layout.body.subtitles[0];
  const ok = await api(`/api/projects/${p.id}/subtitles/${cue.id}`, 'PATCH', {
    version: cue.version, text: '改过的文本',
  });
  assert.equal(ok.status, 200);
  const stale = await api(`/api/projects/${p.id}/subtitles/${cue.id}`, 'PATCH', {
    version: cue.version, text: '再次修改',
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.text, '改过的文本');
  assert.equal(stale.body.current.version, cue.version + 1);
});

test('字幕编辑：缩短词时段 / 跨切点被拒绝', async () => {
  const p = await createProject();
  const layout = await api(`/api/projects/${p.id}/layout`, 'POST', { sub_version: p.sub_version });
  const cue = layout.body.subtitles[0]; // 覆盖词 0..1，词时段 [0,1000]
  const r1 = await api(`/api/projects/${p.id}/subtitles/${cue.id}`, 'PATCH', {
    version: cue.version, start_ms: 200, // 晚于首词开始 0 → 缩短词时段
  });
  assert.equal(r1.status, 422);
  assert.ok(r1.body.errors.some((e) => e.includes('缩短')));
  const r2 = await api(`/api/projects/${p.id}/subtitles/${cue.id}`, 'PATCH', {
    version: cue.version, end_ms: 1300, // 跨过切点 1200
  });
  assert.equal(r2.status, 422);
  assert.ok(r2.body.errors.some((e) => e.includes('切点')));
});

test('重排：sub_version 过期 → 409', async () => {
  const p = await createProject();
  await api(`/api/projects/${p.id}/layout`, 'POST', { sub_version: p.sub_version });
  const stale = await api(`/api/projects/${p.id}/layout`, 'POST', { sub_version: p.sub_version });
  assert.equal(stale.status, 409);
  assert.ok(stale.body.current.subtitles.length > 0);
});

test('锁定：重排只改未锁定部分', async () => {
  const p = await createProject();
  const layout = await api(`/api/projects/${p.id}/layout`, 'POST', { sub_version: p.sub_version });
  const first = layout.body.subtitles[0];
  // 锁定第一条并改文本
  const lock = await api(`/api/projects/${p.id}/subtitles/${first.id}`, 'PATCH', {
    version: first.version, locked: true, text: '人工校对的文本',
  });
  assert.equal(lock.status, 200);
  // 改规则让未锁定部分重排出不同结果
  const rules = await api(`/api/projects/${p.id}/rules`, 'PUT', {
    version: p.rules.version, max_chars: 3, min_duration_ms: 500, max_cps: 20,
  });
  assert.equal(rules.status, 200);
  const relayout = await api(`/api/projects/${p.id}/layout`, 'POST', { sub_version: lock.body.sub_version });
  assert.equal(relayout.status, 200, JSON.stringify(relayout.body));
  const kept = relayout.body.subtitles.find((s) => s.id === first.id);
  assert.equal(kept.text, '人工校对的文本');
  assert.equal(kept.locked, 1);
  // 未锁定词段（词 2..3 '欢迎光临'）按 max_chars=3 拆成两条
  const fresh = relayout.body.subtitles.filter((s) => s.id !== first.id);
  assert.equal(fresh.length, 2);
  assert.equal(fresh[0].text, '欢迎');
  assert.equal(fresh[1].text, '光临');
});

// ---------- 导出 ----------

test('导出：WebVTT 按时间升序，版本递增，旧版本不可变', async () => {
  const p = await createProject();
  const layout = await api(`/api/projects/${p.id}/layout`, 'POST', { sub_version: p.sub_version });
  assert.equal(layout.status, 200);

  const e1 = await api(`/api/projects/${p.id}/exports`, 'POST', { sub_version: layout.body.sub_version });
  assert.equal(e1.status, 201, JSON.stringify(e1.body));
  assert.equal(e1.body.version, 1);
  assert.match(e1.body.content, /^WEBVTT/);
  assert.ok(e1.body.content.includes('-->'));
  // 时间升序
  const starts = [...e1.body.content.matchAll(/^(\d{2}:\d{2}:\d{2}\.\d{3}) --> /gm)].map((m) => m[1]);
  const sorted = [...starts].sort();
  assert.deepEqual(starts, sorted);

  // 修改字幕后再次导出 → v2，且 v1 内容不变
  const cue = layout.body.subtitles[0];
  const edit = await api(`/api/projects/${p.id}/subtitles/${cue.id}`, 'PATCH', {
    version: cue.version, text: '导出后修改',
  });
  assert.equal(edit.status, 200);
  const e2 = await api(`/api/projects/${p.id}/exports`, 'POST', { sub_version: edit.body.sub_version });
  assert.equal(e2.status, 201);
  assert.equal(e2.body.version, 2);
  assert.ok(e2.body.content.includes('导出后修改'));

  const dl1 = await api(`/api/projects/${p.id}/exports/1`);
  assert.equal(dl1.status, 200);
  assert.equal(dl1.body, e1.body.content, 'v1 快照不得被后续修改影响');
  assert.ok(!dl1.body.includes('导出后修改'));
  const dl2 = await api(`/api/projects/${p.id}/exports/2`);
  assert.equal(dl2.body, e2.body.content);
});

test('导出：字幕违反当前规则时拒绝并列出问题', async () => {
  const p = await createProject();
  const layout = await api(`/api/projects/${p.id}/layout`, 'POST', { sub_version: p.sub_version });
  // 把规则改严：max_chars=1 → 现有字幕全部超限
  await api(`/api/projects/${p.id}/rules`, 'PUT', {
    version: p.rules.version, max_chars: 1, min_duration_ms: 500, max_cps: 20,
  });
  const e = await api(`/api/projects/${p.id}/exports`, 'POST', { sub_version: layout.body.sub_version });
  assert.equal(e.status, 422);
  assert.ok(e.body.conflicts.length > 0);
  const list = await api(`/api/projects/${p.id}/exports`);
  assert.equal(list.body.length, 0, '校验失败不得生成导出版本');
});

test('导出：sub_version 过期 → 409', async () => {
  const p = await createProject();
  const layout = await api(`/api/projects/${p.id}/layout`, 'POST', { sub_version: p.sub_version });
  const e = await api(`/api/projects/${p.id}/exports`, 'POST', { sub_version: 999 });
  assert.equal(e.status, 409);
});

test('重新导入：有字幕时需 force，且清空旧字幕', async () => {
  const p = await createProject();
  await api(`/api/projects/${p.id}/layout`, 'POST', { sub_version: p.sub_version });
  const noForce = await api(`/api/projects/${p.id}/import`, 'POST', { words: GOOD_WORDS, cuts: [] });
  assert.equal(noForce.status, 409);
  const forced = await api(`/api/projects/${p.id}/import`, 'POST', { words: GOOD_WORDS, cuts: [], force: true });
  assert.equal(forced.status, 200);
  assert.equal(forced.body.subtitles.length, 0);
});
