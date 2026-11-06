// judging tool
// score entry -> totals -> ranks, all client side.
// todo: maybe add an undo button later

'use strict';

// helpers

const STORAGE_KEY = 'judging-tool.v1';
const THEME_KEY = 'judging-tool.theme';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let state;
let activeTab = 'setup';
let saveTimer = null;
let toastTimer = null;

function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function round(v, d = 1) {
  if (!isNum(v)) return v;
  const f = 10 ** d;
  return Math.round((v + Number.EPSILON) * f) / f;
}

function fmt(v, d) {
  if (!isNum(v)) return '—';
  const r = round(v, d);
  return Number.isInteger(r) ? String(r) : r.toFixed(d);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[m]));
}

function num(value) {
  const v = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(v) ? v : NaN;
}

// state / storage

function sampleState() {
  const criteria = [
    ['Presentation', 1, 10, 1],
    ['Content', 1, 10, 2],
    ['Impact', 1, 10, 1],
  ].map(([name, min, max, weight]) => ({ id: uid('c'), name, min, max, weight }));

  const participants = ['Team Alpha', 'Team Beta', 'Team Gamma'].map((name) => ({
    id: uid('p'),
    name,
  }));

  const judges = ['Judge 1', 'Judge 2', 'Judge 3'].map((name) => ({ id: uid('j'), name }));

  return {
    eventName: 'Annual Judging Event',
    decimals: 1,
    criteria,
    participants,
    judges,
    scores: {},
    activeJudgeId: judges[0].id,
  };
}

function sanitizeState(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const criteria = (Array.isArray(raw.criteria) ? raw.criteria : [])
    .filter((c) => c && c.id)
    .map((c) => {
      const min = Number(c.min);
      const max = Number(c.max);
      const weight = Number(c.weight);
      return {
        id: String(c.id),
        name: String(c.name ?? '').slice(0, 60),
        min: Number.isFinite(min) ? min : 0,
        max: Number.isFinite(max) ? max : 10,
        weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
      };
    });

  criteria.forEach((c) => {
    if (c.max <= c.min) c.max = c.min + 1;
  });

  const participants = (Array.isArray(raw.participants) ? raw.participants : [])
    .filter((p) => p && p.id)
    .map((p) => ({ id: String(p.id), name: String(p.name ?? '').slice(0, 60) }));

  const judges = (Array.isArray(raw.judges) ? raw.judges : [])
    .filter((j) => j && j.id)
    .map((j) => ({ id: String(j.id), name: String(j.name ?? '').slice(0, 60) }));

  const s = {
    eventName: String(raw.eventName ?? 'Judging Event').slice(0, 80),
    decimals: [0, 1, 2].includes(Number(raw.decimals)) ? Number(raw.decimals) : 1,
    criteria,
    participants,
    judges,
    scores: {},
    activeJudgeId: String(raw.activeJudgeId ?? ''),
  };

  const pIds = new Set(participants.map((p) => p.id));
  const jIds = new Set(judges.map((j) => j.id));
  const cIds = new Set(criteria.map((c) => c.id));
  const src = raw.scores && typeof raw.scores === 'object' ? raw.scores : {};

  for (const [jid, byP] of Object.entries(src)) {
    if (!jIds.has(jid) || !byP || typeof byP !== 'object') continue;
    for (const [pid, byC] of Object.entries(byP)) {
      if (!pIds.has(pid) || !byC || typeof byC !== 'object') continue;
      for (const [cid, value] of Object.entries(byC)) {
        const v = Number(value);
        if (!cIds.has(cid) || !Number.isFinite(v)) continue;
        (s.scores[jid] ??= {})[pid] ??= {};
        s.scores[jid][pid][cid] = v;
      }
    }
  }

  if (!jIds.has(s.activeJudgeId)) s.activeJudgeId = judges[0]?.id ?? '';
  return s;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return sanitizeState(JSON.parse(raw));
  } catch {
    return null;
  }
}

function save() {
  // console.log(state); // uncomment when debugging
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage might be blocked in some browsers, app still works in memory
  }
  const el = $('#saveState');
  if (!el) return;
  el.textContent = 'Saved ✓';
  el.classList.add('flash');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    el.textContent = 'Autosave on';
    el.classList.remove('flash');
  }, 1300);
}

let syncTimer = null;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(save, 220);
}

// math

function toPct(value, criterion) {
  const span = criterion.max - criterion.min;
  if (span <= 0) return 0;
  const pct = ((value - criterion.min) / span) * 100;
  return Math.min(100, Math.max(0, pct));
}

// total for one judge on one participant, 0-100
// missing criteria are skipped (completeness is shown in the ui)
function judgeTotal(judgeId, participantId) {
  const byC = state.scores[judgeId]?.[participantId];
  if (!byC) return null;

  let weighted = 0;
  let weightSum = 0;
  let scored = 0;

  for (const c of state.criteria) {
    const v = byC[c.id];
    if (!isNum(v)) continue;
    weighted += toPct(v, c) * c.weight;
    weightSum += c.weight;
    scored += 1;
  }

  if (!scored || weightSum === 0) return null;
  return { total: weighted / weightSum, scored, of: state.criteria.length };
}

function judgeProgress(judgeId) {
  const total = state.participants.length * state.criteria.length;
  let filled = 0;
  for (const p of state.participants) {
    const byC = state.scores[judgeId]?.[p.id];
    if (!byC) continue;
    for (const c of state.criteria) if (isNum(byC[c.id])) filled += 1;
  }
  return { filled, total };
}

function participantProgress(judgeId, participantId) {
  const byC = state.scores[judgeId]?.[participantId];
  let filled = 0;
  for (const c of state.criteria) if (isNum(byC?.[c.id])) filled += 1;
  return `${filled}/${state.criteria.length} scores`;
}

function getResults() {
  const rows = state.participants.map((p) => {
    const judgeTotals = {};
    let sum = 0;
    let count = 0;

    for (const j of state.judges) {
      const t = judgeTotal(j.id, p.id);
      judgeTotals[j.id] = t;
      if (t) {
        sum += t.total;
        count += 1;
      }
    }

    return {
      participant: p,
      judgeTotals,
      overall: count ? sum / count : null,
      judgesCount: count,
      rank: null,
    };
  });

  const ranked = rows
    .filter((r) => r.overall !== null)
    .sort((a, b) => b.overall - a.overall);

  let prevKey = null;
  let prevRank = 0;

  ranked.forEach((r, i) => {
    const key = round(r.overall, state.decimals);
    if (prevKey !== null && Math.abs(key - prevKey) < 1e-9) {
      r.rank = prevRank;
    } else {
      r.rank = i + 1;
      prevRank = r.rank;
    }
    prevKey = key;
  });

  return {
    rows,
    ranked,
    ordered: [...ranked, ...rows.filter((r) => r.overall === null)],
  };
}

function critAvg(participant, criterion) {
  let sum = 0;
  let n = 0;
  for (const j of state.judges) {
    const v = state.scores[j.id]?.[participant.id]?.[criterion.id];
    if (!isNum(v)) continue;
    sum += toPct(v, criterion);
    n += 1;
  }
  return n ? sum / n : null;
}

function setScore(judgeId, participantId, criterionId, value) {
  (state.scores[judgeId] ??= {})[participantId] ??= {};
  state.scores[judgeId][participantId][criterionId] = value;
}

function clearScore(judgeId, participantId, criterionId) {
  const byC = state.scores[judgeId]?.[participantId];
  if (!byC) return;
  delete byC[criterionId];
  if (!Object.keys(byC).length) delete state.scores[judgeId][participantId];
  if (state.scores[judgeId] && !Object.keys(state.scores[judgeId]).length) {
    delete state.scores[judgeId];
  }
}

// ui helpers

function updateBrand() {
  const name = (state.eventName || '').trim() || 'Judging Tool';
  $('#brandTitle').textContent = name;
  document.title = `${name} — Judging Tool`;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function rankBadge(rank) {
  if (!rank) return '<span class="muted">—</span>';
  return `<span class="rank rank-${rank}">${rank}</span>`;
}

function totalCell(jt, decimals) {
  if (!jt) return '<span class="muted">—</span>';
  const partial = jt.scored < jt.of;
  return `<span class="score-big">${fmt(jt.total, decimals)}</span>` +
    `<span class="score-sub${partial ? ' warn' : ''}">${jt.scored}/${jt.of} scored</span>`;
}

function overallCell(r, decimals) {
  if (r.overall === null) return '<span class="muted">—</span>';
  return `<span class="score-big">${fmt(r.overall, decimals)}</span>` +
    `<span class="score-sub">${r.judgesCount}/${state.judges.length} judges</span>`;
}

// setup

function criterionRow(c, i) {
  return `<div class="row crit-row" data-id="${c.id}">
    <span class="row-num">${i + 1}</span>
    <input type="text" data-role="crit-name" value="${esc(c.name)}" maxlength="60"
      placeholder="Criterion name" aria-label="Criterion ${i + 1} name" />
    <label class="mini"><span>Min</span>
      <input type="number" data-role="crit-min" value="${c.min}" step="any" aria-label="Minimum score" />
    </label>
    <label class="mini"><span>Max</span>
      <input type="number" data-role="crit-max" value="${c.max}" step="any" aria-label="Maximum score" />
    </label>
    <label class="mini"><span>Weight</span>
      <input type="number" data-role="crit-weight" value="${c.weight}" min="0.1" step="any" aria-label="Weight" />
    </label>
    <button class="icon-btn danger" type="button" data-role="del-criterion"
      title="Delete criterion" aria-label="Delete criterion">✕</button>
  </div>`;
}

function entityRow(item, i, role) {
  return `<div class="row" data-id="${item.id}">
    <span class="row-num">${i + 1}</span>
    <input type="text" data-role="${role}" value="${esc(item.name)}" maxlength="60"
      placeholder="${role === 'p-name' ? 'Participant name' : 'Judge name'}" aria-label="Name" />
    <button class="icon-btn danger" type="button" data-role="del"
      title="Remove" aria-label="Remove">✕</button>
  </div>`;
}

function renderSetup() {
  $('#eventName').value = state.eventName;
  $('#decimals').value = String(state.decimals);

  $('#criteriaList').innerHTML = state.criteria.length
    ? state.criteria.map(criterionRow).join('')
    : '<p class="empty">No criteria yet. Add your first criterion.</p>';

  $('#participantList').innerHTML = state.participants.length
    ? state.participants.map((p, i) => entityRow(p, i, 'p-name')).join('')
    : '<p class="empty">No participants yet.</p>';

  $('#judgeList').innerHTML = state.judges.length
    ? state.judges.map((j, i) => entityRow(j, i, 'j-name')).join('')
    : '<p class="empty">No judges yet.</p>';
}

// scoring

function renderScoring() {
  const bar = $('#judgeBar');
  const progress = $('#judgeProgress');
  const table = $('#scoreTable');
  const clearBtn = $('#clearJudgeScores');

  const missing = !state.judges.length
    ? 'Add at least one judge in Setup to start scoring.'
    : !state.participants.length
      ? 'Add at least one participant in Setup to start scoring.'
      : !state.criteria.length
        ? 'Add at least one criterion in Setup to start scoring.'
        : '';

  if (missing) {
    bar.innerHTML = '';
    progress.textContent = '';
    table.innerHTML = `<tbody><tr><td class="table-empty">${esc(missing)}</td></tr></tbody>`;
    clearBtn.disabled = true;
    return;
  }

  clearBtn.disabled = false;

  if (!state.judges.some((j) => j.id === state.activeJudgeId)) {
    state.activeJudgeId = state.judges[0].id;
  }

  bar.innerHTML = state.judges.map((j) => {
    const { filled, total } = judgeProgress(j.id);
    const active = j.id === state.activeJudgeId;
    return `<button class="judge-pill${active ? ' active' : ''}" type="button" data-judge="${j.id}">
      <span>${esc(j.name || 'Unnamed judge')}</span>
      <span class="judge-count">${filled}/${total}</span>
    </button>`;
  }).join('');

  const active = state.judges.find((j) => j.id === state.activeJudgeId);
  const prog = judgeProgress(state.activeJudgeId);
  progress.innerHTML = `<strong>${esc(active?.name || '')}</strong> — ${prog.filled} of ${prog.total} scores entered` +
    (prog.filled === prog.total ? ' · complete ✓' : '');

  const results = getResults();
  const byId = new Map(results.rows.map((r) => [r.participant.id, r]));
  const decimals = state.decimals;

  const head = `<thead><tr>
    <th class="sticky-col">Participant</th>
    ${state.criteria.map((c) => `<th>${esc(c.name || 'Criterion')}<span class="th-sub">${c.min}–${c.max} · w${c.weight}</span></th>`).join('')}
    <th>Total<span class="th-sub">this judge</span></th>
    <th>Overall<span class="th-sub">avg of judges</span></th>
    <th>Rank</th>
  </tr></thead>`;

  const body = state.participants.map((p) => {
    const r = byId.get(p.id);
    const jt = r?.judgeTotals[state.activeJudgeId] || null;

    const cells = state.criteria.map((c) => {
      const v = state.scores[state.activeJudgeId]?.[p.id]?.[c.id];
      return `<td><input class="score-input${isNum(v) ? ' has-value' : ''}" type="number" inputmode="decimal"
        step="any" min="${c.min}" max="${c.max}"
        data-judge="${state.activeJudgeId}" data-participant="${p.id}" data-criterion="${c.id}"
        value="${isNum(v) ? esc(String(v)) : ''}"
        aria-label="${esc(p.name)} — ${esc(c.name)}" /></td>`;
    }).join('');

    return `<tr data-participant="${p.id}">
      <td class="sticky-col">
        <span class="p-name">${esc(p.name || 'Unnamed')}</span>
        <span class="p-sub" data-progress>${participantProgress(state.activeJudgeId, p.id)}</span>
      </td>
      ${cells}
      <td class="cell-total" data-total>${totalCell(jt, decimals)}</td>
      <td class="cell-total" data-overall>${overallCell(r, decimals)}</td>
      <td data-rank>${rankBadge(r?.rank)}</td>
    </tr>`;
  }).join('');

  table.innerHTML = head + `<tbody>${body}</tbody>`;
}

// only update the total/rank cells. re-rendering the whole table
// would steal focus while someone is typing a score
function updateLiveScoring() {
  if (activeTab !== 'scoring') return;

  const results = getResults();
  const byId = new Map(results.rows.map((r) => [r.participant.id, r]));

  $$('#scoreTable tbody tr[data-participant]').forEach((tr) => {
    const r = byId.get(tr.dataset.participant);
    if (!r) return;
    const jt = r.judgeTotals[state.activeJudgeId] || null;
    const totalEl = tr.querySelector('[data-total]');
    const overallEl = tr.querySelector('[data-overall]');
    const rankEl = tr.querySelector('[data-rank]');
    const progEl = tr.querySelector('[data-progress]');
    if (totalEl) totalEl.innerHTML = totalCell(jt, state.decimals);
    if (overallEl) overallEl.innerHTML = overallCell(r, state.decimals);
    if (rankEl) rankEl.innerHTML = rankBadge(r.rank);
    if (progEl) progEl.textContent = participantProgress(state.activeJudgeId, r.participant.id);
  });

  $$('#judgeBar [data-judge]').forEach((btn) => {
    const { filled, total } = judgeProgress(btn.dataset.judge);
    const count = btn.querySelector('.judge-count');
    if (count) count.textContent = `${filled}/${total}`;
  });

  const active = state.judges.find((j) => j.id === state.activeJudgeId);
  const prog = judgeProgress(state.activeJudgeId);
  const progressEl = $('#judgeProgress');
  if (progressEl) {
    progressEl.innerHTML = `<strong>${esc(active?.name || '')}</strong> — ${prog.filled} of ${prog.total} scores entered` +
      (prog.filled === prog.total ? ' · complete ✓' : '');
  }
}

// results

function renderResults() {
  const lb = $('#leaderboard');
  const bd = $('#breakdown');
  const decimals = state.decimals;

  if (!state.participants.length || !state.judges.length || !state.criteria.length) {
    lb.innerHTML = `<tbody><tr><td class="table-empty">Set up criteria, participants and judges to see results.</td></tr></tbody>`;
    bd.innerHTML = '';
    return;
  }

  const results = getResults();

  lb.innerHTML = `<thead><tr>
    <th>Rank</th>
    <th>Participant</th>
    <th>Overall<span class="th-sub">weighted %</span></th>
    ${state.judges.map((j) => `<th>${esc(j.name || 'Unnamed judge')}</th>`).join('')}
  </tr></thead>
  <tbody>
    ${results.ordered.map((r) => {
      const podium = r.rank && r.rank <= 3 ? ' class="podium"' : '';
      return `<tr${podium}>
        <td>${rankBadge(r.rank)}</td>
        <td><span class="p-name">${esc(r.participant.name || 'Unnamed')}</span></td>
        <td class="cell-total">${overallCell(r, decimals)}</td>
        ${state.judges.map((j) => {
          const t = r.judgeTotals[j.id];
          if (!t) return '<td class="cell-total"><span class="muted">—</span></td>';
          const partial = t.scored < t.of;
          return `<td class="cell-total"><span class="score-big">${fmt(t.total, decimals)}</span>` +
            `<span class="score-sub${partial ? ' warn' : ''}">${partial ? `${t.scored}/${t.of} criteria` : 'complete'}</span></td>`;
        }).join('')}
      </tr>`;
    }).join('')}
  </tbody>`;

  bd.innerHTML = `<thead><tr>
    <th>Participant</th>
    ${state.criteria.map((c) => `<th>${esc(c.name || 'Criterion')}<span class="th-sub">avg % · w${c.weight}</span></th>`).join('')}
    <th>Overall</th>
  </tr></thead>
  <tbody>
    ${results.ordered.map((r) => `<tr>
      <td><span class="p-name">${esc(r.participant.name || 'Unnamed')}</span>
        <span class="p-sub">${r.rank ? `Rank ${r.rank}` : 'Not scored yet'}</span></td>
      ${state.criteria.map((c) => {
        const avg = critAvg(r.participant, c);
        return `<td class="cell-total">${avg === null ? '<span class="muted">—</span>' : `<span class="score-big">${fmt(avg, decimals)}%</span>`}</td>`;
      }).join('')}
      <td class="cell-total">${r.overall === null ? '<span class="muted">—</span>' : `<span class="score-big">${fmt(r.overall, decimals)}</span>`}</td>
    </tr>`).join('')}
  </tbody>`;
}

// tabs / theme

function setTab(name) {
  activeTab = name;
  $$('.tab').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
  if (name === 'setup') renderSetup();
  if (name === 'scoring') renderScoring();
  if (name === 'results') renderResults();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $('#themeToggle');
  if (btn) {
    btn.textContent = theme === 'dark' ? '☀️' : '🌙';
    btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  }
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // ignore
  }
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    // ignore
  }
  const dark = saved ? saved === 'dark' : window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  applyTheme(dark ? 'dark' : 'light');
}

// setup events

function validateCriterion(c) {
  if (!Number.isFinite(c.min)) c.min = 0;
  if (!Number.isFinite(c.max)) c.max = 10;
  if (c.max <= c.min) c.max = c.min + 1;
  if (!Number.isFinite(c.weight) || c.weight <= 0) c.weight = 1;
}

function clampScoresFor(c) {
  for (const byP of Object.values(state.scores)) {
    for (const byC of Object.values(byP)) {
      if (isNum(byC[c.id])) {
        byC[c.id] = round(Math.min(c.max, Math.max(c.min, byC[c.id])), state.decimals);
      }
    }
  }
}

function bindEntityList(containerSelector, key, role) {
  const el = $(containerSelector);

  el.addEventListener('input', (e) => {
    if (e.target.dataset.role !== role) return;
    const row = e.target.closest('[data-id]');
    if (!row) return;
    const item = state[key].find((x) => x.id === row.dataset.id);
    if (!item) return;
    item.name = e.target.value.slice(0, 60);
    scheduleSync();
  });

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-role="del"]');
    if (!btn) return;
    const row = btn.closest('[data-id]');
    if (!row) return;
    removeEntity(key, row.dataset.id);
  });
}

function removeEntity(key, id) {
  state[key] = state[key].filter((x) => x.id !== id);

  if (key === 'participants') {
    for (const byP of Object.values(state.scores)) delete byP[id];
  }
  if (key === 'judges') {
    delete state.scores[id];
    if (state.activeJudgeId === id) state.activeJudgeId = state.judges[0]?.id ?? '';
  }

  save();
  renderSetup();
  if (activeTab === 'scoring') renderScoring();
  if (activeTab === 'results') renderResults();
}

function bindSetupEvents() {
  $('#eventName').addEventListener('input', (e) => {
    state.eventName = e.target.value.slice(0, 80);
    updateBrand();
    scheduleSync();
  });

  $('#decimals').addEventListener('change', (e) => {
    state.decimals = Number(e.target.value);
    save();
    if (activeTab === 'scoring') renderScoring();
    if (activeTab === 'results') renderResults();
  });

  $('#criteriaList').addEventListener('input', (e) => {
    const target = e.target;
    const row = target.closest('.crit-row');
    if (!row) return;
    const c = state.criteria.find((x) => x.id === row.dataset.id);
    if (!c) return;

    const role = target.dataset.role;
    if (role === 'crit-name') {
      c.name = target.value.slice(0, 60);
    } else if (role === 'crit-min' || role === 'crit-max') {
      const v = num(target.value);
      if (!Number.isFinite(v)) return;
      c[role === 'crit-min' ? 'min' : 'max'] = v;
      clampScoresFor(c);
    } else if (role === 'crit-weight') {
      const v = num(target.value);
      if (!Number.isFinite(v) || v <= 0) return;
      c.weight = v;
    } else {
      return;
    }
    scheduleSync();
  });

  $('#criteriaList').addEventListener('change', (e) => {
    const row = e.target.closest('.crit-row');
    if (!row) return;
    const c = state.criteria.find((x) => x.id === row.dataset.id);
    if (!c) return;
    const role = e.target.dataset.role;
    if (role !== 'crit-min' && role !== 'crit-max' && role !== 'crit-weight') return;

    validateCriterion(c);
    clampScoresFor(c);

    row.querySelector('[data-role="crit-min"]').value = String(c.min);
    row.querySelector('[data-role="crit-max"]').value = String(c.max);
    row.querySelector('[data-role="crit-weight"]').value = String(c.weight);
    save();
  });

  $('#criteriaList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-role="del-criterion"]');
    if (!btn) return;
    const row = btn.closest('[data-id]');
    if (!row) return;
    const id = row.dataset.id;

    state.criteria = state.criteria.filter((c) => c.id !== id);
    for (const byP of Object.values(state.scores)) {
      for (const byC of Object.values(byP)) delete byC[id];
    }

    save();
    renderSetup();
    if (activeTab === 'scoring') renderScoring();
    if (activeTab === 'results') renderResults();
  });

  $('#addCriterion').addEventListener('click', () => {
    state.criteria.push({
      id: uid('c'),
      name: `Criterion ${state.criteria.length + 1}`,
      min: 0,
      max: 10,
      weight: 1,
    });
    save();
    renderSetup();
    const inputs = $$('#criteriaList [data-role="crit-name"]');
    inputs[inputs.length - 1]?.select();
  });

  $('#addParticipant').addEventListener('click', () => {
    state.participants.push({ id: uid('p'), name: `Participant ${state.participants.length + 1}` });
    save();
    renderSetup();
    const inputs = $$('#participantList [data-role="p-name"]');
    inputs[inputs.length - 1]?.select();
  });

  $('#addJudge').addEventListener('click', () => {
    const judge = { id: uid('j'), name: `Judge ${state.judges.length + 1}` };
    state.judges.push(judge);
    if (!state.activeJudgeId) state.activeJudgeId = judge.id;
    save();
    renderSetup();
    const inputs = $$('#judgeList [data-role="j-name"]');
    inputs[inputs.length - 1]?.select();
  });

  bindEntityList('#participantList', 'participants', 'p-name');
  bindEntityList('#judgeList', 'judges', 'j-name');

  $('#clearAllScores').addEventListener('click', () => {
    if (!confirm('Clear every score? Criteria, participants and judges will stay.')) return;
    state.scores = {};
    save();
    if (activeTab === 'scoring') renderScoring();
    if (activeTab === 'results') renderResults();
    toast('All scores cleared');
  });

  $('#resetProject').addEventListener('click', () => {
    if (!confirm('Reset the whole project back to the sample setup? Your current setup and scores will be lost.')) return;
    state = sampleState();
    save();
    renderSetup();
    if (activeTab === 'scoring') renderScoring();
    if (activeTab === 'results') renderResults();
    toast('Project reset to sample data');
  });
}

// scoring events

function bindScoringEvents() {
  $('#judgeBar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-judge]');
    if (!btn) return;
    state.activeJudgeId = btn.dataset.judge;
    save();
    renderScoring();
  });

  $('#scoreTable').addEventListener('input', (e) => {
    const input = e.target.closest('.score-input');
    if (!input) return;

    const { judge, participant, criterion } = input.dataset;
    const raw = input.value.trim();
    const v = raw === '' ? NaN : num(raw);

    if (Number.isFinite(v)) {
      setScore(judge, participant, criterion, v);
      input.classList.add('has-value');
    } else {
      clearScore(judge, participant, criterion);
      input.classList.remove('has-value');
    }

    updateLiveScoring();
    scheduleSync();
  });

  $('#scoreTable').addEventListener('change', (e) => {
    const input = e.target.closest('.score-input');
    if (!input) return;

    const { judge, participant, criterion } = input.dataset;
    const c = state.criteria.find((x) => x.id === criterion);
    if (!c) return;

    const v = num(input.value);

    if (!Number.isFinite(v) || input.value.trim() === '') {
      clearScore(judge, participant, criterion);
      input.value = '';
      input.classList.remove('has-value');
    } else {
      const clamped = Math.min(c.max, Math.max(c.min, v));
      const final = round(clamped, state.decimals);
      input.value = String(final);
      input.classList.add('has-value');
      setScore(judge, participant, criterion, final);
    }

    updateLiveScoring();
    save();
  });

  $('#clearJudgeScores').addEventListener('click', () => {
    const judge = state.judges.find((j) => j.id === state.activeJudgeId);
    if (!judge) return;
    if (!confirm(`Clear all scores entered by ${judge.name || 'this judge'}?`)) return;
    delete state.scores[judge.id];
    save();
    renderScoring();
    toast(`Scores cleared for ${judge.name || 'judge'}`);
  });
}

// results events

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv() {
  const results = getResults();
  const decimals = state.decimals;

  const header = [
    'Rank',
    'Participant',
    'Overall %',
    ...state.judges.map((j) => `${j.name || 'Judge'} %`),
    ...state.criteria.map((c) => `${c.name || 'Criterion'} avg %`),
  ];

  const lines = [header];
  for (const r of results.ordered) {
    lines.push([
      r.rank ?? '',
      r.participant.name,
      r.overall === null ? '' : round(r.overall, decimals),
      ...state.judges.map((j) => {
        const t = r.judgeTotals[j.id];
        return t ? round(t.total, decimals) : '';
      }),
      ...state.criteria.map((c) => {
        const avg = critAvg(r.participant, c);
        return avg === null ? '' : round(avg, decimals);
      }),
    ]);
  }

  const csv = lines.map((row) => row.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(state.eventName || 'judging').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'judging'}-results.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('CSV downloaded');
}

function bindResultsEvents() {
  $('#exportCsv').addEventListener('click', exportCsv);

  $('#printBtn').addEventListener('click', () => {
    setTab('results');
    renderResults();
    setTimeout(() => window.print(), 120);
  });
}

// start

function init() {
  state = loadState() ?? sampleState();

  initTheme();
  updateBrand();

  $$('.tab').forEach((btn) => {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  });

  $('#themeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  });

  bindSetupEvents();
  bindScoringEvents();
  bindResultsEvents();

  setTab('setup');
}

init();
