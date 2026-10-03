'use strict';

/* 字幕校时工作台前端：项目/导入/规则/排版/锁定/导出，全部带乐观锁处理 */

const state = {
  projects: [],
  project: null,      // 当前项目完整载荷
  edits: new Map(),   // cueId -> { text, start_ms, end_ms } 未保存修改
  trLang: null,       // 当前译文语言
  trView: null,       // 该语言并列查询视图
};

// ---------- 工具 ----------

const $ = (sel) => document.querySelector(sel);

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let body = null;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 5000);
}

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

// ---------- 数据加载 ----------

async function loadProjects(selectId) {
  const { body } = await api('/api/projects');
  state.projects = body || [];
  const sel = $('#project-select');
  sel.innerHTML = '';
  if (state.projects.length === 0) {
    sel.innerHTML = '<option value="">（无项目，请先导入）</option>';
    state.project = null;
    renderAll();
    return;
  }
  for (const p of state.projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `#${p.id} ${p.name}（${p.word_count} 词 / ${p.cue_count} 字幕 / ${p.export_count} 导出）`;
    sel.appendChild(opt);
  }
  const id = selectId ?? state.projects[0].id;
  sel.value = id;
  state.trLang = null;
  state.trView = null;
  $('#tr-panel').classList.add('hidden');
  await loadProject(Number(sel.value));
}

async function loadProject(id) {
  const { status, body } = await api(`/api/projects/${id}`);
  if (status !== 200) { toast(body?.error || '加载项目失败', true); return; }
  state.project = body;
  state.edits.clear();
  // 切换/刷新项目后重新载入当前语言视图（项目不同则收起面板）
  if (state.trLang) loadTranslation(state.trLang);
  else $('#tr-panel').classList.add('hidden');
  renderAll();
}

// ---------- 渲染 ----------

function renderAll() {
  renderRules();
  renderSubtitles();
  renderExports();
  renderRevisions();
  renderWordRevisions();
  $('#force-row').classList.add('hidden');
}

function renderRules() {
  const p = state.project;
  $('#rules-version').textContent = p?.rules ? `v${p.rules.version}` : '';
  $('#rule-max-chars').value = p?.rules?.max_chars ?? '';
  $('#rule-min-duration').value = p?.rules?.min_duration_ms ?? '';
  $('#rule-max-cps').value = p?.rules?.max_cps ?? '';
}

function renderSubtitles() {
  const p = state.project;
  const box = $('#cue-table');
  box.innerHTML = '';
  $('#sub-version').textContent = p ? `字幕集 v${p.sub_version}` : '';
  if (!p || p.subtitles.length === 0) {
    box.innerHTML = '<div class="empty">暂无字幕：导入转写后点击「重新排版」。</div>';
    $('#cue-stats').textContent = p ? `（${p.words.length} 词 / ${p.cuts.length} 切点）` : '';
    return;
  }
  const maxChars = p.rules.max_chars;
  $('#cue-stats').textContent =
    `（${p.subtitles.length} 条，其中锁定 ${p.subtitles.filter((s) => s.locked).length} 条）`;

  p.subtitles.forEach((cue) => {
    const row = document.createElement('div');
    row.className = 'cue-row' + (cue.locked ? ' locked' : '');
    row.dataset.id = cue.id;

    const idx = document.createElement('div');
    idx.className = 'idx';
    idx.innerHTML = `${cue.idx + 1}<div class="word-ref">词${cue.word_start}–${cue.word_end} · v${cue.version}</div>`;

    const startInput = document.createElement('input');
    startInput.type = 'number'; startInput.min = '0'; startInput.value = cue.start_ms;
    startInput.title = `开始 ms（${fmtMs(cue.start_ms)}）`;
    const endInput = document.createElement('input');
    endInput.type = 'number'; endInput.min = '0'; endInput.value = cue.end_ms;
    endInput.title = `结束 ms（${fmtMs(cue.end_ms)}）`;

    const textInput = document.createElement('input');
    textInput.type = 'text'; textInput.value = cue.text; textInput.className = 'text-input';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const updateMeta = () => {
      const len = textInput.value.length;
      const dur = Number(endInput.value) - Number(startInput.value);
      const cps = dur > 0 ? (len / (dur / 1000)) : Infinity;
      const badLen = len > maxChars;
      const badDur = dur < p.rules.min_duration_ms;
      const badCps = cps > p.rules.max_cps;
      meta.innerHTML =
        `<span class="${badLen ? 'bad' : ''}">${len}/${maxChars} 字</span> · ` +
        `<span class="${badDur ? 'bad' : ''}">${dur}ms</span> · ` +
        `<span class="${badCps ? 'bad' : ''}">${cps.toFixed(1)}字/s</span>`;
    };
    updateMeta();

    const markDirty = () => {
      state.edits.set(cue.id, {
        text: textInput.value,
        start_ms: Number(startInput.value),
        end_ms: Number(endInput.value),
      });
      updateMeta();
    };
    textInput.addEventListener('input', markDirty);
    startInput.addEventListener('input', markDirty);
    endInput.addEventListener('input', markDirty);

    const ops = document.createElement('div');
    ops.className = 'ops';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'small'; saveBtn.textContent = '保存';
    saveBtn.onclick = () => saveCue(cue);
    const lockBtn = document.createElement('button');
    lockBtn.className = 'small secondary';
    lockBtn.textContent = cue.locked ? '🔒 解锁' : '🔓 锁定';
    lockBtn.title = cue.locked ? '已校对锁定，重排不会改动' : '锁定后重排不再改动此条';
    lockBtn.onclick = () => toggleLock(cue);
    ops.append(saveBtn, lockBtn);

    row.append(idx, startInput, endInput, textInput, meta, ops);
    box.appendChild(row);
  });
}

function renderExports() {
  const p = state.project;
  const ul = $('#export-list');
  ul.innerHTML = '';
  if (!p || p.exports.length === 0) {
    ul.innerHTML = '<li class="empty">尚无导出版本</li>';
    return;
  }
  for (const e of p.exports) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `/api/projects/${p.id}/exports/${e.version}`;
    a.textContent = `⬇ v${e.version}.vtt`;
    a.download = `project-${p.id}-v${e.version}.vtt`;
    const info = document.createElement('span');
    info.className = 'hint';
    info.textContent = `${e.cue_count} 条 · ${e.created_at}`;
    li.append(a, info);
    ul.appendChild(li);
  }
}

// ---------- 批量修订提议 ----------

function renderRevisions() {
  const p = state.project;
  const box = $('#rev-list');
  box.innerHTML = '';
  $('#rev-detail-panel').classList.add('hidden');
  if (!p) return;
  const list = p.revisions || [];
  const pending = list.filter((r) => r.status === 'pending').length;
  $('#rev-stats').textContent = `（共 ${list.length} 组，待采纳 ${pending} 组）`;
  if (list.length === 0) {
    box.innerHTML = '<div class="empty">尚无修订提议。校对时可在左下角按 JSON 提交一组。</div>';
    return;
  }
  for (const r of list) {
    const row = document.createElement('div');
    row.className = 'rev-head' + (r.status === 'accepted' ? ' accepted' : '');
    const title = document.createElement('div');
    title.className = 'rev-title';
    const note = r.note ? ` · ${escapeHtml(r.note)}` : '';
    title.innerHTML =
      `提议 #${r.id}${note}<div class="rev-note">` +
      `${r.item_count} 项 · 规则 v${r.rules_version_snapshot} · 字幕集 v${r.sub_version_snapshot} · ${r.created_at}` +
      (r.accepted_sub_version ? ` · 采纳于字幕集 v${r.accepted_sub_version}` : '') +
      '</div>';
    const tag = document.createElement('span');
    tag.className = 'status-tag' + (r.status === 'accepted' ? ' accepted' : '');
    tag.textContent = r.status === 'accepted' ? '✓ 已采纳' : '待采纳';
    const btn = document.createElement('button');
    btn.className = 'small secondary';
    btn.textContent = '查看/预览';
    btn.onclick = () => openRevision(r.id);
    row.append(title, tag, btn);
    box.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function revLine(label, value, cls) {
  const line = document.createElement('div');
  line.className = 'rev-line' + (cls ? ` ${cls}` : '');
  const k = document.createElement('span');
  k.className = 'k'; k.textContent = label;
  const v = document.createElement('span');
  v.className = 'v'; v.textContent = value;
  line.append(k, v);
  return line;
}

function renderRevItem(it) {
  const div = document.createElement('div');
  const hasProblems = it.state !== 'ok' || it.conflicts.length > 0;
  div.className = 'rev-item' + (hasProblems ? ' bad' : '');

  const head = document.createElement('div');
  head.className = 'rev-line';
  head.innerHTML =
    `<span class="k">第 ${it.ord + 1} 项</span>` +
    `<span class="v">字幕 #${it.subtitle_id}（读取版本 v${it.cue_version}）` +
    `<span class="state ${it.state === 'ok' ? 'ok' : ''}">${
      it.state === 'ok' ? '✓ 可采纳' :
      it.state === 'stale' ? '⚠ 行版本过期' :
      it.state === 'locked' ? '🔒 已锁定' : '✗ 已不存在'
    }</span></span>`;
  div.appendChild(head);

  div.appendChild(revLine('原值', `"${it.orig.text}" [${it.orig.start_ms}, ${it.orig.end_ms}]`));
  if (it.cue) {
    const changed = it.cue.text !== it.orig.text ||
      it.cue.start_ms !== it.orig.start_ms || it.cue.end_ms !== it.orig.end_ms;
    div.appendChild(revLine('当前值', `"${it.cue.text}" [${it.cue.start_ms}, ${it.cue.end_ms}]`,
      changed ? 'current' : ''));
  }
  div.appendChild(revLine('建议值', `"${it.proposed.text}" [${it.proposed.start_ms}, ${it.proposed.end_ms}]`,
    'proposed'));

  if (it.conflicts.length > 0) {
    const ul = document.createElement('ul');
    ul.className = 'rev-reasons';
    for (const c of it.conflicts) {
      const li = document.createElement('li');
      li.textContent = '• ' + c.message;
      ul.appendChild(li);
    }
    div.appendChild(ul);
  }
  return div;
}

async function openRevision(rid) {
  const p = state.project;
  const { status, body } = await api(`/api/projects/${p.id}/revisions/${rid}/preview`, { method: 'POST' });
  if (status !== 200) return toast(body?.error || '预览失败', true);
  const { revision, evaluation } = body;
  const panel = $('#rev-detail-panel');
  const box = $('#rev-detail-body');
  box.innerHTML = '';
  $('#rev-detail-title').textContent =
    `提议 #${revision.id}（${revision.status === 'accepted' ? '✓ 已采纳' : '待采纳'}）${
      revision.note ? '：' + escapeHtml(revision.note) : ''
    }`;

  if (evaluation.already_accepted) {
    const info = document.createElement('p');
    info.className = 'hint';
    info.textContent = `该提议已采纳（字幕集推进到 v${revision.accepted_sub_version}），重复提交不再改动字幕；以下为历史快照。`;
    box.appendChild(info);
  }

  const itemsBox = document.createElement('div');
  itemsBox.className = 'rev-items';
  for (const it of evaluation.items) itemsBox.appendChild(renderRevItem(it));
  box.appendChild(itemsBox);

  if (evaluation.conflicts && evaluation.conflicts.length > 0) {
    const ul = document.createElement('ul');
    ul.className = 'rev-reasons';
    for (const c of evaluation.conflicts) {
      const li = document.createElement('li');
      li.textContent = `整版：词 ${c.word_start}${c.word_end !== c.word_start ? '–' + c.word_end : ''} ${c.message}`;
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }

  if (revision.status === 'pending') {
    const actions = document.createElement('div');
    actions.className = 'rev-actions';
    const verdict = document.createElement('span');
    verdict.className = 'hint';
    verdict.style.flex = '1';
    verdict.textContent = evaluation.ok
      ? `✓ 整组核对通过（当前规则 v${p.rules.version}），可整组采纳（原子写入）`
      : '✗ 存在冲突或过期项，采纳将被整组拒绝';
    verdict.style.color = evaluation.ok ? 'var(--ok)' : 'var(--danger)';
    const acceptBtn = document.createElement('button');
    acceptBtn.textContent = '整组采纳';
    acceptBtn.disabled = !evaluation.ok;
    acceptBtn.style.opacity = evaluation.ok ? 1 : 0.5;
    acceptBtn.onclick = () => acceptRevision(rid);
    actions.append(verdict, acceptBtn);
    box.appendChild(actions);
  }
  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function submitRevision() {
  const p = state.project;
  if (!p) return toast('请先选择项目', true);
  let parsed;
  try {
    parsed = JSON.parse($('#rev-json').value || '{}');
  } catch (e) {
    return toast('JSON 解析失败：' + e.message, true);
  }
  const payload = { note: $('#rev-note').value.trim(), ...parsed };
  const { status, body } = await api(`/api/projects/${p.id}/revisions`, {
    method: 'POST', body: JSON.stringify(payload),
  });
  if (status === 201) {
    toast(`提议 #${body.id} 已保存（${body.items.length} 项），未改动正式字幕，请预览核对`);
    await loadProject(p.id);
    openRevision(body.id);
  } else if (status === 400) {
    toast('请求非法：' + (body.errors || []).join('；'), true);
  } else if (status === 422) {
    toast('目标状态校验失败：' + (body.errors || []).join('；'), true);
  } else {
    toast(body?.error || '提交失败', true);
  }
}

async function acceptRevision(rid) {
  const p = state.project;
  const { status, body } = await api(`/api/projects/${p.id}/revisions/${rid}/accept`, { method: 'POST' });
  if (status === 200) {
    toast(`✓ 提议 #${rid} 已整组采纳（${body.applied} 项，字幕集 v${body.sub_version}）`);
    await loadProject(p.id);
    openRevision(rid);
  } else if (status === 409 || status === 422) {
    const itemReasons = (body.items || [])
      .map((i) => `#${i.subtitle_id}: ${(i.reasons || []).map((r) => r.message).join('；')}`);
    const groupReasons = (body.conflicts || []).map((c) => c.message);
    toast((body.error || '采纳失败') +
      (itemReasons.length || groupReasons.length ? '：' + [...itemReasons, ...groupReasons].join('｜') : ''), true);
    await loadProject(p.id);
    openRevision(rid);
  } else {
    toast(body?.error || '采纳失败', true);
  }
}

function fillRevisionTemplate() {
  const p = state.project;
  if (!p) return toast('请先选择项目', true);
  const items = p.subtitles.filter((s) => !s.locked).map((s) => ({
    subtitle_id: s.id, cue_version: s.version, text: s.text,
    start_ms: s.start_ms, end_ms: s.end_ms,
  }));
  $('#rev-json').value = JSON.stringify({ items }, null, 2);
  toast('已填入全部未锁定行（按需删除/修改；时间字段可整段省略）');
}

// ---------- 逐词时间修正提议 ----------

function renderWordRevisions() {
  const p = state.project;
  const box = $('#wr-list');
  box.innerHTML = '';
  $('#wr-detail-panel').classList.add('hidden');
  if (!p) return;
  const list = p.word_revisions || [];
  const pending = list.filter((r) => r.status === 'pending').length;
  $('#wr-stats').textContent = `（共 ${list.length} 组，待确认 ${pending} 组）`;
  if (list.length === 0) {
    box.innerHTML = '<div class="empty">尚无逐词修正提议。校对发现词时间偏差时，可在左下角⑥按词序号提交。</div>';
    return;
  }
  for (const r of list) {
    const row = document.createElement('div');
    row.className = 'rev-head' + (r.status === 'confirmed' ? ' accepted' : '');
    const title = document.createElement('div');
    title.className = 'rev-title';
    const note = r.note ? ` · ${escapeHtml(r.note)}` : '';
    title.innerHTML =
      `词修正 #${r.id}${note}<div class="rev-note">` +
      `${r.item_count} 词 · 基于字幕集 v${r.sub_version_snapshot} · ${r.created_at}` +
      (r.confirmed_sub_version ? ` · 确认于字幕集 v${r.confirmed_sub_version}` : '') +
      '</div>';
    const tag = document.createElement('span');
    tag.className = 'status-tag' + (r.status === 'confirmed' ? ' accepted' : '');
    tag.textContent = r.status === 'confirmed' ? '✓ 已确认' : '待确认';
    const btn = document.createElement('button');
    btn.className = 'small secondary';
    btn.textContent = '查看/预览';
    btn.onclick = () => openWordRevision(r.id);
    row.append(title, tag, btn);
    box.appendChild(row);
  }
}

function renderWrItem(it) {
  const div = document.createElement('div');
  const hasProblems = it.state !== 'ok' || it.conflicts.length > 0;
  div.className = 'rev-item' + (hasProblems ? ' bad' : '');

  const head = document.createElement('div');
  head.className = 'rev-line';
  const text = it.word_text ? ` "${escapeHtml(it.word_text)}"` : '';
  head.innerHTML =
    `<span class="k">第 ${it.ord + 1} 项</span>` +
    `<span class="v">词 #${it.word_idx}${text}` +
    `<span class="state ${it.state === 'ok' ? 'ok' : ''}">${
      it.state === 'ok' ? '✓ 可应用' :
      it.state === 'drifted' ? '⚠ 词时间已变动' : '✗ 词已不存在'
    }</span></span>`;
  div.appendChild(head);

  div.appendChild(revLine('原值', `[${it.orig.start_ms}, ${it.orig.end_ms}]`));
  if (it.current) {
    const changed = it.current.start_ms !== it.orig.start_ms || it.current.end_ms !== it.orig.end_ms;
    div.appendChild(revLine('当前值', `[${it.current.start_ms}, ${it.current.end_ms}]`, changed ? 'current' : ''));
  }
  div.appendChild(revLine('建议值', `[${it.proposed.start_ms}, ${it.proposed.end_ms}]`, 'proposed'));

  if (it.conflicts.length > 0) {
    const ul = document.createElement('ul');
    ul.className = 'rev-reasons';
    for (const c of it.conflicts) {
      const li = document.createElement('li');
      li.textContent = '• ' + c.message;
      ul.appendChild(li);
    }
    div.appendChild(ul);
  }
  return div;
}

function renderWRCandidate(candidate) {
  const wrap = document.createElement('div');
  wrap.className = 'wr-candidate';
  const title = document.createElement('p');
  title.className = 'hint';
  title.textContent = '候选整版预览（确认后生效）：';
  wrap.appendChild(title);
  const table = document.createElement('div');
  table.className = 'cue-table';
  for (const c of candidate) {
    const row = document.createElement('div');
    row.className = 'cue-row wr-cue-' + c.origin + (c.locked ? ' locked' : '');
    row.innerHTML =
      `<div class="idx">词${c.word_start}–${c.word_end}</div>` +
      `<div>${c.start_ms}</div><div>${c.end_ms}</div>` +
      `<input class="text-input" value="${escapeHtml(c.text)}" readonly>` +
      `<div class="meta">${c.origin === 'kept'
        ? `保留 #${c.id} v${c.version}${c.locked ? ' 🔒' : ''}`
        : '重排新行（新 ID）'}</div><div></div>`;
    table.appendChild(row);
  }
  wrap.appendChild(table);
  return wrap;
}

async function openWordRevision(wrid) {
  const p = state.project;
  const { status, body } = await api(`/api/projects/${p.id}/word-revisions/${wrid}/preview`, { method: 'POST' });
  if (status !== 200) return toast(body?.error || '预览失败', true);
  const { revision, evaluation } = body;
  const panel = $('#wr-detail-panel');
  const box = $('#wr-detail-body');
  box.innerHTML = '';
  $('#wr-detail-title').textContent =
    `词修正 #${revision.id}（${revision.status === 'confirmed' ? '✓ 已确认' : '待确认'}）${
      revision.note ? '：' + escapeHtml(revision.note) : ''
    }`;

  if (evaluation.already_confirmed) {
    const info = document.createElement('p');
    info.className = 'hint';
    info.textContent = `该修正已确认（字幕集推进到 v${revision.confirmed_sub_version}），重复提交不再改动词与字幕；以下为历史快照。`;
    box.appendChild(info);
  }

  // 受影响字幕摘要
  if (revision.status === 'pending') {
    const sum = document.createElement('p');
    sum.className = 'hint';
    const rep = evaluation.replaced || [];
    const lk = evaluation.affected_locked || [];
    sum.innerHTML =
      `将重排 <strong>${rep.length}</strong> 条受影响未锁定字幕` +
      (rep.length ? `：${rep.map((s) => `#${s.id}`).join('、')}` : '') +
      `；含修正词的锁定字幕 <strong>${lk.length}</strong> 条` +
      (lk.length ? `：${lk.map((s) => `#${s.id}`).join('、')}（文本/时间原样保留）` : '') +
      `；其余字幕保留 ID、行版本与人工文本。`;
    box.appendChild(sum);
  }

  const itemsBox = document.createElement('div');
  itemsBox.className = 'rev-items';
  for (const it of evaluation.items) itemsBox.appendChild(renderWrItem(it));
  box.appendChild(itemsBox);

  if (evaluation.subtitles && evaluation.subtitles.length > 0) {
    box.appendChild(renderWRCandidate(evaluation.subtitles));
  }

  const allReasons = [];
  if (evaluation.conflicts && evaluation.conflicts.length > 0) {
    const ul = document.createElement('ul');
    ul.className = 'rev-reasons';
    for (const c of evaluation.conflicts) {
      const li = document.createElement('li');
      const range = c.word_start !== undefined
        ? `词 ${c.word_start}${c.word_end !== undefined && c.word_end !== c.word_start ? '–' + c.word_end : ''} `
        : '';
      li.textContent = `整版：${range}${c.message}`;
      ul.appendChild(li);
      allReasons.push(c.message);
    }
    box.appendChild(ul);
  }

  if (revision.status === 'pending') {
    const actions = document.createElement('div');
    actions.className = 'rev-actions';
    const verdict = document.createElement('span');
    verdict.className = 'hint';
    verdict.style.flex = '1';
    if (evaluation.stale) {
      verdict.textContent = '✗ 字幕集版本已过期（提交后字幕集被修改），请刷新后重新修正';
    } else {
      verdict.textContent = evaluation.ok
        ? '✓ 核对通过：确认后原子更新词时间、重排受影响区间并推进字幕集版本'
        : '✗ 存在冲突或失效项，确认将被整组拒绝（词与字幕均不变）';
    }
    verdict.style.color = evaluation.ok ? 'var(--ok)' : 'var(--danger)';
    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = '确认修正';
    confirmBtn.disabled = !evaluation.ok;
    confirmBtn.style.opacity = evaluation.ok ? 1 : 0.5;
    confirmBtn.onclick = () => confirmWordRevision(wrid);
    actions.append(verdict, confirmBtn);
    box.appendChild(actions);
  }
  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function submitWordRevision() {
  const p = state.project;
  if (!p) return toast('请先选择项目', true);
  let parsed;
  try {
    parsed = JSON.parse($('#wr-json').value || '{}');
  } catch (e) {
    return toast('JSON 解析失败：' + e.message, true);
  }
  const payload = { note: $('#wr-note').value.trim(), ...parsed };
  if (parsed.sub_version === undefined) payload.sub_version = p.sub_version;
  const { status, body } = await api(`/api/projects/${p.id}/word-revisions`, {
    method: 'POST', body: JSON.stringify(payload),
  });
  if (status === 201) {
    toast(`词修正 #${body.id} 已保存（${body.items.length} 词），未改动正式词与字幕，请预览核对`);
    await loadProject(p.id);
    openWordRevision(body.id);
  } else if (status === 400) {
    toast('请求非法：' + (body.errors || []).join('；'), true);
  } else if (status === 409) {
    toast(body.error, true);
    await loadProject(p.id);
  } else if (status === 422) {
    toast('词序列校验失败：' + (body.errors || []).join('；'), true);
  } else {
    toast(body?.error || '提交失败', true);
  }
}

async function confirmWordRevision(wrid) {
  const p = state.project;
  const { status, body } = await api(`/api/projects/${p.id}/word-revisions/${wrid}/confirm`, { method: 'POST' });
  if (status === 200) {
    toast(`✓ 词修正 #${wrid} 已确认：更新 ${body.words_updated} 词，重排 ${body.cues_replaced} 条字幕（字幕集 v${body.sub_version}）`);
    await loadProject(p.id);
    openWordRevision(wrid);
  } else if (status === 409 || status === 422) {
    const itemReasons = (body.items || []).map((i) =>
      `词${i.word_idx}: ${(i.reasons || []).map((r) => r.message).join('；')}`);
    const groupReasons = (body.conflicts || []).map((c) => c.message);
    toast((body.error || '确认失败') +
      (itemReasons.length || groupReasons.length ? '：' + [...itemReasons, ...groupReasons].slice(0, 3).join('｜') : ''), true);
    await loadProject(p.id);
    openWordRevision(wrid);
  } else {
    toast(body?.error || '确认失败', true);
  }
}

function fillWordRevisionTemplate() {
  const p = state.project;
  if (!p) return toast('请先选择项目', true);
  const items = p.words.map((w) => ({
    word_idx: w.idx, start_ms: w.start_ms, end_ms: w.end_ms,
  }));
  $('#wr-json').value = JSON.stringify({ sub_version: p.sub_version, items }, null, 2);
  toast('已填入全部词的当前时间（按需删改；只保留要修正的词即可）');
}

function renderConflicts(conflicts, title) {
  const panel = $('#conflict-panel');
  const ul = $('#conflict-list');
  ul.innerHTML = '';
  panel.querySelector('h2').textContent = title || '⚠ 冲突报告';
  for (const c of conflicts) {
    const li = document.createElement('li');
    const range = document.createElement('span');
    range.className = 'word-range';
    range.textContent = `词 ${c.word_start}${c.word_end !== c.word_start ? '–' + c.word_end : ''}`;
    li.append(range, document.createTextNode(c.message));
    ul.appendChild(li);
  }
  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearConflicts() {
  $('#conflict-panel').classList.add('hidden');
}

// ---------- 操作 ----------

async function saveCue(cue) {
  const edit = state.edits.get(cue.id);
  const payload = { version: cue.version };
  if (edit) Object.assign(payload, edit);
  const { status, body } = await api(
    `/api/projects/${state.project.id}/subtitles/${cue.id}`,
    { method: 'PATCH', body: JSON.stringify(payload) }
  );
  if (status === 200) {
    state.project.sub_version = body.sub_version;
    const i = state.project.subtitles.findIndex((s) => s.id === cue.id);
    state.project.subtitles[i] = body.subtitle;
    state.edits.delete(cue.id);
    renderSubtitles();
    toast(`字幕 #${cue.idx + 1} 已保存（v${body.subtitle.version}）`);
  } else if (status === 409) {
    toast(body.error + '，已刷新当前内容', true);
    await loadProject(state.project.id);
  } else {
    toast((body?.errors || [body?.error || '保存失败']).join('；'), true);
  }
}

async function toggleLock(cue) {
  const { status, body } = await api(
    `/api/projects/${state.project.id}/subtitles/${cue.id}`,
    { method: 'PATCH', body: JSON.stringify({ version: cue.version, locked: !cue.locked }) }
  );
  if (status === 200) {
    state.project.sub_version = body.sub_version;
    const i = state.project.subtitles.findIndex((s) => s.id === cue.id);
    state.project.subtitles[i] = body.subtitle;
    renderSubtitles();
    toast(body.subtitle.locked ? `字幕 #${cue.idx + 1} 已锁定，重排不再改动` : `字幕 #${cue.idx + 1} 已解锁`);
  } else if (status === 409) {
    toast(body.error + '，已刷新当前内容', true);
    await loadProject(state.project.id);
  } else {
    toast(body?.error || '操作失败', true);
  }
}

async function saveRules() {
  const p = state.project;
  if (!p) return toast('请先选择项目', true);
  const payload = {
    version: p.rules.version,
    max_chars: Number($('#rule-max-chars').value),
    min_duration_ms: Number($('#rule-min-duration').value),
    max_cps: Number($('#rule-max-cps').value),
  };
  const { status, body } = await api(`/api/projects/${p.id}/rules`, {
    method: 'PUT', body: JSON.stringify(payload),
  });
  if (status === 200) {
    state.project.rules = body;
    renderRules();
    renderSubtitles();
    toast(`规则已保存（v${body.version}），点击「重新排版」应用`);
  } else if (status === 409) {
    state.project.rules = body.current;
    renderRules();
    toast(body.error + '，已载入当前规则', true);
  } else {
    toast((body?.errors || [body?.error || '保存失败']).join('；'), true);
  }
}

async function runLayout() {
  const p = state.project;
  if (!p) return toast('请先选择项目', true);
  clearConflicts();
  const { status, body } = await api(`/api/projects/${p.id}/layout`, {
    method: 'POST', body: JSON.stringify({ sub_version: p.sub_version }),
  });
  if (status === 200) {
    state.project.sub_version = body.sub_version;
    state.project.subtitles = body.subtitles;
    state.edits.clear();
    renderSubtitles();
    toast(`排版完成：${body.subtitles.length} 条字幕（字幕集 v${body.sub_version}）`);
  } else if (status === 409) {
    toast(body.error, true);
    await loadProject(p.id);
  } else if (status === 422) {
    renderConflicts(body.conflicts || [], `⚠ ${body.error}`);
    toast(body.error, true);
  } else {
    toast(body?.error || '排版失败', true);
  }
}

async function doExport() {
  const p = state.project;
  if (!p) return toast('请先选择项目', true);
  clearConflicts();
  const { status, body } = await api(`/api/projects/${p.id}/exports`, {
    method: 'POST', body: JSON.stringify({ sub_version: p.sub_version }),
  });
  if (status === 201) {
    toast(`已确认导出 v${body.version}（${body.cue_count} 条），旧版本不受影响`);
    await loadProject(p.id);
  } else if (status === 409) {
    toast(body.error, true);
    await loadProject(p.id);
  } else if (status === 422) {
    renderConflicts(body.conflicts || [], `⚠ ${body.error}`);
    toast(body.error, true);
  } else {
    toast(body?.error || '导出失败', true);
  }
}

async function doImport() {
  const p = state.project;
  let data;
  try {
    data = JSON.parse($('#import-json').value);
  } catch (e) {
    return toast('JSON 解析失败：' + e.message, true);
  }
  const name = $('#import-name').value.trim();
  clearConflicts();

  if (name || !p) {
    // 新建项目
    const { status, body } = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: name || `项目 ${new Date().toLocaleString()}`, ...data }),
    });
    if (status === 201) {
      toast(`项目 #${body.id} 已创建（${body.words.length} 词 / ${body.cuts.length} 切点），请点击「重新排版」`);
      await loadProjects(body.id);
    } else {
      toast((body?.errors || [body?.error || '导入失败']).join('；'), true);
    }
    return;
  }

  // 导入当前项目
  const force = $('#import-force').checked;
  const { status, body } = await api(`/api/projects/${p.id}/import`, {
    method: 'POST', body: JSON.stringify({ ...data, force }),
  });
  if (status === 200) {
    toast(`已导入：${body.words.length} 词 / ${body.cuts.length} 切点，请点击「重新排版」`);
    await loadProject(p.id);
  } else if (status === 409) {
    $('#force-row').classList.remove('hidden');
    toast(body.error, true);
  } else {
    toast((body?.errors || [body?.error || '导入失败']).join('；'), true);
  }
}

async function newProject() {
  const name = prompt('新项目名称：', '未命名项目');
  if (!name) return;
  const { status, body } = await api('/api/projects', {
    method: 'POST', body: JSON.stringify({ name }),
  });
  if (status === 201) {
    toast(`项目 #${body.id} 已创建，请导入转写数据`);
    await loadProjects(body.id);
  } else {
    toast(body?.error || '创建失败', true);
  }
}

// ---------- 多语言译文字幕 ----------

async function loadTranslation(lang) {
  const p = state.project;
  if (!p || !lang) return;
  const { status, body } = await api(`/api/projects/${p.id}/translations/${encodeURIComponent(lang)}`);
  if (status !== 200) { toast(body?.error || '加载译文失败', true); return; }
  state.trLang = lang;
  state.trView = body;
  $('#tr-lang').value = lang;
  renderTranslations();
}

function trStateTag(stateName, valid) {
  if (stateName === 'missing') return '<span class="state">✗ 缺译</span>';
  if (stateName === 'review') return '<span class="state" style="color:var(--warn,#b8860b)">⚠ 待复核</span>';
  return valid
    ? '<span class="state ok">✓ 当前有效</span>'
    : '<span class="state" style="color:var(--danger)">✗ 规则不通过</span>';
}

function renderTranslations() {
  const panel = $('#tr-panel');
  const view = state.trView;
  if (!view) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  $('#tr-lang-tag').textContent = view.lang;
  const c = view.counts;
  $('#tr-stats').textContent =
    `共 ${c.cues} 条 · 当前 ${c.current}（有效 ${c.valid}）· 待复核 ${c.review} · 缺译 ${c.missing} · 历史 ${view.history.length}`;

  const box = $('#tr-table');
  box.innerHTML = '';
  for (const e of view.entries) {
    const cue = e.cue;
    const row = document.createElement('div');
    row.className = 'tr-row state-' + e.state + (e.valid ? ' valid' : '');

    const idx = document.createElement('div');
    idx.className = 'idx';
    idx.innerHTML = `${cue.idx + 1}<div class="word-ref">#${cue.id} · 词${cue.word_start}–${cue.word_end} · v${cue.version}${cue.locked ? ' 🔒' : ''}</div>`;

    const src = document.createElement('div');
    src.className = 'tr-src';
    src.innerHTML =
      `<div class="tr-meta">${fmtMs(cue.start_ms)} → ${fmtMs(cue.end_ms)}</div>` +
      `<div class="tr-src-text">${escapeHtml(cue.text)}</div>`;

    const wrap = document.createElement('div');
    wrap.className = 'tr-edit';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-input';
    input.value = e.translation ? e.translation.text : '';
    input.placeholder = e.state === 'missing' ? '输入译文后保存…' : '';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const updateMeta = () => {
      const len = input.value.length;
      const dur = cue.end_ms - cue.start_ms;
      const cps = dur > 0 ? (len / (dur / 1000)) : Infinity;
      const badLen = len > view.rules.max_chars;
      const badCps = cps > view.rules.max_cps;
      meta.innerHTML =
        `<span class="${badLen ? 'bad' : ''}">${len}/${view.rules.max_chars} 字</span> · ` +
        `<span class="${badCps ? 'bad' : ''}">${isFinite(cps) ? cps.toFixed(1) : '∞'}字/s</span>`;
    };
    updateMeta();
    input.addEventListener('input', updateMeta);

    const tagLine = document.createElement('div');
    tagLine.className = 'tr-tagline';
    tagLine.innerHTML = trStateTag(e.state, e.valid) +
      (e.translation ? ` <span class="hint">译文 v${e.translation.version}</span>` : '');
    for (const reason of e.invalid_reasons) {
      tagLine.innerHTML += `<div class="tr-reason">• ${escapeHtml(reason)}</div>`;
    }
    wrap.append(input, meta, tagLine);

    const ops = document.createElement('div');
    ops.className = 'ops';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'small primary';
    saveBtn.textContent = '保存译文';
    saveBtn.onclick = () => saveTranslation(cue, e, input.value);
    ops.appendChild(saveBtn);
    if (e.state === 'review') {
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'small secondary';
      confirmBtn.textContent = '✓ 确认仍适用';
      confirmBtn.onclick = () => confirmTranslation(cue, e);
      ops.appendChild(confirmBtn);
    }
    wrap.appendChild(ops);

    row.append(idx, src, wrap);
    box.appendChild(row);
  }

  // 导出快照列表
  const fillExports = (ul, list) => {
    ul.innerHTML = '';
    if (!list || list.length === 0) {
      ul.innerHTML = '<li class="empty">尚无译文导出快照</li>';
      return;
    }
    for (const ex of list) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `/api/projects/${state.project.id}/translations/${encodeURIComponent(view.lang)}/exports/${ex.version}`;
      a.textContent = `⬇ ${ex.lang} v${ex.version}.vtt`;
      a.download = `project-${state.project.id}-${ex.lang}-v${ex.version}.vtt`;
      const info = document.createElement('span');
      info.className = 'hint';
      info.textContent = `${ex.cue_count} 条 · ${ex.created_at}`;
      li.append(a, info);
      ul.appendChild(li);
    }
  };
  fillExports($('#tr-export-list2'), view.exports || []);

  // 历史译文
  const hist = $('#tr-history');
  hist.innerHTML = '';
  if (view.history.length === 0) {
    hist.innerHTML = '<div class="empty">无历史译文。</div>';
  } else {
    for (const h of view.history) {
      const div = document.createElement('div');
      div.className = 'tr-hist-item';
      div.innerHTML =
        `<span class="hint">#${h.id} 译文 v${h.version}（源快照：${h.src_start_ms}–${h.src_end_ms}ms，词${h.src_word_start}–${h.src_word_end}）</span> ` +
        `“${escapeHtml(h.text)}”`;
      hist.appendChild(div);
    }
  }
}

async function saveTranslation(cue, entry, text) {
  const p = state.project;
  const lang = state.trLang;
  const payload = {
    text,
    cue_version: cue.version,
    version: entry.translation ? entry.translation.version : 0,
  };
  const { status, body } = await api(
    `/api/projects/${p.id}/translations/${encodeURIComponent(lang)}/subtitles/${cue.id}`,
    { method: 'PUT', body: JSON.stringify(payload) }
  );
  if (status === 200 || status === 201) {
    toast(`字幕 #${cue.idx + 1} 译文已保存（v${body.translation.version}，当前有效）`);
    await loadTranslation(lang);
  } else if (status === 409) {
    toast(body.error + '，已刷新当前值', true);
    await loadTranslation(lang);
  } else {
    toast((body?.errors || [body?.error || '保存失败']).join('；'), true);
  }
}

async function confirmTranslation(cue, entry) {
  const p = state.project;
  const lang = state.trLang;
  const { status, body } = await api(
    `/api/projects/${p.id}/translations/${encodeURIComponent(lang)}/subtitles/${cue.id}/confirm`,
    { method: 'POST', body: JSON.stringify({ version: entry.translation.version }) }
  );
  if (status === 200) {
    toast(`字幕 #${cue.idx + 1} 译文已确认（v${body.translation.version}，恢复当前有效）`);
    await loadTranslation(lang);
  } else if (status === 409) {
    toast(body.error + '，已刷新当前值', true);
    await loadTranslation(lang);
  } else {
    toast((body?.errors || [body?.error || '确认失败']).join('；'), true);
  }
}

async function exportTranslation() {
  const p = state.project;
  let lang = state.trLang || $('#tr-lang').value.trim();
  if (!lang) return toast('请先填写目标语言代号并「载入语言」', true);
  const { status, body } = await api(
    `/api/projects/${p.id}/translations/${encodeURIComponent(lang)}/exports`,
    { method: 'POST', body: JSON.stringify({ sub_version: p.sub_version }) }
  );
  if (status === 201) {
    toast(`✓ ${lang} 译文已导出 v${body.version}（${body.cue_count} 条），快照不可变`);
    state.trLang = lang;
    await loadTranslation(lang);
  } else if (status === 422) {
    const parts = [];
    if (body.missing?.length) parts.push(`缺译 ${body.missing.length} 条：${body.missing.slice(0, 4).map((m) => `#${m.subtitle_id}`).join('、')}`);
    if (body.review?.length) parts.push(`待复核 ${body.review.length} 条`);
    if (body.invalid?.length) parts.push(`规则不通过 ${body.invalid.length} 条`);
    if (body.conflicts?.length) parts.push(`整版冲突 ${body.conflicts.length} 处：${body.conflicts.slice(0, 2).map((c) => c.message).join('｜')}`);
    toast(body.error + (parts.length ? '：' + parts.join('；') : ''), true);
    await loadTranslation(lang);
  } else if (status === 409) {
    toast(body.error, true);
    await loadProject(p.id);
  } else {
    toast(body?.error || '导出失败', true);
    if (status === 400) { /* 语言代号非法，不切换面板 */ }
  }
}

// ---------- 示例数据 ----------

const SAMPLE_WORDS = [
  ['大家好',100,700],['欢迎收看',750,1450],['本期',1500,1900],['节目',1950,2400],
  ['今天',2500,2900],['我们',2950,3300],['来到',3350,3700],['了',3750,3950],
  ['江边',4000,4450],['的',4500,4650],['老',4700,4900],['茶馆',4950,5450],
  ['这里',6100,6500],['每天',6550,6950],['都',7000,7150],['有',7200,7350],
  ['很多',7400,7800],['茶客',7850,8300],['一边',8400,8800],['喝茶',8850,9250],
  ['一边',9300,9700],['聊天',9750,10200],['老板',11100,11500],['说',11550,11700],
  ['这',11750,11850],['壶',11900,12050],['茶',12100,12250],['泡',12300,12500],
  ['了',12550,12700],['三十年',12750,13300],['镜头',14100,14500],['转向',14550,14950],
  ['窗外',15000,15400],['的',15450,15550],['江面',15600,16000],['雾气',16100,16500],
  ['正在',16550,16950],['缓缓',17000,17400],['升起',17450,17900],['我们',19100,19500],
  ['下期',19550,19950],['再见',20000,20600],
];

function samplePayload(cuts) {
  return JSON.stringify({
    words: SAMPLE_WORDS.map(([text, start_ms, end_ms]) => ({ text, start_ms, end_ms })),
    cuts,
  }, null, 2);
}

// ---------- 事件绑定 ----------

$('#project-select').addEventListener('change', (e) => loadProject(Number(e.target.value)));
$('#btn-new-project').addEventListener('click', newProject);
$('#btn-refresh').addEventListener('click', () => state.project && loadProject(state.project.id));
$('#btn-save-rules').addEventListener('click', saveRules);
$('#btn-layout').addEventListener('click', runLayout);
$('#btn-export').addEventListener('click', doExport);
$('#btn-import').addEventListener('click', doImport);
$('#btn-sample').addEventListener('click', () => {
  $('#import-json').value = samplePayload([6000, 11000, 14000, 19000]);
  toast('已载入示例，点击「导入」');
});
$('#btn-sample-conflict').addEventListener('click', () => {
  // 切点 1300ms 落在词「欢迎收看」[750,1450] 内部 → 必然冲突，用于演示冲突报告
  $('#import-json').value = samplePayload([1300, 6000, 11000, 14000, 19000]);
  toast('已载入冲突示例（切点落在词内部），导入后点「重新排版」查看冲突报告');
});
$('#btn-rev-submit').addEventListener('click', submitRevision);
$('#btn-rev-fill').addEventListener('click', fillRevisionTemplate);
$('#btn-wr-submit').addEventListener('click', submitWordRevision);
$('#btn-wr-fill').addEventListener('click', fillWordRevisionTemplate);
$('#btn-tr-load').addEventListener('click', () => {
  const lang = $('#tr-lang').value.trim();
  if (!lang) return toast('请填写目标语言代号（如 en、ja-JP）', true);
  loadTranslation(lang);
});
$('#tr-lang').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#btn-tr-load').click(); }
});
$('#btn-tr-export').addEventListener('click', exportTranslation);

loadProjects();
