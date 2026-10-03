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

const enc = encodeURIComponent;

async function setupProject() {
  const created = await api('/api/projects', 'POST', {
    name: '批次交付测试', words: GOOD_WORDS, cuts: [1200],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pid = created.body.id;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  const cues = layout.body.subtitles;
  const sub_version = layout.body.sub_version;

  const put = (lang, i, text) =>
    api(`/api/projects/${pid}/translations/${lang}/subtitles/${cues[i].id}`,
      'PUT', { text, cue_version: 1 });
  await put('en', 0, 'Hello world');
  await put('en', 1, 'Welcome');
  await put('fr', 0, 'Bonjour le monde');
  await put('fr', 1, 'Bienvenue');

  // 各语言逐行译文版本清单（均为 v1）
  const line = (lang) => cues.map((c) => ({ subtitle_id: c.id, version: 1 }));
  const body = (extra = {}) => ({
    sub_version,
    rules_version: 1,
    languages: ['en', 'fr'],
    translations: { en: line('en'), fr: line('fr') },
    ...extra,
  });
  return { pid, cues, sub_version, body };
}

/** 从快照正文提取全部时间轴行（开始 --> 结束），用于比较各文件时间轴一致 */
function timelineOf(content) {
  return [...content.matchAll(/^(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})$/gm)]
    .map((m) => `${m[1]} --> ${m[2]}`);
}

// ---------- 请求形状 ----------

test('形状：sub_version/rules_version/languages/translations 非法 → 400', async () => {
  const { pid, body } = await setupProject();

  const badSub = await api(`/api/projects/${pid}/deliveries`, 'POST', body({ sub_version: '1' }));
  assert.equal(badSub.status, 400);
  assert.ok(badSub.body.errors.some((e) => e.includes('sub_version')));

  const badRules = await api(`/api/projects/${pid}/deliveries`, 'POST', body({ rules_version: 0 }));
  assert.equal(badRules.status, 400);

  const emptyLangs = await api(`/api/projects/${pid}/deliveries`, 'POST', body({ languages: [] }));
  assert.equal(emptyLangs.status, 400);
  assert.ok(emptyLangs.body.errors.some((e) => e.includes('languages')));

  const badLang = await api(`/api/projects/${pid}/deliveries`, 'POST', body({ languages: ['en', 'bad lang'] }));
  assert.equal(badLang.status, 400);

  const dupLang = await api(`/api/projects/${pid}/deliveries`, 'POST', body({ languages: ['en', 'en'] }));
  assert.equal(dupLang.status, 400);
  assert.ok(dupLang.body.errors.some((e) => e.includes('重复')));

  const noTrans = await api(`/api/projects/${pid}/deliveries`, 'POST', (() => {
    const b = body(); delete b.translations; return b;
  })());
  assert.equal(noTrans.status, 400);

  const extraLang = await api(`/api/projects/${pid}/deliveries`, 'POST', body({
    languages: ['en'],
    translations: {
      en: body().translations.en,
      fr: body().translations.fr,
    },
  }));
  assert.equal(extraLang.status, 400);
  assert.ok(extraLang.body.errors.some((e) => e.includes('未在 languages')));

  const missingLang = await api(`/api/projects/${pid}/deliveries`, 'POST', body({
    translations: { en: body().translations.en },
  }));
  assert.equal(missingLang.status, 400);
  assert.ok(missingLang.body.errors.some((e) => e.includes('缺少语言 fr')));

  const badItem = await api(`/api/projects/${pid}/deliveries`, 'POST', body({
    translations: {
      en: body().translations.en.map((it, i) => (i === 0 ? { subtitle_id: it.subtitle_id } : it)),
      fr: body().translations.fr,
    },
  }));
  assert.equal(badItem.status, 400);
  assert.ok(badItem.body.errors.some((e) => e.includes('version')));

  const dupCue = await api(`/api/projects/${pid}/deliveries`, 'POST', body({
    translations: {
      en: [...body().translations.en, body().translations.en[0]],
      fr: body().translations.fr,
    },
  }));
  assert.equal(dupCue.status, 400);
  assert.ok(dupCue.body.errors.some((e) => e.includes('重复出现')));
});

test('形状：逐行清单与当前字幕行数不一致/指向不存在行 → 400 且不生成批次', async () => {
  const { pid, body, cues } = await setupProject();
  const oneLine = await api(`/api/projects/${pid}/deliveries`, 'POST', body({
    translations: { en: [{ subtitle_id: cues[0].id, version: 1 }], fr: body().translations.fr },
  }));
  assert.equal(oneLine.status, 400);
  assert.ok(oneLine.body.errors[0].includes('一一对应'));

  const unknown = await api(`/api/projects/${pid}/deliveries`, 'POST', body({
    translations: {
      en: cues.map((c) => ({ subtitle_id: c.id, version: 1 })),
      fr: cues.map((c, i) => ({ subtitle_id: i === 0 ? 99999 : c.id, version: 1 })),
    },
  }));
  assert.equal(unknown.status, 400);
  assert.ok(unknown.body.errors[0].includes('不存在的字幕行'));

  assert.equal((await api(`/api/projects/${pid}/deliveries`)).body.batches.length, 0);
});

// ---------- 版本漂移 ----------

test('核对：sub_version 漂移 → 409 带当前值，整批不生效', async () => {
  const { pid, body } = await setupProject();
  const r = await api(`/api/projects/${pid}/deliveries`, 'POST', body({ sub_version: 999 }));
  assert.equal(r.status, 409);
  assert.equal(r.body.sub_version_stale, true);
  assert.ok(r.body.current.subtitles.length === 2);
  assert.equal((await api(`/api/projects/${pid}/deliveries`)).body.batches.length, 0);
});

test('核对：rules_version 漂移（规则被改）→ 409', async () => {
  const { pid, body } = await setupProject();
  await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: 1, max_chars: 40, min_duration_ms: 800, max_cps: 20,
  });
  const r = await api(`/api/projects/${pid}/deliveries`, 'POST', body());
  assert.equal(r.status, 409);
  assert.equal(r.body.rules_version_stale, true);
  assert.equal(r.body.current.rules_version, 2);
});

// ---------- 逐语言/逐行核对 ----------

test('核对：缺译（语言从未保存译文）→ 422 按语言和行返回 missing', async () => {
  const { pid, body, cues } = await setupProject();
  const r = await api(`/api/projects/${pid}/deliveries`, 'POST', body({
    languages: ['en', 'fr', 'ja-JP'],
    translations: {
      en: body().translations.en,
      fr: body().translations.fr,
      'ja-JP': cues.map((c) => ({ subtitle_id: c.id, version: 1 })),
    },
  }));
  assert.equal(r.status, 422);
  assert.ok(r.body.error.includes('整批未生成快照'));
  const ja = r.body.languages.find((l) => l.lang === 'ja-JP');
  assert.equal(ja.missing.length, 2);
  assert.deepEqual(ja.missing.map((m) => m.subtitle_id), cues.map((c) => c.id));
  const en = r.body.languages.find((l) => l.lang === 'en');
  assert.equal(en.problem_count, 0);
});

test('核对：译文待复核（源行已改）→ 422 标 review 且不改数据', async () => {
  const { pid, body, cues } = await setupProject();
  const edit = await api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', { version: 1, text: '你好呀世界' });
  // 源编辑推进了字幕集版本：提交刷新后的 sub_version，仅译文状态为待复核 → 422
  const r = await api(`/api/projects/${pid}/deliveries`, 'POST', body({ sub_version: edit.body.sub_version }));
  assert.equal(r.status, 422);
  for (const lang of ['en', 'fr']) {
    const l = r.body.languages.find((x) => x.lang === lang);
    assert.equal(l.review.length, 1, lang);
    assert.equal(l.review[0].subtitle_id, cues[0].id);
    assert.ok(l.review[0].reasons[0].includes('待复核'));
  }
});

test('核对：译文版本漂移 → 422 version_stale 给出提交版本与当前版本', async () => {
  const { pid, body, cues } = await setupProject();
  // 英语第一行更新到 v2，提交仍携带 v1
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hi world', cue_version: 1, version: 1 });
  const r = await api(`/api/projects/${pid}/deliveries`, 'POST', body());
  assert.equal(r.status, 422);
  const en = r.body.languages.find((l) => l.lang === 'en');
  assert.equal(en.version_stale.length, 1);
  assert.equal(en.version_stale[0].submitted_version, 1);
  assert.equal(en.version_stale[0].current.version, 2);
  assert.equal(en.version_stale[0].current.text, 'Hi world');
  assert.equal(r.body.languages.find((l) => l.lang === 'fr').problem_count, 0);
});

test('核对：current 但超现行字数/字速 → 422 invalid 带中文原因', async () => {
  const { pid, body } = await setupProject();
  // 规则收紧到 3 字（源文不受影响，仅译文超限）
  await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: 1, max_chars: 3, min_duration_ms: 800, max_cps: 20,
  });
  const r = await api(`/api/projects/${pid}/deliveries`, 'POST', body({ rules_version: 2 }));
  assert.equal(r.status, 422);
  const en = r.body.languages.find((l) => l.lang === 'en');
  assert.ok(en.invalid.length >= 1);
  assert.ok(en.invalid[0].reasons.some((m) => m.includes('最大字数')));
});

test('核对：源整版结构/规则不通过 → 422 conflicts（含锁定行）', async () => {
  const { pid, body, cues } = await setupProject();
  // 收紧原文 max_chars=2 使源行超限；译文仍 current
  await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: 1, max_chars: 2, min_duration_ms: 800, max_cps: 20,
  });
  const r = await api(`/api/projects/${pid}/deliveries`, 'POST', body({ rules_version: 2 }));
  assert.equal(r.status, 422);
  assert.ok(r.body.conflicts.length > 0);
  assert.ok(r.body.conflicts.some((c) => c.type === 'max_chars'));
});

test('核对：无字幕可交付 → 422', async () => {
  const created = await api('/api/projects', 'POST', { name: '空项目' });
  const r = await api(`/api/projects/${created.body.id}/deliveries`, 'POST', {
    sub_version: 0, rules_version: 1, languages: [], translations: {},
  });
  assert.equal(r.status, 400, '空语言列表先被形状校验拦截');
  // 有合法形状但无字幕
  const r2 = await api(`/api/projects/${created.body.id}/deliveries`, 'POST', {
    sub_version: 0, rules_version: 1, languages: ['en'], translations: { en: [] },
  });
  assert.equal(r2.status, 422);
  assert.ok(r2.body.error.includes('没有字幕'));
});

// ---------- 成功批次 ----------

test('交付成功：各序列生成不可变版本，批次清单关联文件/版本，时间轴一致', async () => {
  const { pid, body, cues } = await setupProject();
  const r = await api(`/api/projects/${pid}/deliveries`, 'POST', body({ note: '片方第一批' }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.sub_version, 1);
  assert.equal(r.body.rules_version, 1);
  assert.equal(r.body.cue_count, 2);
  assert.equal(r.body.lang_count, 2);
  assert.deepEqual(r.body.languages, ['en', 'fr']);

  const [src, en, fr] = r.body.files;
  assert.equal(src.kind, 'source');
  assert.equal(src.version, 1);
  assert.equal(en.kind, 'translation');
  assert.equal(en.lang, 'en');
  assert.equal(en.version, 1);
  assert.equal(fr.lang, 'fr');
  assert.equal(fr.version, 1);
  assert.deepEqual(r.body.files.map((f) => f.ord), [0, 1, 2]);

  // 时间轴一致，正文各自正确
  assert.deepEqual(timelineOf(src.content), timelineOf(en.content));
  assert.deepEqual(timelineOf(src.content), timelineOf(fr.content));
  assert.ok(src.content.includes('你好世界'));
  assert.ok(en.content.includes('Hello world'));
  assert.ok(fr.content.includes('Bonjour'));
  assert.ok(!en.content.includes('你好'));

  // 文件经现有下载能力取得（内容类型与内容一致、不可变）
  const dlSrc = await api(src.download_url);
  assert.equal(dlSrc.status, 200);
  assert.equal(dlSrc.headers.get('content-type'), 'text/vtt; charset=utf-8');
  assert.equal(dlSrc.body, src.content);
  const dlEn = await api(en.download_url);
  assert.equal(dlEn.status, 200);
  assert.equal(dlEn.body, en.content);

  // 现有导出列表里同时可见（兼容旧序列）
  assert.equal((await api(`/api/projects/${pid}/exports`)).body[0].version, 1);
  assert.equal((await api(`/api/projects/${pid}/translations/en/exports`)).body[0].version, 1);
  assert.equal((await api(`/api/projects/${pid}/translations/fr/exports`)).body[0].version, 1);

  // 批次清单
  const list = await api(`/api/projects/${pid}/deliveries`);
  assert.equal(list.status, 200);
  assert.equal(list.body.batches.length, 1);
  assert.equal(list.body.batches[0].id, r.body.id);
  assert.equal(list.body.batches[0].note, '片方第一批');
  assert.equal(list.body.batches[0].files.length, 3);
  const one = await api(`/api/projects/${pid}/deliveries/${r.body.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.files.length, 3);
  assert.equal(one.body.files[1].download_url, en.download_url);
});

test('不可变：批次后编辑源/译文不改变旧批次文件；第二批在各序列取新版本', async () => {
  const { pid, body, cues } = await setupProject();
  const b1 = await api(`/api/projects/${pid}/deliveries`, 'POST', body());
  assert.equal(b1.status, 201);
  const oldEnUrl = b1.body.files.find((f) => f.lang === 'en').download_url;

  // 改原文（译文转复核）→ 确认英语、更新法语，再交付第二批
  const edit = await api(`/api/projects/${pid}/subtitles/${cues[0].id}`,
    'PATCH', { version: 1, text: '你好呀世界' });
  assert.equal(edit.status, 200);
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}/confirm`,
    'POST', { version: 1 }); // en cue0 → v2 current
  await api(`/api/projects/${pid}/translations/fr/subtitles/${cues[0].id}`,
    'PUT', { text: 'Bonjour!', cue_version: 2, version: 1 }); // fr cue0 → v2 current

  // 用旧清单重提：sub_version 漂移 → 409，不消耗版本
  const stale = await api(`/api/projects/${pid}/deliveries`, 'POST', body());
  assert.equal(stale.status, 409);

  const project = await api(`/api/projects/${pid}`);
  const viewEn = await api(`/api/projects/${pid}/translations/en`);
  const viewFr = await api(`/api/projects/${pid}/translations/fr`);
  const lines = (view) => view.body.entries
    .filter((e) => e.state === 'current' && e.valid)
    .map((e) => ({ subtitle_id: e.cue.id, version: e.translation.version }));
  const b2 = await api(`/api/projects/${pid}/deliveries`, 'POST', {
    sub_version: project.body.sub_version,
    rules_version: 1,
    languages: ['en', 'fr'],
    translations: { en: lines(viewEn), fr: lines(viewFr) },
  });
  assert.equal(b2.status, 201, JSON.stringify(b2.body));
  assert.equal(b2.body.files[0].version, 2);
  assert.equal(b2.body.files.find((f) => f.lang === 'en').version, 2);
  assert.equal(b2.body.files.find((f) => f.lang === 'fr').version, 2);
  assert.equal(b2.body.sub_version, project.body.sub_version);

  // 旧批次快照保持原样
  const oldEn = await api(oldEnUrl);
  assert.ok(oldEn.body.includes('Hello world'));
  assert.ok(!oldEn.body.includes('你好呀世界'), '译文快照不含原文');
  const oldBatch = await api(`/api/projects/${pid}/deliveries/${b1.body.id}`);
  assert.equal(oldBatch.body.files.find((f) => f.lang === 'en').version, 1);

  // 两个批次均在清单中（倒序）
  const list = await api(`/api/projects/${pid}/deliveries`);
  assert.deepEqual(list.body.batches.map((b) => b.id), [b2.body.id, b1.body.id]);
});

test('原子性：失败不生成任何快照、不消耗任何序列版本', async () => {
  const { pid, body, cues } = await setupProject();
  // fr 缺一行译文版本（清单只给 1 行）已在形状层拦截；这里制造 missing：
  // 新增一种未翻译语言
  const r = await api(`/api/projects/${pid}/deliveries`, 'POST', body({
    languages: ['en', 'fr', 'de'],
    translations: {
      en: body().translations.en,
      fr: body().translations.fr,
      de: cues.map((c) => ({ subtitle_id: c.id, version: 1 })),
    },
  }));
  assert.equal(r.status, 422);
  assert.equal((await api(`/api/projects/${pid}/exports`)).body.length, 0);
  assert.equal((await api(`/api/projects/${pid}/translations/en/exports`)).body.length, 0);
  assert.equal((await api(`/api/projects/${pid}/translations/fr/exports`)).body.length, 0);
  assert.equal((await api(`/api/projects/${pid}/translations/${enc('de')}/exports`)).body.length, 0);
  assert.equal((await api(`/api/projects/${pid}/deliveries`)).body.batches.length, 0);
});

test('兼容：既有原文导出与单语言导出流程不受批次影响', async () => {
  const { pid, body } = await setupProject();
  // 先批次
  const b = await api(`/api/projects/${pid}/deliveries`, 'POST', body());
  assert.equal(b.status, 201);
  // 再用既有单语言导出：按语言独立序列，批次已占 v1，本次为 v2
  const en2 = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(en2.status, 201);
  assert.equal(en2.body.version, 2);
  // 原文导出：批次已占 v1，本次为 v2
  const src2 = await api(`/api/projects/${pid}/exports`, 'POST', {});
  assert.equal(src2.status, 201);
  assert.equal(src2.body.version, 2);
  // 反向顺序同样成立：先单语言导出后批次取下一版本（另一项目验证）
  const created = await api('/api/projects', 'POST', { name: '兼容二', words: GOOD_WORDS, cuts: [1200] });
  const pid2 = created.body.id;
  const lay2 = await api(`/api/projects/${pid2}/layout`, 'POST', { sub_version: 0 });
  for (const c of lay2.body.subtitles) {
    await api(`/api/projects/${pid2}/translations/en/subtitles/${c.id}`, 'PUT', { text: 'Hi', cue_version: 1 });
  }
  const single = await api(`/api/projects/${pid2}/translations/en/exports`, 'POST', {});
  assert.equal(single.body.version, 1);
  const batch2 = await api(`/api/projects/${pid2}/deliveries`, 'POST', {
    sub_version: lay2.body.sub_version, rules_version: 1, languages: ['en'],
    translations: { en: lay2.body.subtitles.map((c) => ({ subtitle_id: c.id, version: 1 })) },
  });
  assert.equal(batch2.status, 201);
  assert.equal(batch2.body.files[0].version, 1, '原文序列从 v1 开始');
  assert.equal(batch2.body.files[1].version, 2, '译文序列在单语言导出 v1 之后取 v2');
});

test('清单查询：批次不存在 → 404', async () => {
  const { pid } = await setupProject();
  const r = await api(`/api/projects/${pid}/deliveries/9999`);
  assert.equal(r.status, 404);
});
