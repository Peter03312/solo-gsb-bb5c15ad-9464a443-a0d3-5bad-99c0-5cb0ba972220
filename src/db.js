'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  sub_version INTEGER NOT NULL DEFAULT 0,   -- 字幕集每次变更（编辑/锁定/重排）都 +1，用于乐观锁
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS words (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  text       TEXT NOT NULL,
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL,
  UNIQUE(project_id, idx)
);

CREATE TABLE IF NOT EXISTS shots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  cut_ms     INTEGER NOT NULL,
  UNIQUE(project_id, idx)
);

CREATE TABLE IF NOT EXISTS rules (
  project_id      INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL DEFAULT 1,  -- 每次修改 +1，提交时携带以拒绝过期写入
  max_chars       INTEGER NOT NULL,
  min_duration_ms INTEGER NOT NULL,
  max_cps         REAL NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subtitles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,               -- 展示顺序（按时间升序）
  word_start INTEGER NOT NULL,               -- 覆盖的词区间 [word_start, word_end]
  word_end   INTEGER NOT NULL,
  text       TEXT NOT NULL,
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL,
  locked     INTEGER NOT NULL DEFAULT 0,
  version    INTEGER NOT NULL DEFAULT 1,     -- 行级乐观锁
  UNIQUE(project_id, idx)
);

CREATE TABLE IF NOT EXISTS exports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,               -- 项目内递增，确认一次 +1
  content    TEXT NOT NULL,                  -- WebVTT 快照，确认后不再改变
  cue_count  INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, version)
);

-- 校对者批量修订提议：一组针对未锁定字幕的待采纳修订
CREATE TABLE IF NOT EXISTS revisions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id             INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  note                   TEXT NOT NULL DEFAULT '',   -- 校对说明
  rules_version_snapshot INTEGER NOT NULL,           -- 提议保存时的规则版本
  sub_version_snapshot   INTEGER NOT NULL,           -- 提议保存时的字幕集版本
  status                 TEXT NOT NULL DEFAULT 'pending', -- pending（待采纳）/ accepted（已采纳）
  accepted_at            TEXT,
  accepted_sub_version   INTEGER,                    -- 采纳后字幕集推进到的版本
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS revision_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id   INTEGER NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  ord           INTEGER NOT NULL,               -- 组内顺序
  subtitle_id   INTEGER NOT NULL,               -- 目标字幕 ID（提交时存在且未锁定）
  cue_version   INTEGER NOT NULL,               -- 校对者读取该行时的版本号
  orig_text     TEXT NOT NULL,                  -- 原值快照
  orig_start_ms INTEGER NOT NULL,
  orig_end_ms   INTEGER NOT NULL,
  proposed_text TEXT NOT NULL,                  -- 替代文本
  start_ms      INTEGER,                        -- 可选：替代开始毫秒，NULL 表示沿用原值
  end_ms        INTEGER,                        -- 可选：替代结束毫秒，NULL 表示沿用原值
  UNIQUE(revision_id, ord)
);

-- 校对者逐词时间修正提议：按词序号提交一组起止毫秒，确认后才更新 words 并重排受影响区间
CREATE TABLE IF NOT EXISTS word_revisions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id             INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  note                   TEXT NOT NULL DEFAULT '',    -- 校对说明
  sub_version_snapshot   INTEGER NOT NULL,            -- 校对者读取字幕集时的 sub_version
  status                 TEXT NOT NULL DEFAULT 'pending', -- pending（待确认）/ confirmed（已确认）
  confirmed_at           TEXT,
  confirmed_sub_version  INTEGER,                     -- 确认后字幕集推进到的版本
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS word_revision_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  word_revision_id INTEGER NOT NULL REFERENCES word_revisions(id) ON DELETE CASCADE,
  ord             INTEGER NOT NULL,           -- 组内顺序
  word_idx        INTEGER NOT NULL,           -- 词序号（words.idx，词序与词文本不可变）
  orig_start_ms   INTEGER NOT NULL,           -- 读取时原开始毫秒快照
  orig_end_ms     INTEGER NOT NULL,           -- 读取时原结束毫秒快照
  start_ms        INTEGER NOT NULL,           -- 修正后开始毫秒
  end_ms          INTEGER NOT NULL,           -- 修正后结束毫秒
  UNIQUE(word_revision_id, ord)
);

-- 多语言译文字幕：译文沿用源字幕的起止时间与词区间，本身不携带任何时间/切点/原文。
-- 同一语言、每条当前字幕最多一份非历史译文（由下方部分唯一索引强制）。
--   current  当前有效（源文本/时间/词区间与快照一致且满足现行规则）
--   review   待复核（保存后源字幕文本、时间或词区间发生变化；仅锁定/展示顺序变化不进入此态）
--   history  历史（源字幕行被重排删除或重新导入；subtitle_id 置空，不自动挪用到新行）
CREATE TABLE IF NOT EXISTS translations (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id           INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  lang                 TEXT NOT NULL,                -- 非空目标语言代号（如 en / ja-JP）
  subtitle_id          INTEGER REFERENCES subtitles(id) ON DELETE SET NULL, -- 当前源字幕；行删除后留空作历史
  text                 TEXT NOT NULL,                -- 译文文本（不改动源字幕的任何内容）
  status               TEXT NOT NULL DEFAULT 'current',
  version              INTEGER NOT NULL DEFAULT 1,   -- 译文版本（保存修改时携带，乐观锁）
  cue_version_snapshot INTEGER NOT NULL,             -- 保存/确认时读取的源字幕行版本
  src_text             TEXT NOT NULL,                -- 保存时源字幕文本快照
  src_start_ms         INTEGER NOT NULL,             -- 保存时源字幕开始毫秒快照
  src_end_ms           INTEGER NOT NULL,             -- 保存时源字幕结束毫秒快照
  src_word_start       INTEGER NOT NULL,             -- 保存时源字幕词区间快照
  src_word_end         INTEGER NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 同一语言每条当前字幕最多一份译文（历史行 subtitle_id 已置空，不参与唯一约束）
CREATE UNIQUE INDEX IF NOT EXISTS idx_translations_one_per_cue
  ON translations(project_id, lang, subtitle_id)
  WHERE status != 'history';
CREATE INDEX IF NOT EXISTS idx_translations_project_lang
  ON translations(project_id, lang, status);

-- 按语言导出的不可变 WebVTT 快照（与原文导出 exports 互不影响）
CREATE TABLE IF NOT EXISTS translation_exports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  lang       TEXT NOT NULL,
  version    INTEGER NOT NULL,               -- 项目内按语言递增，确认一次 +1
  content    TEXT NOT NULL,                  -- WebVTT 快照，确认后不再改变
  cue_count  INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, lang, version)
);
`;

const DEFAULT_RULES = { max_chars: 30, min_duration_ms: 800, max_cps: 20 };

function initDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  return db;
}

/** 项目完整载荷：项目 + 词 + 切点 + 规则 + 字幕 + 导出版本列表 */
function loadProject(db, id) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) return null;
  const words = db.prepare(
    'SELECT idx, text, start_ms, end_ms FROM words WHERE project_id = ? ORDER BY idx'
  ).all(id);
  const cuts = db.prepare(
    'SELECT cut_ms FROM shots WHERE project_id = ? ORDER BY idx'
  ).all(id).map((r) => r.cut_ms);
  const rules = db.prepare('SELECT * FROM rules WHERE project_id = ?').get(id);
  const subtitles = db.prepare(
    `SELECT id, idx, word_start, word_end, text, start_ms, end_ms, locked, version
     FROM subtitles WHERE project_id = ? ORDER BY idx`
  ).all(id);
  const exportsList = db.prepare(
    'SELECT version, cue_count, created_at FROM exports WHERE project_id = ? ORDER BY version DESC'
  ).all(id);
  const revisions = listRevisions(db, id);
  const wordRevisions = listWordRevisions(db, id);
  return {
    id: project.id,
    name: project.name,
    sub_version: project.sub_version,
    created_at: project.created_at,
    words,
    cuts,
    rules: rules
      ? { version: rules.version, max_chars: rules.max_chars,
          min_duration_ms: rules.min_duration_ms, max_cps: rules.max_cps }
      : null,
    subtitles,
    exports: exportsList,
    revisions,
    word_revisions: wordRevisions,
  };
}

/** 项目下全部修订提议摘要（不含逐项明细），按时间倒序 */
function listRevisions(db, projectId) {
  return db.prepare(
    `SELECT r.id, r.note, r.status, r.rules_version_snapshot, r.sub_version_snapshot,
            r.accepted_sub_version, r.created_at, r.accepted_at,
            (SELECT COUNT(*) FROM revision_items i WHERE i.revision_id = r.id) AS item_count
     FROM revisions r WHERE r.project_id = ? ORDER BY r.id DESC`
  ).all(projectId);
}

/**
 * 读取一个修订提议（含逐项明细）。不存在或不属于该项目返回 null。
 * 每项同时给出 orig_*（提交时原值）、proposed_*（建议值，start_ms/end_ms 为 null 表示沿用原值）。
 */
function loadRevision(db, projectId, revisionId) {
  const head = db.prepare('SELECT * FROM revisions WHERE id = ? AND project_id = ?')
    .get(revisionId, projectId);
  if (!head) return null;
  const items = db.prepare(
    'SELECT * FROM revision_items WHERE revision_id = ? ORDER BY ord'
  ).all(revisionId);
  return {
    id: head.id,
    project_id: head.project_id,
    note: head.note,
    status: head.status,
    rules_version_snapshot: head.rules_version_snapshot,
    sub_version_snapshot: head.sub_version_snapshot,
    accepted_sub_version: head.accepted_sub_version,
    created_at: head.created_at,
    accepted_at: head.accepted_at,
    items: items.map((it) => ({
      ord: it.ord,
      subtitle_id: it.subtitle_id,
      cue_version: it.cue_version,
      orig: { text: it.orig_text, start_ms: it.orig_start_ms, end_ms: it.orig_end_ms },
      proposed: {
        text: it.proposed_text,
        start_ms: it.start_ms,
        end_ms: it.end_ms,
        has_start_ms: it.start_ms !== null,
        has_end_ms: it.end_ms !== null,
      },
    })),
  };
}

function bumpSubVersion(db, projectId) {
  db.prepare('UPDATE projects SET sub_version = sub_version + 1 WHERE id = ?').run(projectId);
  return db.prepare('SELECT sub_version FROM projects WHERE id = ?').get(projectId).sub_version;
}

/** 项目下全部逐词修正提议摘要（不含逐项明细），按时间倒序 */
function listWordRevisions(db, projectId) {
  return db.prepare(
    `SELECT r.id, r.note, r.status, r.sub_version_snapshot,
            r.confirmed_sub_version, r.created_at, r.confirmed_at,
            (SELECT COUNT(*) FROM word_revision_items i WHERE i.word_revision_id = r.id) AS item_count
     FROM word_revisions r WHERE r.project_id = ? ORDER BY r.id DESC`
  ).all(projectId);
}

/**
 * 读取一个逐词修正提议（含逐项明细，并附带各词当前文本/时间，便于预览并列原值/当前值）。
 * 不存在或不属于该项目返回 null。
 */
function loadWordRevision(db, projectId, revisionId) {
  const head = db.prepare('SELECT * FROM word_revisions WHERE id = ? AND project_id = ?')
    .get(revisionId, projectId);
  if (!head) return null;
  const items = db.prepare(
    `SELECT i.ord, i.word_idx, i.orig_start_ms, i.orig_end_ms, i.start_ms, i.end_ms,
            w.text AS word_text, w.start_ms AS cur_start_ms, w.end_ms AS cur_end_ms
       FROM word_revision_items i
       LEFT JOIN words w ON w.project_id = ? AND w.idx = i.word_idx
      WHERE i.word_revision_id = ? ORDER BY i.ord`
  ).all(projectId, revisionId);
  return {
    id: head.id,
    project_id: head.project_id,
    note: head.note,
    status: head.status,
    sub_version_snapshot: head.sub_version_snapshot,
    confirmed_sub_version: head.confirmed_sub_version,
    created_at: head.created_at,
    confirmed_at: head.confirmed_at,
    items: items.map((it) => ({
      ord: it.ord,
      word_idx: it.word_idx,
      word_text: it.word_text ?? null,        // 重新导入后可能已不存在
      orig: { start_ms: it.orig_start_ms, end_ms: it.orig_end_ms },
      proposed: { start_ms: it.start_ms, end_ms: it.end_ms },
      current: it.word_text === null
        ? null
        : { text: it.word_text, start_ms: it.cur_start_ms, end_ms: it.cur_end_ms },
    })),
  };
}

module.exports = {
  initDb, loadProject, listRevisions, loadRevision,
  listWordRevisions, loadWordRevision, bumpSubVersion, DEFAULT_RULES,
};
