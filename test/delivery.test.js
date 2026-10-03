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
    name: '批次交付测试', words: GOOD_WORDS, cuts: [1200],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pid = created.body.id;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  return { pid, cues: layout.body.subtitles, sub_version: layout.body.sub_version };
}

/** 给两种语言各存一份当前有效译文，返回 { versions, sub_version, rules_version } 交付载荷片段 */
async function fillTranslations(pid, cues) {
  const texts = { en: ['Hello world', 'Welcome'], fr: ['Bonjour le monde', 'Bienvenue'] };
  const versions = { en: {}, fr: {} };
  for (const lang of Object.keys(texts)) {
    for (let i = 0; i < cues.length; i++) {
      const r = await api(`/api/projects/${pid}/translations/${lang}/subtitles/${cues[i].id}`,
        'PUT', { text: texts[lang][i], cue_version: cues[i].version });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      versions[lang][String(cues[i].id)] = r.body.translation.version;
    }
  }
  const proj = await api(`/api/projects/${pid}`);
  return {
    versions,
    sub_version: proj.body.sub_version,
    rules_version: proj.body.rules.version,
  };
}

function deliveryBody(ctx) {
  return {
    sub_version: ctx.sub_version,
    rules_version: ctx.rules_version,
    languages: ['en', 'fr'],
    versions: ctx.versions,
  };
}

// ---------- 请求形状（400） ----------

test('形状：空语言列表 / 重复语言 / 非法语言代号 / 缺版本表 → 400', async () => {
  const { pid, cues } = await setupProject();
  const ctx = await fillTranslations(pid, cues);

  const empty = await api(`/api/projects/${pid}/deliveries`, 'POST',
    { ...deliveryBody(ctx), languages: [] });
  assert.equal(empty.status, 400);
  assert.ok(empty.body.errors.some((e) => e.includes('非空数组')));

  const dup = await api(`/api/projects/${pid}/deliveries`, 'POST',
    { ...deliveryBody(ctx), languages: ['en', 'en'] });
  assert.equal(dup.status, 400);
  assert.ok(dup.body.errors.some((e) => e.includes('重复')));

  const badLang = await api(`/api/projects/${pid}/deliveries`, 'POST',
    { ...deliveryBody(ctx), languages: ['zh CN'] });
  assert.equal(badLang.status, 400);

  // 缺少 fr 的逐行版本表
  const noFr = await api(`/api/projects/${pid}/deliveries`, 'POST',
    { ...deliveryBody(ctx), versions: { en: ctx.versions.en } });
  assert.equal(noFr.status, 400);
  assert.ok(noFr.body.errors.some((e) => e.includes('versions.fr')));

  // versions 里出现未声明的语言
  const extra = await api(`/api/projects/${pid}/deliveries`, 'POST',
    { ...deliveryBody(ctx), versions: { ...ctx.versions, de: {} } });
  assert.equal(extra.status, 400);
  assert.ok(extra.body.errors.some((e) => e.includes('未在 languages 中声明')));

  // 译文版本非正整数 / 字幕键非法
  const badVer = await api(`/api/projects/${pid}/deliveries`, 'POST',
    { ...deliveryBody(ctx), versions: { en: { [cues[0].id]: 0 }, fr: ctx.versions.fr } });
  assert.equal(badVer.status, 400);
  const badKey = await api(`/api/projects/${pid}/deliveries`, 'POST',
    { ...deliveryBody(ctx), versions: { en: { abc: 1 }, fr: ctx.versions.fr } });
  assert.equal(badKey.status, 400);

  // sub_version / rules_version 形状
  const badSub = await api(`/api/projects/${pid}/deliveries`, 'POST',
    { ...deliveryBody(ctx), sub_version: 'x' });
  assert.equal(badSub.status, 400);
  const badRules = await api(`/api/projects/${pid}/deliveries`, 'POST',
    { ...deliveryBody(ctx), rules_version: 0 });
  assert.equal(badRules.status, 400);

  // 全部 400 都不得生成批次或消耗版本
  assert.equal((await api(`/api/projects/${pid}/deliveries`)).body.length, 0);
  assert.equal((await api(`/api/projects/${pid}/exports`)).body.length, 0);
});

// ---------- 版本漂移（409） ----------

test('字幕集版本 / 规则版本漂移 → 409 带当前值，不生成快照', async () => {
  const { pid, cues } = await setupProject();
  const ctx = await fillTranslations(pid, cues);

  const staleSub = await api(`/api/projects/${pid}/deliveries`, 'POST',
    { ...deliveryBody(ctx), sub_version: ctx.sub_version + 1 });
  assert.equal(staleSub.status, 409);
  assert.equal(staleSub.body.current.sub_version, ctx.sub_version);

  const staleRules = await api(`/api/projects/${pid}/deliveries`, 'POST',
    { ...deliveryBody(ctx), rules_version: ctx.rules_version + 1 });
  assert.equal(staleRules.status, 409);
  assert.equal(staleRules.body.current.rules_version, ctx.rules_version);

  // 改一次规则后旧 rules_version 失效
  await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: ctx.rules_version, max_chars: 30, min_duration_ms: 800, max_cps: 20,
  });
  const afterChange = await api(`/api/projects/${pid}/deliveries`, 'POST', deliveryBody(ctx));
  assert.equal(afterChange.status, 409);
  assert.equal((await api(`/api/projects/${pid}/deliveries`)).body.length, 0);
});

// ---------- 逐语言逐行问题（422） ----------

test('缺译 / 待复核 / 无效 / 译文版本漂移 / 未知行 → 422 按语言与字幕行分类，不消耗版本', async () => {
  const { pid, cues } = await setupProject();
  const ctx = await fillTranslations(pid, cues);

  // 1) fr 第二行译文被删除不了，改为：新起一行缺译 —— 通过重排制造缺译场景成本高，
  //    这里直接构造"提交版本表漏了一行"与"译文版本漂移"等场景。
  // 漏提交 en 第二行版本 → stale（未提交该行译文版本）
  const enPartial = { [String(cues[0].id)]: ctx.versions.en[String(cues[0].id)] };
  const miss = await api(`/api/projects/${pid}/deliveries`, 'POST',
    { ...deliveryBody(ctx), versions: { en: enPartial, fr: ctx.versions.fr } });
  assert.equal(miss.status, 422);
  const enReport = miss.body.languages.find((l) => l.lang === 'en');
  assert.equal(enReport.stale.length, 1);
  assert.equal(enReport.stale[0].subtitle_id, cues[1].id);
  assert.equal(enReport.stale[0].submitted_version, null);
  assert.equal(enReport.stale[0].current_version, ctx.versions.en[String(cues[1].id)]);

  // 2) 译文版本漂移：fr 第一行重新保存后版本 +1，仍按旧版本提交
  const resave = await api(`/api/projects/${pid}/translations/fr/subtitles/${cues[0].id}`,
    'PUT', { text: 'Bonjour monde', cue_version: 1, version: 1 });
  assert.equal(resave.status, 200);
  const drift = await api(`/api/projects/${pid}/deliveries`, 'POST', deliveryBody(ctx));
  assert.equal(drift.status, 422);
  const frDrift = drift.body.languages.find((l) => l.lang === 'fr');
  assert.equal(frDrift.stale.length, 1);
  assert.equal(frDrift.stale[0].subtitle_id, cues[0].id);
  assert.equal(frDrift.stale[0].submitted_version, 1);
  assert.equal(frDrift.stale[0].current_version, 2);

  // 3) 待复核：改 en 第一行原文 → en 该译文 review
  const proj1 = await api(`/api/projects/${pid}`);
  const edit = await api(`/api/projects/${pid}/subtitles/${cues[0].id}`,
    'PATCH', { version: 1, text: '你好世界呀' });
  assert.equal(edit.status, 200);
  const ctx2 = { ...ctx, sub_version: proj1.body.sub_version + 1 };
  const review = await api(`/api/projects/${pid}/deliveries`, 'POST', deliveryBody(ctx2));
  assert.equal(review.status, 422);
  const enReview = review.body.languages.find((l) => l.lang === 'en');
  assert.equal(enReview.review.length, 1);
  assert.equal(enReview.review[0].subtitle_id, cues[0].id);
  assert.equal(enReview.review[0].translation.status, 'review');

  // 4) 缺译：新语言 de 一行都没译
  const missing = await api(`/api/projects/${pid}/deliveries`, 'POST', {
    sub_version: edit.body.sub_version,
    rules_version: ctx.rules_version,
    languages: ['de'],
    versions: { de: {} },
  });
  assert.equal(missing.status, 422);
  const deReport = missing.body.languages.find((l) => l.lang === 'de');
  assert.equal(deReport.missing.length, 2);
  assert.deepEqual(deReport.missing.map((m) => m.subtitle_id).sort(), [cues[0].id, cues[1].id].sort());

  // 5) 未知行：提交版本表引用不存在的字幕 ID
  const unknown = await api(`/api/projects/${pid}/deliveries`, 'POST', {
    sub_version: edit.body.sub_version,
    rules_version: ctx.rules_version,
    languages: ['fr'],
    versions: { fr: { ...ctx.versions.fr, '99999': 1 } },
  });
  assert.equal(unknown.status, 422);
  const frUnknown = unknown.body.languages.find((l) => l.lang === 'fr');
  assert.equal(frUnknown.unknown.length, 1);
  assert.equal(frUnknown.unknown[0].subtitle_id, 99999);

  // 全部 422 不得生成批次或消耗任何导出序列版本
  assert.equal((await api(`/api/projects/${pid}/deliveries`)).body.length, 0);
  assert.equal((await api(`/api/projects/${pid}/exports`)).body.length, 0);
  assert.equal((await api(`/api/projects/${pid}/translations/en/exports`)).body.length, 0);
  assert.equal((await api(`/api/projects/${pid}/translations/fr/exports`)).body.length, 0);
});

test('无效译文（规则收紧后超限）→ 422 invalid；源整版规则冲突 → 422 conflicts', async () => {
  const { pid, cues } = await setupProject();
  const ctx = await fillTranslations(pid, cues);

  // 收紧 max_chars=10：译文 "Bonjour le monde"（16 字）超限，但源文 "你好世界"（4 字）仍合规
  await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: ctx.rules_version, max_chars: 10, min_duration_ms: 800, max_cps: 20,
  });
  const inv = await api(`/api/projects/${pid}/deliveries`, 'POST',
    { ...deliveryBody(ctx), rules_version: ctx.rules_version + 1 });
  assert.equal(inv.status, 422);
  const frInv = inv.body.languages.find((l) => l.lang === 'fr');
  assert.equal(frInv.invalid.length, 1);
  assert.equal(frInv.invalid[0].subtitle_id, cues[0].id);
  assert.ok(frInv.invalid[0].reasons.some((m) => m.includes('最大字数')));
  assert.equal(inv.body.conflicts.length, 0, '源文仍合规，不应有整版冲突');

  // 再收紧到 max_chars=2：源文也超限 → conflicts 非空
  await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: ctx.rules_version + 1, max_chars: 2, min_duration_ms: 800, max_cps: 20,
  });
  const both = await api(`/api/projects/${pid}/deliveries`, 'POST',
    { ...deliveryBody(ctx), rules_version: ctx.rules_version + 2 });
  assert.equal(both.status, 422);
  assert.ok(both.body.conflicts.length > 0);
  assert.equal((await api(`/api/projects/${pid}/deliveries`)).body.length, 0);
});

// ---------- 成功交付（201） ----------

test('成功：一次事务冻结原文+两种语言，批次清单关联文件/字幕集版本/规则版本', async () => {
  const { pid, cues } = await setupProject();
  const ctx = await fillTranslations(pid, cues);

  // 先做一次既有原文导出与一次单语言导出：批次应接着各自序列递增
  const preSrc = await api(`/api/projects/${pid}/exports`, 'POST', {});
  assert.equal(preSrc.status, 201);
  const preEn = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(preEn.status, 201);

  const r = await api(`/api/projects/${pid}/deliveries`, 'POST', deliveryBody(ctx));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const batchId = r.body.id;
  assert.ok(Number.isInteger(batchId) && batchId > 0);
  assert.equal(r.body.sub_version, ctx.sub_version);
  assert.equal(r.body.rules_version, ctx.rules_version);
  assert.equal(r.body.cue_count, 2);
  assert.equal(r.body.files.length, 3);

  const src = r.body.files.find((f) => f.kind === 'source');
  const en = r.body.files.find((f) => f.kind === 'translation' && f.lang === 'en');
  const fr = r.body.files.find((f) => f.kind === 'translation' && f.lang === 'fr');
  assert.equal(src.version, 2, '原文导出序列在既有 v1 之后递增');
  assert.equal(en.version, 2, 'en 译文序列在既有 v1 之后递增');
  assert.equal(fr.version, 1, 'fr 译文序列独立从 v1 开始');
  assert.equal(src.download_url, `/api/projects/${pid}/exports/2`);
  assert.equal(en.download_url, `/api/projects/${pid}/translations/en/exports/2`);
  assert.equal(fr.download_url, `/api/projects/${pid}/translations/fr/exports/1`);

  // 各文件时间轴一致：下载三个文件，时间戳行完全相同
  const dl = async (url) => (await api(url)).body;
  const [srcVtt, enVtt, frVtt] = await Promise.all([
    dl(src.download_url), dl(en.download_url), dl(fr.download_url),
  ]);
  const timeline = (vtt) => vtt.split('\n').filter((l) => l.includes('-->'));
  assert.deepEqual(timeline(enVtt), timeline(srcVtt));
  assert.deepEqual(timeline(frVtt), timeline(srcVtt));
  assert.ok(srcVtt.includes('你好世界'));
  assert.ok(enVtt.includes('Hello world') && !enVtt.includes('你好'));
  assert.ok(frVtt.includes('Bonjour le monde'));

  // 批次清单可查询：列表 + 单个
  const list = await api(`/api/projects/${pid}/deliveries`);
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].files.length, 3);
  const one = await api(`/api/projects/${pid}/deliveries/${batchId}`);
  assert.equal(one.status, 200);
  assert.deepEqual(one.body, r.body);
  const ghost = await api(`/api/projects/${pid}/deliveries/999`);
  assert.equal(ghost.status, 404);

  // 项目载荷携带批次清单
  const proj = await api(`/api/projects/${pid}`);
  assert.equal(proj.body.deliveries.length, 1);
});

test('成功：后续编辑不改变旧批次文件；既有导出/下载约定保持兼容', async () => {
  const { pid, cues } = await setupProject();
  const ctx = await fillTranslations(pid, cues);
  const r = await api(`/api/projects/${pid}/deliveries`, 'POST', deliveryBody(ctx));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const src = r.body.files.find((f) => f.kind === 'source');
  const en = r.body.files.find((f) => f.lang === 'en');
  const before = {
    src: (await api(src.download_url)).body,
    en: (await api(en.download_url)).body,
  };

  // 修改源字幕（译文转 review）并重新保存译文，再交付第二批
  const edit = await api(`/api/projects/${pid}/subtitles/${cues[0].id}`,
    'PATCH', { version: 1, text: '你好世界呀' });
  assert.equal(edit.status, 200);
  const upd = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hi world', cue_version: 2, version: 1 });
  assert.equal(upd.status, 200);
  const updFr = await api(`/api/projects/${pid}/translations/fr/subtitles/${cues[0].id}`,
    'PUT', { text: 'Salut monde', cue_version: 2, version: 1 });
  assert.equal(updFr.status, 200);

  const ctx2 = {
    sub_version: edit.body.sub_version,
    rules_version: ctx.rules_version,
    versions: {
      en: { ...ctx.versions.en, [cues[0].id]: 2 },
      fr: { ...ctx.versions.fr, [cues[0].id]: 2 },
    },
  };
  const r2 = await api(`/api/projects/${pid}/deliveries`, 'POST', {
    sub_version: ctx2.sub_version, rules_version: ctx2.rules_version,
    languages: ['en', 'fr'], versions: ctx2.versions,
  });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.ok(r2.body.id > r.body.id, '批次号全局递增');
  assert.equal(r2.body.files.find((f) => f.kind === 'source').version, 2);

  // 第一批文件内容不变（不可变快照）
  assert.equal((await api(src.download_url)).body, before.src);
  assert.equal((await api(en.download_url)).body, before.en);
  assert.ok(!(await api(src.download_url)).body.includes('你好世界呀'));

  // 第二批反映新内容
  const src2 = r2.body.files.find((f) => f.kind === 'source');
  assert.ok((await api(src2.download_url)).body.includes('你好世界呀'));

  // 既有单语言导出与原文导出仍可用，版本号在各自序列上继续递增
  const enSolo = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(enSolo.status, 201);
  assert.equal(enSolo.body.version, 3, 'en 序列：单语言导出接着批次生成的 v2 递增');
  const srcSolo = await api(`/api/projects/${pid}/exports`, 'POST', {});
  assert.equal(srcSolo.status, 201);
  assert.equal(srcSolo.body.version, 3);

  // 批次清单仍只有两批，单语言/原文单独导出不产生批次
  assert.equal((await api(`/api/projects/${pid}/deliveries`)).body.length, 2);
});

test('批次交付不推进字幕集版本；失败批次不消耗版本号', async () => {
  const { pid, cues } = await setupProject();
  const ctx = await fillTranslations(pid, cues);

  // 先失败一次（译文版本漂移）
  const bad = await api(`/api/projects/${pid}/deliveries`, 'POST', {
    ...deliveryBody(ctx),
    versions: { en: ctx.versions.en, fr: { ...ctx.versions.fr, [cues[0].id]: 99 } },
  });
  assert.equal(bad.status, 422);

  // 成功交付：版本号从 v1 开始（未被失败消耗）
  const ok = await api(`/api/projects/${pid}/deliveries`, 'POST', deliveryBody(ctx));
  assert.equal(ok.status, 201);
  assert.equal(ok.body.files.find((f) => f.kind === 'source').version, 1);
  assert.equal(ok.body.files.find((f) => f.lang === 'en').version, 1);

  // 交付本身不修改字幕集
  const proj = await api(`/api/projects/${pid}`);
  assert.equal(proj.body.sub_version, ctx.sub_version);
});
