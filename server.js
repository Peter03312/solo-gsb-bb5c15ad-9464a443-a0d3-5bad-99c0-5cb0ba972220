'use strict';

const path = require('path');
const express = require('express');
const { initDb, loadProject, DEFAULT_RULES } = require('./src/db');
const { createApp } = require('./src/routes');
const { computeLayout } = require('./src/layout');

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'subtitles.db');
const SEED_DEMO = (process.env.SEED_DEMO || 'true').toLowerCase() !== 'false';

const db = initDb(DB_PATH);

/** 首次启动时播种一个演示项目（词 + 切点 + 默认规则 + 自动排版），便于开箱体验 */
function seedDemo() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
  if (count > 0) return;
  // 与 examples/sample.json 相同的数据
  const sample = require('./examples/sample.json');
  const tx = db.transaction(() => {
    const pid = db.prepare('INSERT INTO projects (name) VALUES (?)').run('演示项目：江边茶馆').lastInsertRowid;
    db.prepare(
      'INSERT INTO rules (project_id, max_chars, min_duration_ms, max_cps) VALUES (?, ?, ?, ?)'
    ).run(pid, DEFAULT_RULES.max_chars, DEFAULT_RULES.min_duration_ms, DEFAULT_RULES.max_cps);
    const insW = db.prepare('INSERT INTO words (project_id, idx, text, start_ms, end_ms) VALUES (?, ?, ?, ?, ?)');
    sample.words.forEach((w, i) => insW.run(pid, i, w.text, w.start_ms, w.end_ms));
    const insC = db.prepare('INSERT INTO shots (project_id, idx, cut_ms) VALUES (?, ?, ?)');
    sample.cuts.forEach((ms, i) => insC.run(pid, i, ms));
    return pid;
  });
  const pid = tx();
  // 自动排版一次，让首页直接看到结果
  const p = loadProject(db, pid);
  const result = computeLayout({ words: p.words, cuts: p.cuts, rules: p.rules, locked: [] });
  if (result.ok) {
    const tx2 = db.transaction(() => {
      const ins = db.prepare(
        `INSERT INTO subtitles (project_id, idx, word_start, word_end, text, start_ms, end_ms, locked)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
      );
      result.cues.forEach((c, i) => ins.run(pid, i, c.word_start, c.word_end, c.text, c.start_ms, c.end_ms));
      db.prepare('UPDATE projects SET sub_version = sub_version + 1 WHERE id = ?').run(pid);
    });
    tx2();
  }
  console.log(`[seed] 已创建演示项目 #${pid}（${sample.words.length} 词 / ${sample.cuts.length} 切点）`);
}

if (SEED_DEMO) seedDemo();

const app = createApp(db);
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`字幕校时工作台已启动: http://localhost:${PORT}`);
  console.log(`数据库文件: ${DB_PATH}`);
});
