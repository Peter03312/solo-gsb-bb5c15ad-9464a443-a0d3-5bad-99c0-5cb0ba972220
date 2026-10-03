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

async function setupProject() {
  const created = await api('/api/projects', 'POST', {
    name: '译文测试', words: GOOD_WORDS, cuts: [1200],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pid = created.body.id;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  return { pid, cues: layout.body.subtitles };
}

const enc = encodeURIComponent;

// ---------- 保存 ----------

test('保存：非法语言代号 / 空译文 / 缺行版本 → 400', async () => {
  const { pid, cues } = await setupProject();
  const badLang = await api(`/api/projects/${pid}/translations/${enc('zh CN')}/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello', cue_version: 1 });
  assert.equal(badLang.status, 400);

  const blank = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: '   ', cue_version: 1 });
  assert.equal(blank.status, 400);

  const noVer = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello' });
  assert.equal(noVer.status, 400);
});

test('保存：字幕不存在 → 404；新建 201，重复身份冲突 409', async () => {
  const { pid, cues } = await setupProject();
  const ghost = await api(`/api/projects/${pid}/translations/en/subtitles/99999`,
    'PUT', { text: 'Hello', cue_version: 1 });
  assert.equal(ghost.status, 404);

  const r1 = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1 });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal(r1.body.translation.version, 1);
  assert.equal(r1.body.translation.status, 'current');
  assert.deepEqual([r1.body.translation.src_start_ms, r1.body.translation.src_end_ms],
    [cues[0].start_ms, cues[0].end_ms]);

  // 已存在却按新建提交（version 省略）→ 409
  const dup = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hi world', cue_version: 1 });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.current.translation.text, 'Hello world');

  // 带旧译文版本更新 → 409，数据不变
  const stale = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hi again', cue_version: 1, version: 99 });
  assert.equal(stale.status, 409);

  // 行版本过期 → 409
  const staleCue = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hi', cue_version: 99, version: 1 });
  assert.equal(staleCue.status, 409);
});

test('保存：译文超 max_chars 或超 max_cps → 422 且不改数据；沿用源行时间', async () => {
  const { pid, cues } = await setupProject();
  const long = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'x'.repeat(31), cue_version: 1 });
  assert.equal(long.status, 422);
  assert.ok(long.body.errors.some((e) => e.includes('最大字数')));

  // 源行 cue[0] 时长约 1000ms（时间按规则扩展过），21 字 → 21 字/秒 > 20
  const cps = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'x'.repeat(21), cue_version: 1 });
  assert.equal(cps.status, 422);
  assert.ok(cps.body.errors.some((e) => e.includes('字/秒')));

  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.counts.missing, 2, '422 不得写入译文');
});

test('保存：不同语言互不影响（同一条字幕各语言一份）', async () => {
  const { pid, cues } = await setupProject();
  const en = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1 });
  assert.equal(en.status, 201);
  const ja = await api(`/api/projects/${pid}/translations/ja-JP/subtitles/${cues[0].id}`,
    'PUT', { text: 'こんにちは世界', cue_version: 1 });
  assert.equal(ja.status, 201);
  const view = await api(`/api/projects/${pid}/translations/${enc('ja-JP')}`);
  assert.equal(view.body.entries[0].translation.text, 'こんにちは世界');
  assert.equal(view.body.counts.current, 1);
});

// ---------- 查询 ----------

test('查询：逐行并列原文/译文/状态，含现行规则 invalid_reasons', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1 });
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.status, 200);
  assert.equal(view.body.counts.cues, 2);
  assert.equal(view.body.counts.current, 1);
  assert.equal(view.body.counts.missing, 1);
  const [e0, e1] = view.body.entries;
  assert.equal(e0.cue.text, cues[0].text);
  assert.equal(e0.translation.text, 'Hello world');
  assert.equal(e0.state, 'current');
  assert.equal(e0.valid, true);
  assert.equal(e1.state, 'missing');
  assert.equal(e1.translation, null);

  // 规则收紧 → 未改任何数据，视图动态标记 invalid
  await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: 1, max_chars: 5, min_duration_ms: 800, max_cps: 20,
  });
  const view2 = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view2.body.entries[0].valid, false);
  assert.ok(view2.body.entries[0].invalid_reasons.some((m) => m.includes('最大字数')));
  assert.equal(view2.body.counts.valid, 0);
});

test('语言总览：各语言状态分布与导出数', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1 });
  await api(`/api/projects/${pid}/translations/fr/subtitles/${cues[1].id}`,
    'PUT', { text: 'Bienvenue', cue_version: 1 });
  const list = await api(`/api/projects/${pid}/translations`);
  assert.equal(list.status, 200);
  const byLang = new Map(list.body.languages.map((l) => [l.lang, l]));
  assert.equal(byLang.get('en').current_count, 1);
  assert.equal(byLang.get('fr').current_count, 1);
  assert.equal(byLang.get('en').active_count, 1);
});

// ---------- 失效：源字幕变化 → 待复核；仅锁定/顺序变化不失效 ----------

test('源文本/时间变化 → 译文 review；仅锁定切换仍 current', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1 });
  // 仅锁定：源文本/时间不变 → 不失效
  const lock = await api(`/api/projects/${pid}/subtitles/${cues[0].id}`,
    'PATCH', { version: 1, locked: true });
  assert.equal(lock.status, 200);
  let view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.entries[0].state, 'current');
  assert.equal(view.body.entries[0].valid, true);

  // 改源文本 → 译文待复核
  const edit = await api(`/api/projects/${pid}/subtitles/${cues[0].id}`,
    'PATCH', { version: 2, text: '你好呀世界' });
  assert.equal(edit.status, 200);
  view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.entries[0].state, 'review');
  assert.equal(view.body.entries[0].translation.version, 1);
  assert.equal(view.body.entries[0].translation.src_text, '你好世界', '快照保留保存时原文');
  assert.equal(view.body.counts.review, 1);
});

test('重排：身份保持（词区间相同的行不失效），消失行译文留历史，新行缺译', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1 });
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[1].id}`,
    'PUT', { text: 'Welcome', cue_version: 1 });

  // 收紧 max_chars=2 触发重新分段：原行（词区间 0..1 / 2..3）全部消失，拆成 4 条新行
  await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: 1, max_chars: 2, min_duration_ms: 300, max_cps: 20,
  });
  const rel = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 1 });
  assert.equal(rel.status, 200, JSON.stringify(rel.body));
  assert.equal(rel.body.subtitles.length, 4);

  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.deepEqual(view.body.entries.map((e) => e.state), ['missing', 'missing', 'missing', 'missing']);
  assert.equal(view.body.history.length, 2, '被删原行译文留作历史');
  assert.ok(view.body.history.every((h) => h.status === 'history' && h.subtitle_id === null));
  // 新行不得按序号自动挪用旧译文
  assert.ok(view.body.entries.every((e) => e.translation === null));
});

test('重排：规则放宽后重新排版，源内容不变的行保持 current（不因展示顺序变化失效）', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1 });
  // 再排一次（结果一致）：行身份保持、版本不变、译文仍 current
  const rel = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 1 });
  assert.equal(rel.status, 200);
  const keptId = rel.body.subtitles[0].id;
  assert.equal(keptId, cues[0].id, '词区间与内容一致的未锁定行保留 ID');
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.entries[0].state, 'current');
  assert.equal(view.body.entries[0].cue.version, 1);
});

test('重新导入：旧译文全部留作历史，新行缺译不挪用', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1 });
  const imp = await api(`/api/projects/${pid}/import`, 'POST', { words: GOOD_WORDS, cuts: [1200], force: true });
  assert.equal(imp.status, 200);
  const lay = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: imp.body.sub_version });
  assert.equal(lay.status, 200);
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.counts.missing, 2);
  assert.equal(view.body.history.length, 1);
});

// ---------- 确认待复核 ----------

test('确认：非 review → 422；过期译文版本 → 409 不改数据', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1 });
  const noReview = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}/confirm`,
    'POST', { version: 1 });
  assert.equal(noReview.status, 422);

  await api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', { version: 1, text: '你好世界呀' });
  const stale = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}/confirm`,
    'POST', { version: 99 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.translation.status, 'review');
});

test('确认：核对后确认 → current，刷新源快照并推进译文版本；确认不推进 sub_version', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1 });
  const edit = await api(`/api/projects/${pid}/subtitles/${cues[0].id}`,
    'PATCH', { version: 1, text: '你好世界呀' });
  const subV = edit.body.sub_version;
  const view1 = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view1.body.entries[0].state, 'review');

  const ok = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}/confirm`,
    'POST', { version: 1 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.translation.status, 'current');
  assert.equal(ok.body.translation.version, 2);
  assert.equal(ok.body.translation.src_text, '你好世界呀');
  assert.equal(ok.body.translation.cue_version_snapshot, 2);
  // 译文确认不改源字幕集
  const project = await api(`/api/projects/${pid}`);
  assert.equal(project.body.sub_version, subV);
});

test('确认：现行规则不通过的待复核译文 → 422 返回当前值与原因；重新保存后恢复', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1 });
  // 规则收紧到 3 字（源文不受影响，仅译文超限）
  await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: 1, max_chars: 3, min_duration_ms: 800, max_cps: 20,
  });
  // 再改原文使其进入 review
  await api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', { version: 1, text: '你好世界哦' });
  const bad = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}/confirm`,
    'POST', { version: 1 });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.errors.some((m) => m.includes('最大字数')));
  assert.equal(bad.body.current.translation.status, 'review');

  // 重新保存一条合规译文（带行版本 2、译文版本 1）→ 直接恢复 current
  const resave = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hi', cue_version: 2, version: 1 });
  assert.equal(resave.status, 200);
  assert.equal(resave.body.translation.status, 'current');
});

// ---------- 与修订/词修正联动 ----------

test('批量修订采纳：被改源行译文转 review；未改行仍 current', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1 });
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[1].id}`,
    'PUT', { text: 'Welcome', cue_version: 1 });
  const submit = await api(`/api/projects/${pid}/revisions`, 'POST', {
    items: [{ subtitle_id: cues[0].id, cue_version: 1, text: '你好世界呀' }],
  });
  assert.equal(submit.status, 201);
  const acc = await api(`/api/projects/${pid}/revisions/${submit.body.id}/accept`, 'POST', {});
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.entries[0].state, 'review');
  assert.equal(view.body.entries[1].state, 'current');
});

test('逐词修正确认：受影响重排行译文转 review/历史，未受影响行 current', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1 });
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[1].id}`,
    'PUT', { text: 'Welcome', cue_version: 1 });
  // 修正词 0 时间：cue0 被删除重排为新行（旧译文历史），cue1 保留
  const submit = await api(`/api/projects/${pid}/word-revisions`, 'POST', {
    sub_version: 1,
    items: [{ word_idx: 0, start_ms: 0, end_ms: 400 }],
  });
  assert.equal(submit.status, 201, JSON.stringify(submit.body));
  const cf = await api(`/api/projects/${pid}/word-revisions/${submit.body.id}/confirm`, 'POST', {});
  assert.equal(cf.status, 200, JSON.stringify(cf.body));
  const view = await api(`/api/projects/${pid}/translations/en`);
  // 词 0..1 所在新行缺译；词 2..3 行保留且 current
  const states = view.body.entries.map((e) => ({ ws: e.cue.word_start, state: e.state }));
  const kept = states.find((s) => s.ws === 2);
  assert.equal(kept.state, 'current');
  assert.ok(view.body.history.length >= 1);
});

// ---------- 按语言导出 ----------

test('导出：缺译/待复核/译文无效 → 422 分类列出，不生成快照', async () => {
  const { pid, cues } = await setupProject();
  // 只翻译第一条 → missing
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1 });
  const miss = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(miss.status, 422);
  assert.equal(miss.body.missing.length, 1);
  assert.equal(miss.body.missing[0].subtitle_id, cues[1].id);
  assert.equal((await api(`/api/projects/${pid}/translations/en/exports`)).body.length, 0);

  // 补齐后把第一条改成 review
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[1].id}`,
    'PUT', { text: 'Welcome', cue_version: 1 });
  await api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', { version: 1, text: '你好世界噢' });
  const rev = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(rev.status, 422);
  assert.equal(rev.body.review.length, 1);
  assert.equal(rev.body.missing.length, 0);

  // 确认恢复后收紧规则使译文超限 → invalid
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}/confirm`,
    'POST', { version: 1 });
  await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: 1, max_chars: 3, min_duration_ms: 800, max_cps: 20,
  });
  const inv = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(inv.status, 422);
  assert.ok(inv.body.invalid.length >= 1);
});

test('导出：全部 current 且有效 → 不可变 WebVTT 快照；各语言独立；原文导出仍可用', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1 });
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[1].id}`,
    'PUT', { text: 'Welcome', cue_version: 1 });
  await api(`/api/projects/${pid}/translations/fr/subtitles/${cues[0].id}`,
    'PUT', { text: 'Bonjour le monde', cue_version: 1 });
  await api(`/api/projects/${pid}/translations/fr/subtitles/${cues[1].id}`,
    'PUT', { text: 'Bienvenue', cue_version: 1 });

  const e1 = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(e1.status, 201, JSON.stringify(e1.body));
  assert.equal(e1.body.version, 1);
  assert.match(e1.body.content, /^WEBVTT/);
  assert.ok(e1.body.content.includes('Hello world'));
  assert.ok(!e1.body.content.includes('你好'), '译文快照不得混入原文');

  // 改译文后再导出 v2，v1 下载内容不变（不可变）
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hi world', cue_version: 1, version: 1 });
  const e2 = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(e2.status, 201);
  assert.equal(e2.body.version, 2);
  const dl1 = await api(`/api/projects/${pid}/translations/en/exports/1`);
  assert.equal(dl1.status, 200);
  assert.equal(dl1.headers.get('content-type'), 'text/vtt; charset=utf-8');
  assert.equal(dl1.body, e1.body.content);
  assert.ok(dl1.body.includes('Hello world') && !dl1.body.includes('Hi world'));

  // 法语版本独立从 v1 开始
  const fr = await api(`/api/projects/${pid}/translations/fr/exports`, 'POST', {});
  assert.equal(fr.body.version, 1);
  assert.ok(fr.body.content.includes('Bonjour'));

  // 原文导出与下载流程保持可用
  const src = await api(`/api/projects/${pid}/exports`, 'POST', {});
  assert.equal(src.status, 201);
  assert.ok(src.body.content.includes('你好'));
});

test('导出：sub_version 过期 → 409', async () => {
  const { pid } = await setupProject();
  const r = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', { sub_version: 999 });
  assert.equal(r.status, 409);
});

test('导出：源整版结构/规则不通过 → conflicts 拒绝（含时间与切点约束）', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1 });
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[1].id}`,
    'PUT', { text: 'Welcome', cue_version: 1 });
  // 收紧原文规则（max_chars=2）使源行超限：译文导出同样拒绝并列冲突
  await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: 1, max_chars: 2, min_duration_ms: 800, max_cps: 20,
  });
  const r = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(r.status, 422);
  assert.ok(r.body.conflicts.length > 0);
  assert.equal((await api(`/api/projects/${pid}/translations/en/exports`)).body.length, 0);
});
