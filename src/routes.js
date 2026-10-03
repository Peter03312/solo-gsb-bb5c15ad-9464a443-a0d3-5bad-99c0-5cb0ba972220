'use strict';

const express = require('express');
const {
  loadProject, listRevisions, loadRevision,
  listWordRevisions, loadWordRevision, bumpSubVersion,
  listDeliveries, loadDelivery, DEFAULT_RULES,
} = require('./db');
const { computeLayout, validateStructure, validateRules } = require('./layout');
const { validateWords, validateCuts, validateRules: validateRulesInput, validateSubtitleEdit } = require('./validate');
const { parseRevisionItems, evaluateRevision } = require('./revision');
const { parseWordRevisionItems, evaluateWordRevision } = require('./word-revision');
const {
  normalizeLang, parseTranslationBody, parseConfirmBody, checkTranslationText,
  syncTranslations, buildLangView, listLanguages, evaluateExport, mapRow,
} = require('./translation');
const { parseDeliveryBody, evaluateDelivery } = require('./delivery');
const { toWebVtt } = require('./vtt');

/**
 * 挂载 API 路由。统一错误格式：
 *   400 { error }                 请求体非法
 *   404 { error }                 资源不存在
 *   409 { error, current }        版本过期，current 为当前内容
 *   422 { error, errors|conflicts } 校验失败 / 规则冲突
 */
function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  const getProject = (req, res) => {
    const p = loadProject(db, Number(req.params.id));
    if (!p) {
      res.status(404).json({ error: `项目 ${req.params.id} 不存在` });
      return null;
    }
    return p;
  };

  // ---------- 项目 ----------

  app.get('/api/projects', (req, res) => {
    const rows = db.prepare(
      `SELECT p.id, p.name, p.created_at,
              (SELECT COUNT(*) FROM words w WHERE w.project_id = p.id)  AS word_count,
              (SELECT COUNT(*) FROM subtitles s WHERE s.project_id = p.id) AS cue_count,
              (SELECT COUNT(*) FROM exports e WHERE e.project_id = p.id)   AS export_count
       FROM projects p ORDER BY p.id DESC`
    ).all();
    res.json(rows);
  });

  app.post('/api/projects', (req, res) => {
    const { name, words, cuts, rules } = req.body || {};
    if (typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ error: 'name 必须是非空字符串' });
    }
    let wordRows = null;
    let cutList = [];
    if (words !== undefined) {
      const w = validateWords(words);
      if (!w.ok) return res.status(422).json({ error: '逐词转写校验失败，拒绝导入', errors: w.errors });
      wordRows = words.map((x) => ({ text: x.text.trim(), start_ms: x.start_ms, end_ms: x.end_ms }));
    }
    const c = validateCuts(cuts);
    if (!c.ok) return res.status(422).json({ error: '镜头切点校验失败，拒绝导入', errors: c.errors });
    cutList = c.cuts;
    const ruleValues = rules !== undefined ? rules : DEFAULT_RULES;
    const rv = validateRulesInput(ruleValues);
    if (!rv.ok) return res.status(422).json({ error: '排版规则校验失败', errors: rv.errors });

    const tx = db.transaction(() => {
      const info = db.prepare('INSERT INTO projects (name) VALUES (?)').run(name.trim());
      const pid = info.lastInsertRowid;
      db.prepare(
        'INSERT INTO rules (project_id, max_chars, min_duration_ms, max_cps) VALUES (?, ?, ?, ?)'
      ).run(pid, ruleValues.max_chars, ruleValues.min_duration_ms, ruleValues.max_cps);
      if (wordRows) {
        const ins = db.prepare('INSERT INTO words (project_id, idx, text, start_ms, end_ms) VALUES (?, ?, ?, ?, ?)');
        wordRows.forEach((w, i) => ins.run(pid, i, w.text, w.start_ms, w.end_ms));
      }
      const insCut = db.prepare('INSERT INTO shots (project_id, idx, cut_ms) VALUES (?, ?, ?)');
      cutList.forEach((ms, i) => insCut.run(pid, i, ms));
      return pid;
    });
    const pid = tx();
    res.status(201).json(loadProject(db, pid));
  });

  app.get('/api/projects/:id', (req, res) => {
    const p = getProject(req, res);
    if (p) res.json(p);
  });

  // ---------- 导入（替换转写与切点） ----------

  app.post('/api/projects/:id/import', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const { words, cuts, force } = req.body || {};
    const w = validateWords(words);
    if (!w.ok) return res.status(422).json({ error: '逐词转写校验失败，拒绝导入', errors: w.errors });
    const c = validateCuts(cuts);
    if (!c.ok) return res.status(422).json({ error: '镜头切点校验失败，拒绝导入', errors: c.errors });

    const cueCount = db.prepare('SELECT COUNT(*) AS n FROM subtitles WHERE project_id = ?').get(p.id).n;
    if (cueCount > 0 && !force) {
      return res.status(409).json({
        error: `项目已有 ${cueCount} 条字幕，重新导入将清空全部字幕（含已锁定）。确认请携带 {"force": true}`,
        cue_count: cueCount,
      });
    }
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM subtitles WHERE project_id = ?').run(p.id);
      db.prepare('DELETE FROM words WHERE project_id = ?').run(p.id);
      db.prepare('DELETE FROM shots WHERE project_id = ?').run(p.id);
      const ins = db.prepare('INSERT INTO words (project_id, idx, text, start_ms, end_ms) VALUES (?, ?, ?, ?, ?)');
      words.forEach((x, i) => ins.run(p.id, i, x.text.trim(), x.start_ms, x.end_ms));
      const insCut = db.prepare('INSERT INTO shots (project_id, idx, cut_ms) VALUES (?, ?, ?)');
      c.cuts.forEach((ms, i) => insCut.run(p.id, i, ms));
      bumpSubVersion(db, p.id);
    });
    tx();
    // 旧字幕行已全部删除：各语言译文全部留作历史（不按序号挪用到新排版的行）
    syncTranslations(db, p.id);
    res.json(loadProject(db, p.id));
  });

  // ---------- 规则（版本号拒绝过期提交） ----------

  app.put('/api/projects/:id/rules', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const { version, max_chars, min_duration_ms, max_cps } = req.body || {};
    const current = db.prepare('SELECT * FROM rules WHERE project_id = ?').get(p.id);
    if (version !== current.version) {
      return res.status(409).json({
        error: `规则版本过期：你基于 v${version} 修改，但当前已是 v${current.version}`,
        current: {
          version: current.version, max_chars: current.max_chars,
          min_duration_ms: current.min_duration_ms, max_cps: current.max_cps,
        },
      });
    }
    const rv = validateRulesInput({ max_chars, min_duration_ms, max_cps });
    if (!rv.ok) return res.status(422).json({ error: '排版规则校验失败', errors: rv.errors });
    db.prepare(
      `UPDATE rules SET version = version + 1, max_chars = ?, min_duration_ms = ?, max_cps = ?,
       updated_at = datetime('now') WHERE project_id = ?`
    ).run(max_chars, min_duration_ms, max_cps, p.id);
    res.json(loadProject(db, p.id).rules);
  });

  // ---------- 重排（只改未锁定部分） ----------

  app.post('/api/projects/:id/layout', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const { sub_version } = req.body || {};
    if (sub_version !== p.sub_version) {
      return res.status(409).json({
        error: `字幕集已被修改（当前版本 ${p.sub_version}），请刷新后重试`,
        current: { sub_version: p.sub_version, subtitles: p.subtitles },
      });
    }
    if (p.words.length === 0) {
      return res.status(422).json({ error: '尚未导入逐词转写，无法排版', conflicts: [] });
    }
    const locked = p.subtitles.filter((s) => s.locked === 1);
    const result = computeLayout({ words: p.words, cuts: p.cuts, rules: p.rules, locked });
    if (!result.ok) {
      return res.status(422).json({
        error: `排版规则无法同时满足，共 ${result.conflicts.length} 处冲突；未改动任何字幕`,
        conflicts: result.conflicts,
      });
    }
    const tx = db.transaction(() => {
      // 身份保持：以词区间为身份。
      //   锁定行与内容完全一致的行 → 保留 ID/版本，只更新展示顺序 idx
      //     （仅锁定或展示顺序变化不使译文失效）；
      //   词区间相同但文本/时间变化的未锁定行 → 原地更新，行版本 +1
      //     （事务提交后由 syncTranslations 把其译文转待复核）；
      //   旧版中存在、候选整版已消失的未锁定行 → 删除（其译文留作历史）；
      //   候选整版中的新行 → INSERT 新 ID（视为缺译，绝不按序号挪用旧译文）。
      const lockedByKey = new Map(locked.map((s) => [`${s.word_start}:${s.word_end}`, s]));
      const oldUnlockedByKey = new Map(
        p.subtitles.filter((s) => s.locked === 0)
          .map((s) => [`${s.word_start}:${s.word_end}`, s])
      );
      const ins = db.prepare(
        `INSERT INTO subtitles (project_id, idx, word_start, word_end, text, start_ms, end_ms, locked)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
      );
      const updIdx = db.prepare('UPDATE subtitles SET idx = ? WHERE id = ?');
      const updCue = db.prepare(
        `UPDATE subtitles SET idx = ?, text = ?, start_ms = ?, end_ms = ?, version = version + 1
         WHERE id = ?`
      );
      // 先把全部现存行 idx 挪到负临时值，避免 UNIQUE(project_id, idx) 与 0 起正式 idx 撞号
      db.prepare('UPDATE subtitles SET idx = -id - 1 WHERE project_id = ?').run(p.id);
      const usedIds = new Set();
      result.cues.forEach((cue, i) => {
        const key = `${cue.word_start}:${cue.word_end}`;
        const keptLocked = lockedByKey.get(key);
        if (keptLocked) {
          usedIds.add(keptLocked.id);
          updIdx.run(i, keptLocked.id);
          return;
        }
        const oldCue = oldUnlockedByKey.get(key);
        if (oldCue &&
            oldCue.text === cue.text &&
            oldCue.start_ms === cue.start_ms &&
            oldCue.end_ms === cue.end_ms) {
          usedIds.add(oldCue.id);
          updIdx.run(i, oldCue.id);
        } else if (oldCue) {
          usedIds.add(oldCue.id);
          updCue.run(i, cue.text, cue.start_ms, cue.end_ms, oldCue.id);
        } else {
          ins.run(p.id, i, cue.word_start, cue.word_end, cue.text, cue.start_ms, cue.end_ms);
        }
      });
      // 已消失的旧未锁定行：删除（其译文在 syncTranslations 中留作历史，不按序号挪用）
      const stale = p.subtitles.filter((s) => s.locked === 0 && !usedIds.has(s.id));
      const del = db.prepare('DELETE FROM subtitles WHERE id = ? AND project_id = ? AND locked = 0');
      stale.forEach((s) => del.run(s.id, p.id));
      bumpSubVersion(db, p.id);
    });
    tx();
    syncTranslations(db, p.id);
    const fresh = loadProject(db, p.id);
    res.json({ sub_version: fresh.sub_version, subtitles: fresh.subtitles });
  });

  // ---------- 单条字幕编辑 / 锁定（行级版本号） ----------

  app.patch('/api/projects/:id/subtitles/:sid', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const sid = Number(req.params.sid);
    const row = db.prepare('SELECT * FROM subtitles WHERE id = ? AND project_id = ?').get(sid, p.id);
    if (!row) return res.status(404).json({ error: `字幕 ${req.params.sid} 不存在` });

    const { version, text, start_ms, end_ms, locked } = req.body || {};
    if (version !== row.version) {
      return res.status(409).json({
        error: `字幕版本过期：你基于 v${version} 修改，但当前已是 v${row.version}`,
        current: row,
      });
    }

    const newText = text !== undefined ? String(text) : row.text;
    const newStart = start_ms !== undefined ? start_ms : row.start_ms;
    const newEnd = end_ms !== undefined ? end_ms : row.end_ms;
    const newLocked = locked !== undefined ? (locked ? 1 : 0) : row.locked;

    if (newText.trim() === '') {
      return res.status(422).json({ error: '字幕文本不能为空', errors: ['字幕文本不能为空'] });
    }
    if (start_ms !== undefined || end_ms !== undefined) {
      const neighbors = {
        prev: db.prepare(
          'SELECT start_ms, end_ms FROM subtitles WHERE project_id = ? AND idx < ? ORDER BY idx DESC LIMIT 1'
        ).get(p.id, row.idx) || null,
        next: db.prepare(
          'SELECT start_ms, end_ms FROM subtitles WHERE project_id = ? AND idx > ? ORDER BY idx LIMIT 1'
        ).get(p.id, row.idx) || null,
      };
      const errors = validateSubtitleEdit(
        { start_ms: newStart, end_ms: newEnd },
        { word_start: row.word_start, word_end: row.word_end },
        p.words, p.cuts, neighbors
      );
      if (errors.length > 0) {
        return res.status(422).json({ error: '字幕时间校验失败', errors });
      }
    }

    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE subtitles SET text = ?, start_ms = ?, end_ms = ?, locked = ?, version = version + 1
         WHERE id = ?`
      ).run(newText, newStart, newEnd, newLocked, sid);
      bumpSubVersion(db, p.id);
    });
    tx();
    // 源字幕文本/时间变化 → 各语言该条译文转待复核；仅锁定切换（内容一致）不失效
    syncTranslations(db, p.id);
    const fresh = loadProject(db, p.id);
    res.json({ sub_version: fresh.sub_version, subtitle: fresh.subtitles.find((s) => s.id === sid) });
  });

  // ---------- 导出（确认后生成不可变快照） ----------

  app.post('/api/projects/:id/exports', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    // 可选的乐观锁：携带 sub_version 时校验，防止导出与界面不一致的内容
    const { sub_version } = req.body || {};
    if (sub_version !== undefined && sub_version !== p.sub_version) {
      return res.status(409).json({
        error: `字幕集已被修改（当前版本 ${p.sub_version}），请刷新后再确认导出`,
        current: { sub_version: p.sub_version, subtitles: p.subtitles },
      });
    }
    if (p.subtitles.length === 0) {
      return res.status(422).json({ error: '没有字幕可导出，请先排版', conflicts: [] });
    }
    if (p.words.length === 0) {
      return res.status(422).json({ error: '尚未导入逐词转写', conflicts: [] });
    }
    const structural = validateStructure(p.subtitles, p.words, p.cuts);
    const ruleProblems = validateRules(p.subtitles, p.rules);
    const conflicts = [...structural, ...ruleProblems];
    if (conflicts.length > 0) {
      return res.status(422).json({
        error: `字幕未通过导出校验（${conflicts.length} 处问题），未生成文件`,
        conflicts,
      });
    }
    const content = toWebVtt(p.subtitles);
    const tx = db.transaction(() => {
      const next = (db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM exports WHERE project_id = ?')
        .get(p.id).v) + 1;
      db.prepare(
        'INSERT INTO exports (project_id, version, content, cue_count) VALUES (?, ?, ?, ?)'
      ).run(p.id, next, content, p.subtitles.length);
      return next;
    });
    const version = tx();
    res.status(201).json({
      version,
      cue_count: p.subtitles.length,
      download_url: `/api/projects/${p.id}/exports/${version}`,
      content,
    });
  });

  app.get('/api/projects/:id/exports', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    res.json(db.prepare(
      'SELECT version, cue_count, created_at FROM exports WHERE project_id = ? ORDER BY version DESC'
    ).all(p.id));
  });

  app.get('/api/projects/:id/exports/:version', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const row = db.prepare(
      'SELECT * FROM exports WHERE project_id = ? AND version = ?'
    ).get(p.id, Number(req.params.version));
    if (!row) return res.status(404).json({ error: `导出版本 ${req.params.version} 不存在` });
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="project-${p.id}-v${row.version}.vtt"`
    );
    res.send(row.content);
  });

  // ---------- 校对者批量修订提议（提交 → 预览 → 采纳） ----------
  //
  // 一组针对同一项目“未锁定字幕”的待采纳修订：
  //   提交只保存原值快照与当时规则版本，绝不动正式字幕；
  //   预览并列原值/当前值/建议值并按整版候选核对冲突；
  //   采纳时在同一事务中再次核对（存在、未锁定、行版本、规则版本、整版校验），
  //   全部通过才写入全部修订并推进 sub_version；任一不过则整组不生效。

  function getRevision(req, res) {
    const p = getProject(req, res);
    if (!p) return null;
    const rid = Number(req.params.rid);
    const revision = loadRevision(db, p.id, rid);
    if (!revision) {
      res.status(404).json({ error: `修订提议 ${req.params.rid} 不存在` });
      return null;
    }
    return { p, revision };
  }

  /** 提交修订提议 */
  app.post('/api/projects/:id/revisions', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const body = req.body || {};
    const note = body.note !== undefined ? String(body.note) : '';
    // 1. 形状校验：空组 / 重复 ID / 空文本 / 非法时间 / 字段类型 → 400
    const parsed = parseRevisionItems(body);
    if (!parsed.ok) return res.status(400).json({ error: '修订请求非法，未保存提议', errors: parsed.errors });

    // 2. 状态校验（逐项）：目标须仍存在且未锁定；单侧时间与原值合并后仍须 start < end
    const cueById = new Map(p.subtitles.map((s) => [s.id, s]));
    const stateErrors = [];
    for (const it of parsed.items) {
      const cue = cueById.get(it.subtitle_id);
      if (!cue) {
        stateErrors.push(`字幕 ${it.subtitle_id} 不存在，无法提议修订`);
        continue;
      }
      if (cue.locked === 1) {
        stateErrors.push(`字幕 ${it.subtitle_id}（"${cue.text}"）已锁定，锁定字幕不能提交修订提议`);
        continue;
      }
      const s = it.start_ms !== null ? it.start_ms : cue.start_ms;
      const e = it.end_ms !== null ? it.end_ms : cue.end_ms;
      if (s >= e) {
        stateErrors.push(`字幕 ${it.subtitle_id} 合并单侧时间后为 [${s}, ${e}]，开始必须早于结束`);
      }
    }
    if (stateErrors.length > 0) {
      return res.status(422).json({ error: '修订请求未通过目标状态校验，未保存提议', errors: stateErrors });
    }

    const tx = db.transaction(() => {
      const info = db.prepare(
        `INSERT INTO revisions (project_id, note, rules_version_snapshot, sub_version_snapshot)
         VALUES (?, ?, ?, ?)`
      ).run(p.id, note, p.rules.version, p.sub_version);
      const rid = info.lastInsertRowid;
      const ins = db.prepare(
        `INSERT INTO revision_items
           (revision_id, ord, subtitle_id, cue_version, orig_text, orig_start_ms, orig_end_ms,
            proposed_text, start_ms, end_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      parsed.items.forEach((it, i) => {
        const cue = cueById.get(it.subtitle_id);
        ins.run(
          rid, i, it.subtitle_id, it.cue_version,
          cue.text, cue.start_ms, cue.end_ms,
          it.text, it.start_ms, it.end_ms
        );
      });
      return rid;
    });
    const rid = tx();
    res.status(201).json(loadRevision(db, p.id, rid));
  });

  /** 提议历史列表 */
  app.get('/api/projects/:id/revisions', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    res.json(listRevisions(db, p.id));
  });

  /** 单个提议（逐项并列原值与建议值） */
  app.get('/api/projects/:id/revisions/:rid', (req, res) => {
    const got = getRevision(req, res);
    if (got) res.json(got.revision);
  });

  /**
   * 预览核对：按“整组应用后的候选整版”检查
   * 词区间、词时段、切点、相邻字幕、字数/时长/字速，以及行/规则版本与锁定状态。
   * 只读，不改任何数据。
   */
  app.post('/api/projects/:id/revisions/:rid/preview', (req, res) => {
    const got = getRevision(req, res);
    if (!got) return;
    const { revision } = got;
    if (revision.status === 'accepted') {
      return res.json({
        revision,
        evaluation: {
          ok: false, rule_version_stale: false, items: [], conflicts: [],
          already_accepted: true, accepted_sub_version: revision.accepted_sub_version,
        },
      });
    }
    const evaluation = evaluateRevision({ project: got.p, revision });
    res.json({ revision, evaluation });
  });

  /**
   * 采纳：同一事务内再次核对目标仍存在且未锁定、各行版本、规则版本与整版校验；
   * 通过后写入全部修订、推进每行版本与字幕集版本、标记提议已采纳。
   * 任一过期或违规则整组不生效，返回当前值与原因。
   */
  app.post('/api/projects/:id/revisions/:rid/accept', (req, res) => {
    const got = getRevision(req, res);
    if (!got) return;
    const { p, revision } = got;
    if (revision.status === 'accepted') {
      return res.status(409).json({
        error: `修订提议 ${revision.id} 已采纳（字幕集推进到 v${revision.accepted_sub_version}），重复提交不得再改字幕`,
        already_accepted: true,
        accepted_sub_version: revision.accepted_sub_version,
        current: { sub_version: p.sub_version, subtitles: p.subtitles },
      });
    }

    class AcceptReject extends Error {
      constructor(statusCode, payload) {
        super(payload.error || '采纳被拒绝');
        this.statusCode = statusCode;
        this.payload = payload;
      }
    }

    const tx = db.transaction(() => {
      // 事务内读取权威当前状态
      const fresh = loadProject(db, p.id);
      const evaluation = evaluateRevision({ project: fresh, revision });

      if (!evaluation.ok) {
        const staleTypes = new Set([
          'cue_version_stale', 'subtitle_missing', 'subtitle_locked', 'rules_version_stale',
        ]);
        const isStale =
          evaluation.rule_version_stale ||
          evaluation.items.some(
            (r) => r.state !== 'ok' || r.conflicts.some((c) => staleTypes.has(c.type))
          );
        const items = evaluation.items
          .filter((r) => r.state !== 'ok' || r.conflicts.length > 0)
          .map((r) => ({
            ord: r.ord,
            subtitle_id: r.subtitle_id,
            state: r.state,
            cue_version: r.cue_version,
            current: r.cue,
            proposed: r.proposed,
            reasons: r.conflicts,
          }));
        throw new AcceptReject(isStale ? 409 : 422, {
          error: isStale
            ? `修订提议 ${revision.id} 存在过期/失效项，整组未生效，请刷新后重新提议`
            : `修订提议 ${revision.id} 共 ${items.length} 项核对未通过（当前规则 v${fresh.rules.version}），整组未生效`,
          rules_version: fresh.rules.version,
          current: { sub_version: fresh.sub_version, subtitles: fresh.subtitles },
          items,
          conflicts: evaluation.conflicts,
        });
      }

      // 全部通过：写入全部修订（WHERE version 兜底防并发）、行版本 +1、推进字幕集版本
      const upd = db.prepare(
        `UPDATE subtitles
           SET text = ?, start_ms = ?, end_ms = ?, version = version + 1
         WHERE id = ? AND project_id = ? AND locked = 0 AND version = ?`
      );
      for (const it of revision.items) {
        const cue = fresh.subtitles.find((s) => s.id === it.subtitle_id);
        const s = it.proposed.has_start_ms ? it.proposed.start_ms : cue.start_ms;
        const e = it.proposed.has_end_ms ? it.proposed.end_ms : cue.end_ms;
        const info = upd.run(it.proposed.text, s, e, it.subtitle_id, fresh.id, it.cue_version);
        if (info.changes !== 1) {
          throw new AcceptReject(409, {
            error: `字幕 ${it.subtitle_id} 在采纳瞬间发生变化，请刷新后重试`,
            current: { sub_version: fresh.sub_version },
          });
        }
      }

      // 写入后整版自检（结构 + 当前规则，含锁定行），失败即回滚
      const updated = loadProject(db, fresh.id);
      const finalProblems = [
        ...validateStructure(updated.subtitles, updated.words, updated.cuts),
        ...validateRules(updated.subtitles, updated.rules),
      ];
      if (finalProblems.length > 0) {
        throw new AcceptReject(422, {
          error: `采纳后整版校验发现 ${finalProblems.length} 处问题，整组已回滚`,
          conflicts: finalProblems,
        });
      }
      const subVersion = bumpSubVersion(db, fresh.id);
      // 源字幕文本/时间变化 → 相关译文转待复核（同事务，与采纳原子一致）
      syncTranslations(db, fresh.id);
      db.prepare(
        `UPDATE revisions SET status = 'accepted', accepted_at = datetime('now'),
           accepted_sub_version = ? WHERE id = ?`
      ).run(subVersion, revision.id);
      return subVersion;
    });

    try {
      const subVersion = tx();
      const after = loadProject(db, p.id);
      const accepted = after.subtitles.filter((s) =>
        revision.items.some((it) => it.subtitle_id === s.id)
      );
      res.json({
        revision_id: revision.id,
        status: 'accepted',
        sub_version: subVersion,
        applied: revision.items.length,
        subtitles: accepted,
      });
    } catch (err) {
      if (err instanceof AcceptReject) {
        return res.status(err.statusCode).json(err.payload);
      }
      throw err;
    }
  });

  // ---------- 校对者逐词时间修正提议（提交 → 预览 → 确认） ----------
  //
  // 按词序号提交一组起止毫秒修正，携带读取时字幕集 sub_version：
  //   提交只保存原词时间快照，绝不动正式词/字幕；
  //   预览只读核对：受影响字幕、锁定冲突、词序重叠与受影响区间重排候选；
  //   确认时在同一事务里重新读取权威状态再次核对，通过后原子地
  //   更新词时间、删除受影响未锁定字幕并重排、推进字幕集版本。
  //   锁定字幕文本与时间原样保留；未受影响字幕保留 ID/行版本/人工文本。

  function getWordRevision(req, res) {
    const p = getProject(req, res);
    if (!p) return null;
    const wrid = Number(req.params.wrid);
    const revision = loadWordRevision(db, p.id, wrid);
    if (!revision) {
      res.status(404).json({ error: `逐词修正提议 ${req.params.wrid} 不存在` });
      return null;
    }
    return { p, revision };
  }

  /** 提交逐词修正提议（只保存快照，不动正式数据） */
  app.post('/api/projects/:id/word-revisions', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const body = req.body || {};
    if (body.sub_version === undefined || !Number.isInteger(body.sub_version) || body.sub_version < 0) {
      return res.status(400).json({
        error: '请求非法，未保存提议',
        errors: ['sub_version（读取时字幕集版本）必须是 ≥0 的整数'],
      });
    }
    // 1. 形状校验：空组 / 重复序号 / 非法时间 / 字段类型 → 400
    const parsed = parseWordRevisionItems(body);
    if (!parsed.ok) {
      return res.status(400).json({ error: '修正请求非法，未保存提议', errors: parsed.errors });
    }

    // 2. 字幕集乐观锁：携带的 sub_version 必须是当前值，过期直接返回当前值
    if (body.sub_version !== p.sub_version) {
      return res.status(409).json({
        error: `字幕集已被修改（你基于 v${body.sub_version} 读取，当前已是 v${p.sub_version}），请刷新后重新修正`,
        current: { sub_version: p.sub_version, words: p.words, subtitles: p.subtitles },
      });
    }

    // 3. 状态校验：词序号须存在；修正后（与未修正词合并）全部词仍按序互不重叠。
    //    锁定字幕是否容得下、重排是否可行等复杂核对留给预览/确认（保留提议供查看）。
    const stateErrors = [];
    const merged = p.words.map((w) => ({ ...w }));
    for (const it of parsed.items) {
      if (it.word_idx >= p.words.length) {
        stateErrors.push(`词序号 ${it.word_idx} 超出范围（当前共 ${p.words.length} 个词，序号 0..${p.words.length - 1}）`);
        continue;
      }
      merged[it.word_idx] = { ...merged[it.word_idx], start_ms: it.start_ms, end_ms: it.end_ms };
    }
    if (stateErrors.length === 0) {
      for (let k = 0; k + 1 < merged.length; k++) {
        if (merged[k + 1].start_ms < merged[k].end_ms) {
          const touched = parsed.items.some((it) => it.word_idx === k || it.word_idx === k + 1);
          if (touched) {
            stateErrors.push(
              `应用修正后词 ${k} "${merged[k].text}" [${merged[k].start_ms}, ${merged[k].end_ms}] 与 ` +
              `词 ${k + 1} "${merged[k + 1].text}" [${merged[k + 1].start_ms}, ${merged[k + 1].end_ms}] ` +
              '重叠或倒序：修正后全部词仍须按序且互不重叠'
            );
          }
        }
      }
    }
    if (stateErrors.length > 0) {
      return res.status(422).json({ error: '修正请求未通过词序列校验，未保存提议', errors: stateErrors });
    }

    const note = body.note !== undefined ? String(body.note) : '';
    const tx = db.transaction(() => {
      const info = db.prepare(
        'INSERT INTO word_revisions (project_id, note, sub_version_snapshot) VALUES (?, ?, ?)'
      ).run(p.id, note, p.sub_version);
      const wrid = info.lastInsertRowid;
      const ins = db.prepare(
        `INSERT INTO word_revision_items
           (word_revision_id, ord, word_idx, orig_start_ms, orig_end_ms, start_ms, end_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      parsed.items.forEach((it, i) => {
        const w = p.words[it.word_idx];
        ins.run(wrid, i, it.word_idx, w.start_ms, w.end_ms, it.start_ms, it.end_ms);
      });
      return wrid;
    });
    const wrid = tx();
    res.status(201).json(loadWordRevision(db, p.id, wrid));
  });

  /** 提议历史列表 */
  app.get('/api/projects/:id/word-revisions', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    res.json(listWordRevisions(db, p.id));
  });

  /** 单个提议（逐项原值/当前值/建议值） */
  app.get('/api/projects/:id/word-revisions/:wrid', (req, res) => {
    const got = getWordRevision(req, res);
    if (got) res.json(got.revision);
  });

  /**
   * 只读预览核对：受影响字幕（将被重排的未锁定行 / 含修正词的锁定行）、
   * 逐项原词/当前词/建议词时间、候选整版与逐处中文冲突。
   */
  app.post('/api/projects/:id/word-revisions/:wrid/preview', (req, res) => {
    const got = getWordRevision(req, res);
    if (!got) return;
    const { revision } = got;
    if (revision.status === 'confirmed') {
      return res.json({
        revision,
        evaluation: {
          ok: false, stale: false, items: [], conflicts: [],
          subtitles: [], replaced: [], affected_locked: [],
          already_confirmed: true, confirmed_sub_version: revision.confirmed_sub_version,
        },
      });
    }
    const evaluation = evaluateWordRevision({ project: got.p, revision });
    res.json({ revision, evaluation });
  });

  /**
   * 确认：同一事务内重新读取权威状态并再次执行全部核对；
   * 通过则原子写入词时间、删除受影响未锁定字幕并按候选重排（新 ID/新版本）、
   * 更新保留行 idx（ID/行版本不变）、推进字幕集版本、标记提议已确认。
   * 过期/失效（sub_version、词漂移、词缺失）→ 409；
   * 锁定或排版规则不可兼顾 → 422；词与字幕均不变（事务回滚）。
   */
  app.post('/api/projects/:id/word-revisions/:wrid/confirm', (req, res) => {
    const got = getWordRevision(req, res);
    if (!got) return;
    const { p, revision } = got;
    if (revision.status === 'confirmed') {
      return res.status(409).json({
        error: `逐词修正提议 ${revision.id} 已确认（字幕集推进到 v${revision.confirmed_sub_version}），重复提交不得再改词与字幕`,
        already_confirmed: true,
        confirmed_sub_version: revision.confirmed_sub_version,
        current: { sub_version: p.sub_version, words: p.words, subtitles: p.subtitles },
      });
    }

    class ConfirmReject extends Error {
      constructor(statusCode, payload) {
        super(payload.error || '确认被拒绝');
        this.statusCode = statusCode;
        this.payload = payload;
      }
    }

    const tx = db.transaction(() => {
      // 事务内读取权威当前状态（修订明细自身不变，freshRevision 取最新当前词时间）
      const fresh = loadProject(db, p.id);
      const freshRevision = loadWordRevision(db, fresh.id, revision.id);
      const evaluation = evaluateWordRevision({ project: fresh, revision: freshRevision });

      if (!evaluation.ok) {
        const isStale =
          evaluation.stale ||
          evaluation.items.some((r) => r.state !== 'ok');
        const items = evaluation.items
          .filter((r) => r.state !== 'ok' || r.conflicts.length > 0)
          .map((r) => ({
            ord: r.ord, word_idx: r.word_idx, state: r.state,
            orig: r.orig, current: r.current, proposed: r.proposed,
            reasons: r.conflicts,
          }));
        throw new ConfirmReject(isStale ? 409 : 422, {
          error: isStale
            ? `逐词修正提议 ${revision.id} 基于过期字幕集/词时间，请刷新后重新修正（整组未生效）`
            : `逐词修正提议 ${revision.id} 无法兼顾锁定或排版约束，共 ` +
              `${items.length + evaluation.conflicts.length} 处问题；词与字幕均未改动`,
          current: {
            sub_version: fresh.sub_version,
            words: fresh.words,
            subtitles: fresh.subtitles,
          },
          items,
          conflicts: evaluation.conflicts,
          replaced: evaluation.replaced,
          affected_locked: evaluation.affected_locked,
        });
      }

      // 全部通过：1) 更新词时间（带原值 WHERE 兜底；词序/文本不动）
      const updWord = db.prepare(
        `UPDATE words SET start_ms = ?, end_ms = ?
          WHERE project_id = ? AND idx = ? AND start_ms = ? AND end_ms = ?`
      );
      for (const it of freshRevision.items) {
        const info = updWord.run(
          it.proposed.start_ms, it.proposed.end_ms,
          fresh.id, it.word_idx, it.orig.start_ms, it.orig.end_ms
        );
        if (info.changes !== 1) {
          throw new ConfirmReject(409, {
            error: `词 ${it.word_idx} 在确认瞬间发生变化，请刷新后重试`,
            current: { sub_version: fresh.sub_version },
          });
        }
      }

      // 2) 删除受影响的未锁定字幕（带 locked=0 兜底；这些行随后以新 ID/新版本重排）
      const replacedIds = evaluation.replaced.map((s) => s.id);
      if (replacedIds.length > 0) {
        const placeholders = replacedIds.map(() => '?').join(',');
        const delInfo = db.prepare(
          `DELETE FROM subtitles WHERE project_id = ? AND locked = 0 AND id IN (${placeholders})`
        ).run(fresh.id, ...replacedIds);
        if (delInfo.changes !== replacedIds.length) {
          throw new ConfirmReject(409, {
            error: '受影响字幕在确认瞬间发生变化（已锁定/已消失），请刷新后重试',
            current: { sub_version: fresh.sub_version },
          });
        }
      }

      // 3) 按候选整版写入：新行 INSERT；保留行（含锁定行）仅更新 idx（ID/行版本不变）。
      //    先把全部保留行 idx 挪到负的临时值（-id-1，必然互不相同），
      //    避免 UNIQUE(project_id, idx) 在重排时与 0 起的正式 idx 临时撞号。
      db.prepare('UPDATE subtitles SET idx = -id - 1 WHERE project_id = ?').run(fresh.id);
      const insCue = db.prepare(
        `INSERT INTO subtitles (project_id, idx, word_start, word_end, text, start_ms, end_ms, locked)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
      );
      const updIdx = db.prepare('UPDATE subtitles SET idx = ? WHERE id = ? AND project_id = ?');
      evaluation.subtitles.forEach((c, i) => {
        if (c.origin === 'kept') updIdx.run(i, c.id, fresh.id);
        else insCue.run(fresh.id, i, c.word_start, c.word_end, c.text, c.start_ms, c.end_ms);
      });

      // 4) 写入后整版终检（结构 + 当前规则，含锁定行），失败即回滚
      const updated = loadProject(db, fresh.id);
      const finalProblems = [
        ...validateStructure(updated.subtitles, updated.words, updated.cuts),
        ...validateRules(updated.subtitles, updated.rules),
      ];
      if (finalProblems.length > 0) {
        throw new ConfirmReject(422, {
          error: `确认后整版校验发现 ${finalProblems.length} 处问题，词与字幕已全部回滚`,
          conflicts: finalProblems,
        });
      }

      const subVersion = bumpSubVersion(db, fresh.id);
      // 词时间/受影响区间重排导致的源行变化：受影响行译文转待复核，被删行译文留历史
      syncTranslations(db, fresh.id);
      db.prepare(
        `UPDATE word_revisions SET status = 'confirmed', confirmed_at = datetime('now'),
           confirmed_sub_version = ? WHERE id = ?`
      ).run(subVersion, revision.id);
      return { subVersion, replacedCount: replacedIds.length };
    });

    try {
      const summary = tx();
      const after = loadProject(db, p.id);
      res.json({
        word_revision_id: revision.id,
        status: 'confirmed',
        sub_version: summary.subVersion,
        words_updated: revision.items.length,
        cues_replaced: summary.replacedCount,
        words: after.words,
        subtitles: after.subtitles,
      });
    } catch (err) {
      if (err instanceof ConfirmReject) {
        return res.status(err.statusCode).json(err.payload);
      }
      throw err;
    }
  });

  // ---------- 多语言译文字幕 ----------
  //
  // 译文沿用源字幕的起止时间与词区间：接口不接受任何时间/词区间/原文字段，
  // 也不改词、切点、原文。保存携带 语言代号、字幕 ID、读取时行版本 cue_version、
  // 译文版本 version（新建省略/0）；同一语言每条当前字幕最多一份非历史译文。
  // 源字幕文本/时间/词区间变化 → 译文待复核（syncTranslations 统一对账）；
  // 仅锁定/展示顺序变化不失效；源行删除 → 译文留历史，新行视为缺译，不按序号挪用。

  /** 解析路径中的语言代号，非法直接回 400 */
  function getLang(req, res) {
    const lang = normalizeLang(req.params.lang);
    if (!lang) {
      res.status(400).json({
        error: `语言代号 ${JSON.stringify(req.params.lang)} 非法：须非空、≤32 字、字母开头（字母/数字/-/_），如 en、ja-JP、pt_BR`,
      });
      return null;
    }
    return lang;
  }

  /** 项目语言总览（各语言译文状态分布 + 导出数） */
  app.get('/api/projects/:id/translations', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    res.json({
      project_id: p.id,
      sub_version: p.sub_version,
      rules_version: p.rules ? p.rules.version : null,
      cue_count: p.subtitles.length,
      languages: listLanguages(db, p.id),
    });
  });

  /**
   * 单语言并列查询：原文、译文与状态（missing/current/review）逐行并列，
   * 附现行规则原因 invalid_reasons 与该语言历史译文；只读。
   */
  app.get('/api/projects/:id/translations/:lang', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const lang = getLang(req, res);
    if (!lang) return;
    res.json(buildLangView(db, p.id, lang));
  });

  /**
   * 保存/更新一条译文（按语言+字幕身份 upsert）。
   * 新建返回 201，更新返回 200。
   *   - cue_version 必须等于当前源行版本，否则 409 返回当前值；
   *   - 译文 version 新建传 0/省略，更新必须等于当前译文版本，否则 409；
   *   - 译文须满足现行 max_chars / max_cps（时长随源行），否则 422 且不改数据。
   * 保存成功即为 current 并刷新源快照（校对者可直接在漂移后重新保存来消解待复核）。
   */
  app.put('/api/projects/:id/translations/:lang/subtitles/:sid', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const lang = getLang(req, res);
    if (!lang) return;
    const sid = Number(req.params.sid);

    const parsed = parseTranslationBody(req.body);
    if (!parsed.ok) return res.status(400).json({ error: '译文请求非法，未保存', errors: parsed.errors });

    const cue = db.prepare('SELECT * FROM subtitles WHERE id = ? AND project_id = ?').get(sid, p.id);
    if (!cue) return res.status(404).json({ error: `字幕 ${req.params.sid} 不存在（可能已被重排删除，请按当前行重新翻译）` });

    if (parsed.item.cue_version !== cue.version) {
      return res.status(409).json({
        error: `源字幕行版本过期：你基于 v${parsed.item.cue_version} 读取，当前已是 v${cue.version}`,
        current: { cue, rules: p.rules },
      });
    }

    const ruleErrors = checkTranslationText(parsed.item.text, cue, p.rules);
    if (ruleErrors.length > 0) {
      return res.status(422).json({ error: '译文未通过当前字数/字速规则，未保存', errors: ruleErrors, current: { cue } });
    }

    const existing = db.prepare(
      `SELECT * FROM translations WHERE project_id = ? AND lang = ? AND subtitle_id = ? AND status != 'history'`
    ).get(p.id, lang, sid);

    if (existing && parsed.item.version === 0) {
      return res.status(409).json({
        error: `语言 ${lang} 在字幕 ${sid} 上已存在译文 v${existing.version}（${existing.status === 'review' ? '待复核' : '当前'}）：更新须携带其 version`,
        current: { translation: mapRow(existing) },
      });
    }
    if (existing && parsed.item.version !== existing.version) {
      return res.status(409).json({
        error: `译文版本过期：你基于 v${parsed.item.version} 修改，当前已是 v${existing.version}`,
        current: { cue, translation: mapRow(existing) },
      });
    }

    let statusCode = 200;
    const tx = db.transaction(() => {
      if (existing) {
        db.prepare(
          `UPDATE translations SET text = ?, version = version + 1, status = 'current',
             cue_version_snapshot = ?, src_text = ?, src_start_ms = ?, src_end_ms = ?,
             src_word_start = ?, src_word_end = ?, updated_at = datetime('now')
           WHERE id = ?`
        ).run(
          parsed.item.text, cue.version, cue.text, cue.start_ms, cue.end_ms,
          cue.word_start, cue.word_end, existing.id
        );
      } else {
        db.prepare(
          `INSERT INTO translations
             (project_id, lang, subtitle_id, text, status, version, cue_version_snapshot,
              src_text, src_start_ms, src_end_ms, src_word_start, src_word_end)
           VALUES (?, ?, ?, ?, 'current', 1, ?, ?, ?, ?, ?, ?)`
        ).run(
          p.id, lang, sid, parsed.item.text, cue.version, cue.text,
          cue.start_ms, cue.end_ms, cue.word_start, cue.word_end
        );
        statusCode = 201;
      }
    });
    tx();
    const row = db.prepare(
      `SELECT * FROM translations WHERE project_id = ? AND lang = ? AND subtitle_id = ? AND status != 'history'`
    ).get(p.id, lang, sid);
    res.status(statusCode).json({ translation: mapRow(row), cue, valid: true });
  });

  /**
   * 确认待复核译文：校对者核对当前源行后，认为译文仍适用。
   *   - 译文必须存在且处于 review；current/历史 → 422 且不改数据；
   *   - version 必须等于当前译文版本，否则 409 返回当前值与原因；
   *   - 译文须满足现行字数/字速规则，否则 422 返回当前值与原因。
   * 通过后刷新源快照、转 current、译文版本 +1（源行版本/时间本身不变）。
   */
  app.post('/api/projects/:id/translations/:lang/subtitles/:sid/confirm', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const lang = getLang(req, res);
    if (!lang) return;
    const sid = Number(req.params.sid);

    const parsed = parseConfirmBody(req.body);
    if (!parsed.ok) return res.status(400).json({ error: '确认请求非法', errors: parsed.errors });

    const row = db.prepare(
      `SELECT * FROM translations WHERE project_id = ? AND lang = ? AND subtitle_id = ? AND status != 'history'`
    ).get(p.id, lang, sid);
    if (!row) {
      const cue = db.prepare('SELECT id, text, version FROM subtitles WHERE id = ? AND project_id = ?').get(sid, p.id);
      return res.status(404).json({
        error: `语言 ${lang} 在字幕 ${sid} 上没有可确认的译文`,
        current: { cue: cue || null },
      });
    }
    if (row.status !== 'review') {
      return res.status(422).json({
        error: `该译文当前为 ${row.status === 'current' ? '当前有效' : row.status} 状态，无需确认`,
        current: { translation: mapRow(row) },
      });
    }
    if (parsed.version !== row.version) {
      return res.status(409).json({
        error: `译文版本过期：你基于 v${parsed.version} 确认，当前已是 v${row.version}`,
        current: { translation: mapRow(row) },
      });
    }
    const cue = db.prepare('SELECT * FROM subtitles WHERE id = ? AND project_id = ?').get(sid, p.id);
    if (!cue) {
      return res.status(404).json({ error: `字幕 ${sid} 已不存在`, current: { translation: mapRow(row) } });
    }
    const ruleErrors = checkTranslationText(row.text, cue, p.rules);
    if (ruleErrors.length > 0) {
      return res.status(422).json({
        error: '待复核译文不满足当前字数/字速规则，请先修改译文再确认（数据未改动）',
        errors: ruleErrors,
        current: { cue, translation: mapRow(row) },
      });
    }

    db.prepare(
      `UPDATE translations SET status = 'current', cue_version_snapshot = ?,
         src_text = ?, src_start_ms = ?, src_end_ms = ?, src_word_start = ?, src_word_end = ?,
         version = version + 1, updated_at = datetime('now') WHERE id = ?`
    ).run(cue.version, cue.text, cue.start_ms, cue.end_ms, cue.word_start, cue.word_end, row.id);
    const updated = db.prepare('SELECT * FROM translations WHERE id = ?').get(row.id);
    res.json({ translation: mapRow(updated), cue, valid: true });
  });

  /**
   * 按语言确认导出：先整版核对——
   *   源字幕结构（覆盖/重叠/切点/词时段）与现行规则通过，且当前每行都有
   *   current 且满足字数/字速的译文；否则列出 missing/review/invalid/conflicts，
   *   不生成快照。成功则生成按时间升序、不可变的译文 WebVTT 快照。
   * 可携带 sub_version 防呆（与当前不一致 → 409）。
   */
  app.post('/api/projects/:id/translations/:lang/exports', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const lang = getLang(req, res);
    if (!lang) return;
    const { sub_version } = req.body || {};
    if (sub_version !== undefined && sub_version !== p.sub_version) {
      return res.status(409).json({
        error: `字幕集已被修改（当前版本 ${p.sub_version}），请刷新后再确认导出`,
        current: { sub_version: p.sub_version },
      });
    }

    const check = evaluateExport(db, p.id, lang);
    if (!check.ok) {
      const problems =
        check.missing.length + check.review.length + check.invalid.length + check.conflicts.length;
      return res.status(422).json({
        error: `语言 ${lang} 未通过导出核对（${problems} 处问题），未生成快照`,
        missing: check.missing,
        review: check.review,
        invalid: check.invalid,
        conflicts: check.conflicts,
      });
    }

    // 译文沿用源字幕起止：按 idx（时间升序）取译文文本生成 WebVTT
    const cues = check.entries.map((e, i) => ({
      start_ms: e.cue.start_ms, end_ms: e.cue.end_ms, text: e.translation.text, idx: i,
    }));
    const content = toWebVtt(cues);
    const version = db.transaction(() => {
      const next = (db.prepare(
        'SELECT COALESCE(MAX(version), 0) AS v FROM translation_exports WHERE project_id = ? AND lang = ?'
      ).get(p.id, lang).v) + 1;
      db.prepare(
        'INSERT INTO translation_exports (project_id, lang, version, content, cue_count) VALUES (?, ?, ?, ?, ?)'
      ).run(p.id, lang, next, content, cues.length);
      return next;
    })();
    res.status(201).json({
      lang, version, cue_count: cues.length,
      download_url: `/api/projects/${p.id}/translations/${encodeURIComponent(lang)}/exports/${version}`,
      content,
    });
  });

  /** 某语言译文导出快照列表 */
  app.get('/api/projects/:id/translations/:lang/exports', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const lang = getLang(req, res);
    if (!lang) return;
    res.json(db.prepare(
      'SELECT lang, version, cue_count, created_at FROM translation_exports WHERE project_id = ? AND lang = ? ORDER BY version DESC'
    ).all(p.id, lang));
  });

  /** 下载某语言某版本译文 WebVTT（内容创建后不变） */
  app.get('/api/projects/:id/translations/:lang/exports/:version', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const lang = getLang(req, res);
    if (!lang) return;
    const row = db.prepare(
      'SELECT * FROM translation_exports WHERE project_id = ? AND lang = ? AND version = ?'
    ).get(p.id, lang, Number(req.params.version));
    if (!row) return res.status(404).json({ error: `语言 ${lang} 的译文导出版本 ${req.params.version} 不存在` });
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="project-${p.id}-${lang}-v${row.version}.vtt"`);
    res.send(row.content);
  });

  // ---------- 多语批次交付 ----------
  //
  // 把原文与选定语言冻结为同一时间轴的一个批次：提交当前字幕集版本、规则版本、
  // 非空不重复的语言列表与各语言逐行译文版本；服务端在一次事务内核对源整版结构
  // 与现行规则、每行译文为 current 且满足字数/字速、提交版本仍有效。
  // 任一语言缺译/待复核/无效/版本漂移 → 按语言与字幕行返回原因，整批不生成快照、
  // 不消耗任何导出序列版本号；成功时在原文与各语言导出序列中各生成一个不可变
  // WebVTT 版本，并以批次清单关联文件、字幕集版本与规则版本。

  /** 批次清单中的文件项补充既有下载地址（原文/译文下载接口不变） */
  function decorateDelivery(projectId, manifest) {
    return {
      ...manifest,
      files: manifest.files.map((f) => ({
        ...f,
        download_url: f.kind === 'source'
          ? `/api/projects/${projectId}/exports/${f.version}`
          : `/api/projects/${projectId}/translations/${encodeURIComponent(f.lang)}/exports/${f.version}`,
      })),
    };
  }

  /**
   * 交付批次：{ sub_version, rules_version, languages: [...], versions: { lang: { 字幕ID: 译文版本 } } }
   *   400 请求形状非法（空语言列表/重复语言/缺版本表/版本非正整数等）；
   *   409 字幕集版本或规则版本漂移（带当前值）；
   *   422 任一语言缺译/待复核/无效/译文版本漂移，或源整版结构/规则冲突
   *       （按语言与字幕行分类返回，整批不生成快照）；
   *   201 批次清单（含各文件在既有导出序列中的版本号与下载地址）。
   */
  app.post('/api/projects/:id/deliveries', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const parsed = parseDeliveryBody(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: '批次交付请求非法，未生成交付', errors: parsed.errors });
    }

    class DeliveryReject extends Error {
      constructor(statusCode, payload) {
        super(payload.error || '批次交付被拒绝');
        this.statusCode = statusCode;
        this.payload = payload;
      }
    }

    const tx = db.transaction(() => {
      // 事务内读取权威当前状态并核对（版本漂移/缺译/待复核/无效/源整版冲突）
      const check = evaluateDelivery(db, p.id, parsed.parsed);

      if (check.sub_version_stale || check.rules_version_stale) {
        const parts = [];
        if (check.sub_version_stale) {
          parts.push(`字幕集已被修改（你基于 v${parsed.parsed.sub_version}，当前已是 v${check.sub_version}）`);
        }
        if (check.rules_version_stale) {
          parts.push(`规则已被修改（你基于 v${parsed.parsed.rules_version}，当前已是 v${check.rules_version}）`);
        }
        throw new DeliveryReject(409, {
          error: `${parts.join('；')}，请刷新后重新交付`,
          current: { sub_version: check.sub_version, rules_version: check.rules_version },
        });
      }
      if (!check.ok) {
        const problems = check.conflicts.length + check.languages.reduce(
          (n, l) => n + l.missing.length + l.review.length + l.invalid.length +
            l.stale.length + l.unknown.length,
          0
        );
        throw new DeliveryReject(422, {
          error: `批次交付核对未通过（${problems} 处问题），整批未生成快照、未消耗任何版本`,
          current: { sub_version: check.sub_version, rules_version: check.rules_version },
          conflicts: check.conflicts,
          languages: check.languages,
        });
      }

      // 全部通过：原文 + 每种语言各生成一个不可变 WebVTT 版本（同一事务、同一源时间轴）
      const cueCount = check.cues.length;
      const sourceContent = toWebVtt(check.cues);
      const sourceVersion = (db.prepare(
        'SELECT COALESCE(MAX(version), 0) AS v FROM exports WHERE project_id = ?'
      ).get(p.id).v) + 1;
      const srcInfo = db.prepare(
        'INSERT INTO exports (project_id, version, content, cue_count) VALUES (?, ?, ?, ?)'
      ).run(p.id, sourceVersion, sourceContent, cueCount);

      const batchId = db.prepare(
        `INSERT INTO delivery_batches (project_id, sub_version, rules_version, cue_count)
         VALUES (?, ?, ?, ?)`
      ).run(p.id, check.sub_version, check.rules_version, cueCount).lastInsertRowid;

      const insFile = db.prepare(
        `INSERT INTO delivery_batch_files (batch_id, kind, lang, export_id, version, cue_count)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      insFile.run(batchId, 'source', '', srcInfo.lastInsertRowid, sourceVersion, cueCount);

      for (const lang of parsed.parsed.languages) {
        const byCue = check.translationsByLang.get(lang);
        // 译文沿用源行起止：与原文快照同一时间轴
        const langCues = check.cues.map((cue, i) => ({
          start_ms: cue.start_ms, end_ms: cue.end_ms,
          text: byCue.get(cue.id).text, idx: i,
        }));
        const content = toWebVtt(langCues);
        const version = (db.prepare(
          'SELECT COALESCE(MAX(version), 0) AS v FROM translation_exports WHERE project_id = ? AND lang = ?'
        ).get(p.id, lang).v) + 1;
        const info = db.prepare(
          'INSERT INTO translation_exports (project_id, lang, version, content, cue_count) VALUES (?, ?, ?, ?, ?)'
        ).run(p.id, lang, version, content, cueCount);
        insFile.run(batchId, 'translation', lang, info.lastInsertRowid, version, cueCount);
      }
      return batchId;
    });

    try {
      const batchId = tx();
      res.status(201).json(decorateDelivery(p.id, loadDelivery(db, p.id, batchId)));
    } catch (err) {
      if (err instanceof DeliveryReject) {
        return res.status(err.statusCode).json(err.payload);
      }
      throw err;
    }
  });

  /** 交付批次清单列表（含各文件版本号与既有下载地址） */
  app.get('/api/projects/:id/deliveries', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    res.json(listDeliveries(db, p.id).map((m) => decorateDelivery(p.id, m)));
  });

  /** 单个交付批次清单 */
  app.get('/api/projects/:id/deliveries/:bid', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const manifest = loadDelivery(db, p.id, Number(req.params.bid));
    if (!manifest) return res.status(404).json({ error: `交付批次 ${req.params.bid} 不存在` });
    res.json(decorateDelivery(p.id, manifest));
  });

  return app;
}

module.exports = { createApp };
