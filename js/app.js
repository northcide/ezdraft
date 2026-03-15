/* EasyDraft – Frontend Logic */
'use strict';

const API = {
  players: 'api/players.php',
  teams:   'api/teams.php',
  drafts:  'api/drafts.php',
  auth:    'api/auth.php',
};

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  draft:            null,
  picks:            [],
  teams:            [],
  players:          [],
  role:             '',
  leagueName:       '',
  allDrafts:        [],
  accessibleDrafts: [],
  selectedDraftId:  null,
  serverOffset:     0,
  pollInterval:     null,
  timerInterval:    null,
  timerMax:         0,
  announcementTimeout: null,
  dragPlayerId:     null,
  teamsNeedSetup:       false,
  mobilePlayerListVisible:  false,
  mobileAvailableOnly:      true,
};

// ── Auth ──────────────────────────────────────────────────────────────────────
async function checkAuth() {
  try {
    const data = await api(API.auth, 'check');
    state.role            = data.role;
    state.leagueName      = data.league_name;
    state.accessibleDrafts = data.accessibleDrafts || [];
    applyRole();
    document.getElementById('login-overlay').classList.add('hidden');
    return true;
  } catch (_) {
    showLogin();
    return false;
  }
}

function showLogin() {
  document.getElementById('login-overlay').classList.remove('hidden');
}

function applyRole() {
  const isAdmin = state.role === 'admin';
  document.querySelectorAll('.admin-only').forEach(el => {
    el.classList.toggle('hidden', !isAdmin);
  });
  document.getElementById('rankings-panel').classList.toggle('hidden', !isAdmin);
  document.getElementById('topbar-role').textContent =
    isAdmin ? '(Admin)' : '(Coach \u2014 view only)';
}

document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const league = document.getElementById('login-league').value.trim();
  const pin    = document.getElementById('login-pin').value.trim();
  const errEl  = document.getElementById('login-error');
  errEl.classList.add('hidden');
  try {
    const data = await api(API.auth, 'login', { league_name: league, pin });
    state.role             = data.role;
    state.leagueName       = data.league_name;
    state.accessibleDrafts = data.accessibleDrafts || [];
    applyRole();
    document.getElementById('login-overlay').classList.add('hidden');
    await init();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  if (state.teamsNeedSetup && !confirm('You have unsaved pick order changes. Sign out anyway?')) {
    switchAdminTab('teams');
    return;
  }
  await api(API.auth, 'logout', {});
  stopTimer();
  stopPolling();
  state.role = '';
  state.allDrafts = [];
  state.accessibleDrafts = [];
  state.selectedDraftId = null;
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('admin-panel').classList.add('hidden');
});

// ── API helpers ───────────────────────────────────────────────────────────────
async function api(endpoint, action, body = null) {
  const url  = `${endpoint}?action=${action}`;
  const opts = {
    method:  body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body:    body ? JSON.stringify(body) : undefined,
  };
  const res  = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function apiForm(endpoint, action, formData) {
  const res  = await fetch(`${endpoint}?action=${action}`, { method: 'POST', body: formData });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ── Polling ───────────────────────────────────────────────────────────────────
function startPolling() {
  stopPolling();
  state.pollInterval = setInterval(fetchState, 2000);
}
function stopPolling() {
  if (state.pollInterval) { clearInterval(state.pollInterval); state.pollInterval = null; }
}

async function fetchState() {
  try {
    const data = await api(API.drafts, 'state');
    if (data.serverTime) state.serverOffset = Date.now() - new Date(data.serverTime).getTime();
    applyState(data);
  } catch (e) {
    console.warn('Poll error:', e.message);
  }
}

function applyState(data) {
  state.draft           = data.draft;
  state.picks           = data.picks   || [];
  state.teams           = data.teams   || [];
  state.players         = data.players || [];
  if (data.role)             state.role            = data.role;
  if (data.allDrafts)        state.allDrafts        = data.allDrafts;
  if (data.accessibleDrafts) state.accessibleDrafts = data.accessibleDrafts;
  if (data.selectedDraftId !== undefined) state.selectedDraftId = data.selectedDraftId;

  if (state.draft) state.timerMax = state.draft.timer_minutes * 60;

  // Update board title
  const boardTitle = document.getElementById('board-draft-name');
  if (boardTitle) boardTitle.textContent = state.draft?.name || 'Draft Board';

  renderAdminDraftSelector();
  renderCoachDraftBar();
  fillSettingsForm();
  renderRankings();
  renderBoard();
  renderTeamList();
  renderReorderList();
  updateControls();
  updateStatusBadge();
  updateCurrentPickLabel();

  // Timer
  if (state.draft?.status === 'active') {
    if (!state.timerInterval) startTimer();
    if (!state.pollInterval)  startPolling();
  } else {
    stopTimer();
    updateTimerDisplay(null);
    if (state.draft?.status === 'completed') stopPolling();
  }
}

// ── Draft Selector (Admin) ────────────────────────────────────────────────────
function renderAdminDraftSelector() {
  const sel = document.getElementById('draft-selector');
  if (!sel) return;

  const drafts = state.allDrafts || [];

  sel.innerHTML = '<option value="">\u2014 Select a draft \u2014</option>';
  drafts.forEach(d => {
    const opt = document.createElement('option');
    opt.value       = d.id;
    opt.textContent = `${d.name} (${d.status})`;
    if (d.id == state.selectedDraftId) opt.selected = true;
    sel.appendChild(opt);
  });

  // Update badge and delete button
  const badge   = document.getElementById('draft-selector-badge');
  const delBtn  = document.getElementById('btn-delete-draft');
  const content = document.getElementById('draft-content');

  const controls = document.getElementById('draft-controls-inline');
  if (state.draft && state.selectedDraftId) {
    badge.className = `badge badge-${state.draft.status}`;
    badge.textContent = state.draft.status;
    badge.classList.remove('hidden');
    delBtn.classList.toggle('hidden', state.draft.status === 'active');
    if (content)   content.classList.remove('hidden');
    if (controls) controls.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
    delBtn.classList.add('hidden');
    if (content)   content.classList.add('hidden');
    if (controls) controls.classList.add('hidden');
  }
}

document.getElementById('draft-selector').addEventListener('change', async function() {
  if (state.teamsNeedSetup) {
    // Revert the visual selection back; block navigation
    this.value = state.selectedDraftId || '';
    shakeSetupWarning();
    switchAdminTab('players');
    return;
  }
  const id = parseInt(this.value, 10);
  if (!id) {
    state.selectedDraftId = null;
    state.draft = null;
    renderAdminDraftSelector();
    renderBoard();
    updateControls();
    updateStatusBadge();
    return;
  }
  try {
    const data = await api(API.drafts, 'select', { id });
    applyState(data);
  } catch (e) {
    alert('Error: ' + e.message);
  }
});

// ── Coach Draft Bar ───────────────────────────────────────────────────────────
function renderCoachDraftBar() {
  if (state.role !== 'coach') return;
  const bar = document.getElementById('coach-draft-bar');
  const sel = document.getElementById('coach-draft-selector');
  if (!bar || !sel) return;

  const drafts = state.accessibleDrafts || [];
  if (drafts.length <= 1) {
    bar.classList.add('hidden');
    return;
  }

  bar.classList.remove('hidden');
  sel.innerHTML = '';
  drafts.forEach(d => {
    const opt = document.createElement('option');
    opt.value       = d.id;
    opt.textContent = `${d.name} (${d.status})`;
    if (d.id == state.selectedDraftId || d.id == state.draft?.id) opt.selected = true;
    sel.appendChild(opt);
  });
}

document.getElementById('coach-draft-selector').addEventListener('change', async function() {
  const id = parseInt(this.value, 10);
  if (!id) return;
  try {
    const data = await api(API.drafts, 'coach_select', { id });
    applyState(data);
  } catch (e) {
    alert('Error: ' + e.message);
  }
});

// ── Settings Form ─────────────────────────────────────────────────────────────
function fillSettingsForm() {
  const d = state.draft;
  const nameEl      = document.getElementById('setting-draft-name');
  const timerEl     = document.getElementById('setting-timer');
  const autoEl      = document.getElementById('setting-autopick');
  const coachNameEl = document.getElementById('setting-coach-name');
  const coachPinEl  = document.getElementById('setting-coach-pin');

  if (!nameEl) return;
  if (d) {
    nameEl.value      = d.name          || '';
    timerEl.value     = d.timer_minutes || 2;
    autoEl.checked    = !!d.auto_pick_enabled;
    coachNameEl.value = d.coach_name    || '';
    coachPinEl.value  = d.coach_pin     || '';
  } else {
    nameEl.value = ''; timerEl.value = 2;
    autoEl.checked = true; coachNameEl.value = ''; coachPinEl.value = '';
  }
}

// ── New Draft ─────────────────────────────────────────────────────────────────
document.getElementById('btn-new-draft').addEventListener('click', () => {
  document.getElementById('new-draft-inline').classList.remove('hidden');
  document.getElementById('btn-new-draft').classList.add('hidden');
  document.getElementById('new-draft-name').focus();
});
document.getElementById('btn-cancel-new-draft').addEventListener('click', () => {
  document.getElementById('new-draft-inline').classList.add('hidden');
  document.getElementById('btn-new-draft').classList.remove('hidden');
  document.getElementById('new-draft-name').value = '';
});
document.getElementById('btn-confirm-new-draft').addEventListener('click', async () => {
  const name = document.getElementById('new-draft-name').value.trim();
  if (!name) { alert('Enter a draft name'); return; }
  try {
    const data = await api(API.drafts, 'create', { name });
    document.getElementById('new-draft-name').value = '';
    document.getElementById('new-draft-inline').classList.add('hidden');
    document.getElementById('btn-new-draft').classList.remove('hidden');
    applyState(data);
    switchAdminTab('settings');
  } catch (e) {
    alert('Error: ' + e.message);
  }
});
document.getElementById('new-draft-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-confirm-new-draft').click();
  if (e.key === 'Escape') document.getElementById('btn-cancel-new-draft').click();
});

// ── Delete Draft ──────────────────────────────────────────────────────────────
document.getElementById('btn-delete-draft').addEventListener('click', async () => {
  if (!state.draft) return;
  if (!confirm(`Delete draft "${state.draft.name}"? This cannot be undone.`)) return;
  try {
    const data = await api(API.drafts, 'delete', { id: state.draft.id });
    applyState(data);
  } catch (e) {
    alert('Error: ' + e.message);
  }
});

// ── Save Settings ─────────────────────────────────────────────────────────────
document.getElementById('btn-save-settings').addEventListener('click', async () => {
  if (!state.draft) return;
  const payload = {
    name:              document.getElementById('setting-draft-name').value.trim(),
    timer_minutes:     parseInt(document.getElementById('setting-timer').value, 10),
    auto_pick_enabled: document.getElementById('setting-autopick').checked ? 1 : 0,
    coach_name:        document.getElementById('setting-coach-name').value.trim(),
    coach_pin:         document.getElementById('setting-coach-pin').value.trim(),
  };
  try {
    const data = await api(API.drafts, 'update_settings', payload);
    applyState(data);
  } catch (e) {
    alert('Error: ' + e.message);
  }
});

// ── Setup Pick Order ──────────────────────────────────────────────────────────
document.getElementById('btn-setup-picks').addEventListener('click', async () => {
  if (!state.draft) return;
  if (!confirm('Build pick order from current teams? This will reset any pre-assignments.')) return;
  try {
    const data = await api(API.drafts, 'setup_picks', {});
    setTeamsNeedSetup(false);
    applyState(data);
  } catch (e) {
    alert('Error: ' + e.message);
  }
});

document.getElementById('btn-setup-picks-cancel').addEventListener('click', () => {
  setTeamsNeedSetup(false);
});

// ── Timer ─────────────────────────────────────────────────────────────────────
function startTimer() {
  stopTimer();
  state.timerInterval = setInterval(tickTimer, 250);
}
function stopTimer() {
  if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
}
function tickTimer() {
  if (!state.draft || state.draft.status !== 'active') { stopTimer(); return; }
  if (!state.draft.auto_pick_enabled || !state.draft.timer_end) { updateTimerDisplay(null); return; }
  const serverNow = Date.now() - state.serverOffset;
  const remainMs  = new Date(state.draft.timer_end).getTime() - serverNow;
  const remainSec = Math.max(0, Math.ceil(remainMs / 1000));
  updateTimerDisplay(remainSec);
  if (remainMs <= 0) { stopTimer(); triggerAutoPick(); }
}

function updateTimerDisplay(seconds) {
  const display   = document.getElementById('timer-display');
  const countdown = document.getElementById('timer-countdown');
  const bar       = document.getElementById('timer-bar');
  if (!state.draft?.auto_pick_enabled || seconds === null) { display.classList.add('hidden'); return; }
  display.classList.remove('hidden');
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  countdown.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
  const pct = state.timerMax > 0 ? (seconds / state.timerMax) * 100 : 100;
  bar.style.width = `${pct}%`;
  countdown.className = 'timer-countdown';
  bar.style.background = 'var(--accent2)';
  if (seconds <= 30) { countdown.classList.add('warn'); bar.style.background = 'var(--warn)'; }
  if (seconds <= 10) { countdown.classList.remove('warn'); countdown.classList.add('urgent'); bar.style.background = 'var(--danger)'; }
}

async function triggerAutoPick() {
  if (!state.draft || state.draft.status !== 'active') return;
  try {
    const result = await api(API.drafts, 'autopick', {});
    if (result.player) {
      const pick = state.picks.find(p => p.player_id == result.player.id) || { pick_num: state.draft.current_pick_num };
      showAnnouncement(pick, result.player, true);
    }
    await fetchState();
  } catch (e) { console.warn('Auto-pick error:', e.message); }
}

// ── Announcement ──────────────────────────────────────────────────────────────
function showAnnouncement(pick, player, isAuto = false) {
  const el = document.getElementById('announcement');
  document.getElementById('ann-pick-num').textContent  = pick.pick_num;
  document.getElementById('ann-team-name').textContent  = pick.team_name || '';
  document.getElementById('ann-player-name').textContent = player.name || player.player_name;
  document.getElementById('ann-player-pos').textContent  =
    (player.position || player.player_position || '') + (isAuto ? ' (auto-pick)' : '');
  el.classList.remove('hidden', 'fadeout');
  if (state.announcementTimeout) clearTimeout(state.announcementTimeout);
  state.announcementTimeout = setTimeout(() => {
    el.classList.add('fadeout');
    setTimeout(() => el.classList.add('hidden'), 500);
  }, 4000);
}

document.getElementById('announcement').addEventListener('click', () => {
  const el = document.getElementById('announcement');
  el.classList.add('fadeout');
  setTimeout(() => el.classList.add('hidden'), 500);
});

// ── Rankings ──────────────────────────────────────────────────────────────────
function renderRankings() {
  const list        = document.getElementById('rankings-list');
  const search      = document.getElementById('filter-search').value.trim().toLowerCase();
  const filterAvail = document.getElementById('filter-available').checked;
  const draftedIds  = new Set(state.picks.filter(p => p.player_id).map(p => Number(p.player_id)));

  let players = state.players;
  if (filterAvail) players = players.filter(p => !draftedIds.has(Number(p.id)));
  if (search)      players = players.filter(p => p.name.toLowerCase().includes(search));

  if (players.length === 0) {
    list.innerHTML = '<div class="empty-state">No players match.</div>';
    return;
  }
  list.innerHTML = '';
  players.forEach(p => {
    const drafted = draftedIds.has(Number(p.id));
    const card    = document.createElement('div');
    card.className = 'player-card' + (drafted ? ' is-drafted' : '');
    card.dataset.playerId = p.id;
    card.innerHTML = `<span class="player-rank">#${p.rank}</span><span class="player-name">${esc(p.name)}</span>`;
    if (!drafted) {
      card.draggable = true;
      card.addEventListener('dragstart', onPlayerDragStart);
      card.addEventListener('dragend',   onPlayerDragEnd);
      card.addEventListener('click',     () => onPlayerClick(p));
    }
    list.appendChild(card);
  });
}

function onPlayerClick(player) {
  if (!state.draft || state.draft.status !== 'active') return;
  makePick(state.draft.current_pick_num, player.id, player);
}

async function makePick(pickNum, playerId, player) {
  try {
    await api(API.drafts, 'pick', { pick_num: pickNum, player_id: playerId });
    const pick = state.picks.find(p => p.pick_num == pickNum) || { pick_num: pickNum, team_name: '' };
    showAnnouncement(pick, player);
    await fetchState();
  } catch (e) { alert('Pick error: ' + e.message); }
}

// ── Mobile Board (coach read-only, small screens) ─────────────────────────────
function renderMobileBoard() {
  const wrap = document.getElementById('board-wrap');
  if (!state.draft || state.teams.length === 0 || state.picks.length === 0) {
    wrap.innerHTML = '<div class="empty-state">' +
      (state.draft ? 'Waiting for draft board to be set up.' : 'No draft in progress.') +
      '</div>';
    return;
  }

  const teams      = state.teams;
  const rounds     = state.draft.total_rounds;
  const n          = teams.length;
  const currentNum = state.draft.current_pick_num;
  const isActive   = state.draft.status === 'active';
  const pickMap    = {};
  state.picks.forEach(p => { pickMap[p.pick_num] = p; });
  const draftedIds = new Set(state.picks.filter(p => p.player_id).map(p => Number(p.player_id)));

  const container = document.createElement('div');
  container.className = 'mobile-board';

  // ── On the clock banner ──
  if (isActive) {
    const cp = pickMap[currentNum];
    if (cp) {
      const banner = document.createElement('div');
      banner.className = 'mobile-on-clock';
      banner.innerHTML =
        `<span class="mobile-clock-label">On the Clock</span>` +
        `<span class="mobile-clock-team">${esc(cp.team_name)}</span>` +
        `<span class="mobile-clock-pick">Pick #${currentNum}</span>`;
      container.appendChild(banner);
    }
  }

  // ── Toolbar: Show Players ──
  const toolbar = document.createElement('div');
  toolbar.className = 'mobile-toolbar';

  const playersBtn = document.createElement('button');
  playersBtn.className = 'btn btn-sm ' + (state.mobilePlayerListVisible ? 'btn-primary' : 'btn-secondary');
  playersBtn.textContent = state.mobilePlayerListVisible ? 'Hide Players' : 'Show Players';
  playersBtn.addEventListener('click', () => {
    state.mobilePlayerListVisible = !state.mobilePlayerListVisible;
    renderMobileBoard();
  });

  toolbar.appendChild(playersBtn);
  container.appendChild(toolbar);

  // ── Player list panel ──
  if (state.mobilePlayerListVisible) {
    const panel = document.createElement('div');
    panel.className = 'mobile-player-panel';

    const panelHeader = document.createElement('div');
    panelHeader.className = 'mobile-player-panel-header';

    const availId = 'mobile-avail-' + Date.now();
    panelHeader.innerHTML =
      `<span class="mobile-player-panel-title">Players</span>` +
      `<label class="mobile-avail-label" for="${availId}">` +
        `<input type="checkbox" id="${availId}" ${state.mobileAvailableOnly ? 'checked' : ''}>` +
        ` Available only` +
      `</label>`;
    panelHeader.querySelector('input').addEventListener('change', e => {
      state.mobileAvailableOnly = e.target.checked;
      renderMobileBoard();
    });
    panel.appendChild(panelHeader);

    const scroll = document.createElement('div');
    scroll.className = 'mobile-player-scroll';

    let players = [...state.players].sort((a, b) => a.rank - b.rank);
    if (state.mobileAvailableOnly) players = players.filter(p => !draftedIds.has(Number(p.id)));

    if (players.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = state.mobileAvailableOnly ? 'No available players.' : 'No players loaded.';
      scroll.appendChild(empty);
    } else {
      players.forEach(p => {
        const row = document.createElement('div');
        row.className = 'mobile-player-row' + (draftedIds.has(Number(p.id)) ? ' is-drafted' : '');
        row.innerHTML =
          `<span class="mobile-player-rank">#${p.rank}</span>` +
          `<span class="mobile-player-name">${esc(p.name)}</span>` +
          (draftedIds.has(Number(p.id)) ? `<span class="mobile-player-drafted">drafted</span>` : '');
        scroll.appendChild(row);
      });
    }
    panel.appendChild(scroll);
    container.appendChild(panel);
  }

  // ── Round cards ──
  for (let r = 1; r <= rounds; r++) {
    const start          = (r - 1) * n + 1;
    const end            = r * n;
    const isCurrentRound = currentNum >= start && currentNum <= end;
    let   filled         = 0;
    for (let p = start; p <= end; p++) { if (pickMap[p]?.player_id) filled++; }

    const card = document.createElement('div');
    card.className = 'mobile-round-card' + (isCurrentRound ? ' is-current-round' : '');

    const header = document.createElement('div');
    header.className = 'mobile-round-header';
    header.innerHTML =
      `<span class="mobile-round-num">Round ${r}</span>` +
      `<span class="mobile-round-progress">${filled} / ${n}</span>` +
      `<span class="mobile-round-chevron">${isCurrentRound ? '▲' : '▼'}</span>`;

    const body = document.createElement('div');
    body.className = 'mobile-round-body' + (isCurrentRound ? '' : ' hidden');

    for (let p = start; p <= end; p++) {
      const pick      = pickMap[p];
      if (!pick) continue;
      const isCurrent = p === currentNum && isActive;
      const isFilled  = !!pick.player_id;

      const row = document.createElement('div');
      row.className = 'mobile-pick-row' +
        (isCurrent ? ' is-on-clock' : '') +
        (isFilled  ? ' is-filled'   : '');

      let playerCell = '';
      if (isFilled) {
        playerCell = `<span class="mobile-pick-player">${esc(pick.player_name)}</span>`;
      } else if (isCurrent) {
        playerCell = `<span class="mobile-pick-player is-clock">selecting&hellip;</span>`;
      } else {
        playerCell = `<span class="mobile-pick-player is-empty">&mdash;</span>`;
      }

      row.innerHTML =
        `<span class="mobile-pick-num">#${p}</span>` +
        `<span class="mobile-pick-team">${esc(pick.team_name)}</span>` +
        playerCell;
      body.appendChild(row);
    }

    header.addEventListener('click', () => {
      body.classList.toggle('hidden');
      header.querySelector('.mobile-round-chevron').textContent =
        body.classList.contains('hidden') ? '▼' : '▲';
    });

    card.appendChild(header);
    card.appendChild(body);
    container.appendChild(card);
  }

  wrap.innerHTML = '';
  wrap.appendChild(container);
}

function isMobileCoach() {
  return state.role === 'coach' && window.innerWidth < 768;
}

// ── Board ─────────────────────────────────────────────────────────────────────
function renderBoard() {
  if (isMobileCoach()) { renderMobileBoard(); return; }
  const wrap = document.getElementById('board-wrap');
  if (!state.draft || state.teams.length === 0 || state.picks.length === 0) {
    wrap.innerHTML = '<div class="empty-state">' +
      (state.draft ? 'Add teams and setup pick order to see the board.' : 'Select a draft to see the board.') +
      '</div>';
    return;
  }
  const teams  = state.teams;
  const rounds = state.draft.total_rounds;
  const n      = teams.length;
  const currentPick   = state.picks.find(p => p.pick_num == state.draft.current_pick_num);
  const onClockTeamId = (state.draft.status === 'active' && currentPick) ? currentPick.team_id : null;

  const table  = document.createElement('table');
  table.className = 'board-table';
  const thead  = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const thRound = document.createElement('th');
  thRound.className = 'round-header'; thRound.textContent = 'Rd';
  headerRow.appendChild(thRound);
  teams.forEach(t => {
    const th = document.createElement('th');
    th.textContent = t.name; th.dataset.teamId = t.id;
    if (onClockTeamId && t.id == onClockTeamId) th.classList.add('is-on-clock');
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow); table.appendChild(thead);

  const pickMap = {};
  state.picks.forEach(p => { pickMap[p.pick_num] = p; });
  const tbody = document.createElement('tbody');

  for (let r = 1; r <= rounds; r++) {
    const tr = document.createElement('tr');
    const tdRound = document.createElement('td');
    tdRound.className = 'board-cell round-cell'; tdRound.textContent = r;
    tr.appendChild(tdRound);

    const roundPickByTeam = {};
    for (let pos = 0; pos < n; pos++) {
      const pick = pickMap[(r - 1) * n + pos + 1];
      if (pick) roundPickByTeam[pick.team_id] = pick;
    }

    teams.forEach(team => {
      const td   = document.createElement('td');
      const pick = roundPickByTeam[team.id];
      td.className = 'board-cell';
      if (!pick) { tr.appendChild(td); return; }

      const isCurrent     = pick.pick_num == state.draft.current_pick_num && state.draft.status === 'active';
      const isFilled      = !!pick.player_id;
      const isPreassigned = isFilled && Number(pick.is_pre_assigned);

      if (isCurrent)     td.classList.add('is-current');
      if (isFilled)      td.classList.add('is-filled');
      else               td.classList.add('is-pick-slot');
      if (isPreassigned) { td.classList.remove('is-filled'); td.classList.add('is-preassigned'); }

      if (!isFilled || isPreassigned) {
        td.addEventListener('dragover',  onCellDragOver);
        td.addEventListener('dragleave', onCellDragLeave);
        td.addEventListener('drop', e => onCellDrop(e, pick.pick_num));
      }

      if (isFilled) {
        td.innerHTML = `<span class="cell-pick-num">#${pick.pick_num}</span>
          <span class="cell-player">${pick.player_name.split(' ').map(w => `<span>${esc(w)}</span>`).join('')}</span>
          ${Number(pick.is_auto_pick) ? '<span class="cell-auto">auto</span>' : ''}
          ${state.role === 'admin' ? '<button class="cell-clear-btn" title="Remove pick">\u2715</button>' : ''}`;
        if (state.role === 'admin') {
          td.querySelector('.cell-clear-btn').addEventListener('click', e => {
            e.stopPropagation();
            clearPick(pick.pick_num);
          });
          td.addEventListener('contextmenu', e => { e.preventDefault(); clearPick(pick.pick_num); });
        }
      } else {
        td.innerHTML = `<span class="cell-pick-num">#${pick.pick_num}</span>
          ${isCurrent ? '<span class="cell-clock-label">ON THE CLOCK</span>' : ''}`;
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  wrap.innerHTML = '';
  wrap.appendChild(table);
  fitBoardToScreen();
}

function fitBoardToScreen() {
  const panel  = document.getElementById('board-panel');
  const wrap   = document.getElementById('board-wrap');
  const header = panel.querySelector('.board-header');
  if (!state.draft || !panel || !header) return;
  const rounds    = state.draft.total_rounds;
  const available = panel.clientHeight - header.offsetHeight - 20;
  const theadEl   = wrap.querySelector('thead tr');
  const theadH    = theadEl ? theadEl.offsetHeight + 4 : 50;
  const spacing   = (rounds + 1) * 4;
  const cellH     = Math.max(38, Math.floor((available - theadH - spacing) / rounds));
  wrap.querySelectorAll('tbody .board-cell').forEach(cell => { cell.style.height = cellH + 'px'; });
}

async function clearPick(pickNum) {
  if (!confirm(`Clear pick #${pickNum}?`)) return;
  try {
    await api(API.drafts, 'clear_pick', { pick_num: pickNum });
    await fetchState();
  } catch (e) { alert('Error: ' + e.message); }
}

// ── Drag and Drop ─────────────────────────────────────────────────────────────
function onPlayerDragStart(e) {
  state.dragPlayerId = Number(e.currentTarget.dataset.playerId);
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}
function onPlayerDragEnd(e) { e.currentTarget.classList.remove('dragging'); }
function onCellDragOver(e) {
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drop-target');
}
function onCellDragLeave(e) { e.currentTarget.classList.remove('drop-target'); }
async function onCellDrop(e, pickNum) {
  e.preventDefault(); e.currentTarget.classList.remove('drop-target');
  if (!state.dragPlayerId || !state.draft) return;
  const isDraftActive = state.draft.status === 'active';
  const isCurrentPick = pickNum == state.draft.current_pick_num;
  const isFuturePick  = pickNum >  state.draft.current_pick_num;
  const isSetup       = state.draft.status === 'setup';
  if (isSetup || isFuturePick) {
    try { await api(API.drafts, 'preassign', { pick_num: pickNum, player_id: state.dragPlayerId }); await fetchState(); }
    catch (e) { alert('Pre-assign error: ' + e.message); }
  } else if (isDraftActive && isCurrentPick) {
    const player = state.players.find(p => Number(p.id) === state.dragPlayerId);
    await makePick(pickNum, state.dragPlayerId, player);
  }
  state.dragPlayerId = null;
}

// ── Player Reorder ────────────────────────────────────────────────────────────
let reorderDragSrcIdx = null;

function renderReorderList() {
  const list = document.getElementById('player-reorder-list-sidebar');
  if (!list) return;
  const players = [...state.players].sort((a, b) => a.rank - b.rank);
  if (players.length === 0) { list.innerHTML = '<div class="reorder-empty">No players loaded.</div>'; return; }
  list.innerHTML = '';
  players.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'reorder-item';
    row.draggable = true; row.dataset.playerId = p.id; row.dataset.idx = idx;
    row.innerHTML = `<span class="reorder-handle" title="Drag to reorder">&#9776;</span><span class="reorder-rank">${idx + 1}</span><span class="reorder-name">${esc(p.name)}</span>`;
    row.addEventListener('dragstart', e => { reorderDragSrcIdx = idx; row.classList.add('reorder-dragging'); e.dataTransfer.effectAllowed = 'move'; });
    row.addEventListener('dragend',   () => { row.classList.remove('reorder-dragging'); list.querySelectorAll('.reorder-item').forEach(r => r.classList.remove('reorder-over')); });
    row.addEventListener('dragover',  e => { e.preventDefault(); list.querySelectorAll('.reorder-item').forEach(r => r.classList.remove('reorder-over')); row.classList.add('reorder-over'); });
    row.addEventListener('drop', async e => {
      e.preventDefault(); row.classList.remove('reorder-over');
      const destIdx = Number(row.dataset.idx);
      if (reorderDragSrcIdx === null || reorderDragSrcIdx === destIdx) return;
      const sorted     = [...state.players].sort((a, b) => a.rank - b.rank);
      const movedName  = sorted[reorderDragSrcIdx].name;
      const targetName = sorted[destIdx].name;
      if (!confirm(`Move "${movedName}" to rank #${destIdx + 1} (before "${targetName}")?`)) { reorderDragSrcIdx = null; return; }
      const [moved] = sorted.splice(reorderDragSrcIdx, 1);
      sorted.splice(destIdx, 0, moved);
      sorted.forEach((p, i) => { p.rank = i + 1; });
      state.players = sorted; renderReorderList(); renderRankings();
      try { await api(API.players, 'reorder', sorted.map(p => p.id)); showReorderStatus('Saved'); }
      catch (e) { showReorderStatus('Save failed', true); }
      reorderDragSrcIdx = null;
    });
    list.appendChild(row);
  });
}

function showReorderStatus(msg, isError = false) {
  const el = document.getElementById('reorder-status');
  if (!el) return;
  el.textContent = msg; el.className = 'reorder-status' + (isError ? ' error' : '');
  setTimeout(() => { el.textContent = ''; }, 2000);
}

// ── Team Management ───────────────────────────────────────────────────────────
function renderTeamList() {
  const list = document.getElementById('team-list');
  if (state.teams.length === 0) { list.innerHTML = '<div class="empty-state" style="padding:8px">No teams yet.</div>'; return; }
  list.innerHTML = '';
  state.teams.forEach(t => {
    const item = document.createElement('div');
    item.className = 'team-item';
    item.innerHTML = `<span class="team-order">${t.draft_order}.</span><span class="team-name">${esc(t.name)}</span><button class="btn-delete" title="Remove" data-id="${t.id}">\u2715</button>`;
    item.querySelector('.btn-delete').addEventListener('click', () => deleteTeam(t.id));
    list.appendChild(item);
  });
}

async function addTeam() {
  const input = document.getElementById('new-team-name');
  const name  = input.value.trim();
  if (!name) return;
  try {
    await api(API.teams, 'create', { name });
    input.value = '';
    await fetchState();
    setTeamsNeedSetup(true);
  } catch (e) { alert('Error: ' + e.message); }
}

async function deleteTeam(id) {
  try {
    await api(API.teams, 'delete', { id });
    await fetchState();
    setTeamsNeedSetup(true);
  } catch (e) { alert('Error: ' + e.message); }
}

// ── Controls ──────────────────────────────────────────────────────────────────
function updateControls() {
  const status        = state.draft?.status || 'none';
  const btnStart      = document.getElementById('btn-start');
  const btnRestart    = document.getElementById('btn-restart');
  const btnPause      = document.getElementById('btn-pause');
  const btnResume     = document.getElementById('btn-resume');
  const btnEnd        = document.getElementById('btn-end');
  const btnAutopick   = document.getElementById('btn-autopick-now');
  const btnResetPicks = document.getElementById('btn-reset-picks');

  const isCompleted = status === 'completed';
  btnStart.classList.toggle('hidden', isCompleted);
  btnStart.disabled  = !(status === 'setup');
  btnRestart.classList.toggle('hidden', !isCompleted);
  btnEnd.disabled    = !(status === 'active' || status === 'paused');
  btnPause.classList.toggle('hidden',    status !== 'active');
  btnResume.classList.toggle('hidden',   status !== 'paused');
  btnAutopick.classList.toggle('hidden', !(status === 'active' && state.draft?.auto_pick_enabled));
  if (btnResetPicks) btnResetPicks.disabled = (status === 'active');
}

function updateStatusBadge() {
  const badge  = document.getElementById('draft-status-badge');
  const status = state.draft?.status || 'none';
  badge.className   = 'badge badge-' + (status === 'none' ? 'setup' : status);
  badge.textContent = status === 'none' ? 'No Draft' : status.charAt(0).toUpperCase() + status.slice(1);
}

function updateCurrentPickLabel() {
  const label = document.getElementById('current-pick-label');
  if (!state.draft || state.draft.status === 'setup' || state.draft.status === 'completed') { label.textContent = ''; return; }
  const pick = state.picks.find(p => p.pick_num == state.draft.current_pick_num);
  if (pick) label.textContent = `Pick #${pick.pick_num} \u2014 ${pick.team_name} on the clock`;
}

// ── Draft Control Buttons ─────────────────────────────────────────────────────
document.getElementById('btn-admin').addEventListener('click', () => {
  document.getElementById('admin-panel').classList.toggle('hidden');
});

document.getElementById('btn-toggle-reorder').addEventListener('click', () => {
  document.getElementById('rankings-view').classList.add('hidden');
  document.getElementById('reorder-view').classList.remove('hidden');
  renderReorderList();
});

document.getElementById('btn-close-reorder').addEventListener('click', () => {
  document.getElementById('reorder-view').classList.add('hidden');
  document.getElementById('rankings-view').classList.remove('hidden');
});

document.getElementById('btn-add-team').addEventListener('click', addTeam);
document.getElementById('new-team-name').addEventListener('keydown', e => { if (e.key === 'Enter') addTeam(); });

document.getElementById('btn-start').addEventListener('click', async () => {
  try {
    await api(API.drafts, 'start', {});
    state.timerMax = state.draft?.timer_minutes * 60 || 120;
    await fetchState(); startPolling(); startTimer();
  } catch (e) { alert('Error: ' + e.message); }
});

document.getElementById('btn-pause').addEventListener('click', async () => {
  try { await api(API.drafts, 'pause', {}); stopTimer(); updateTimerDisplay(null); await fetchState(); }
  catch (e) { alert('Error: ' + e.message); }
});

document.getElementById('btn-resume').addEventListener('click', async () => {
  try { await api(API.drafts, 'resume', {}); await fetchState(); startTimer(); }
  catch (e) { alert('Error: ' + e.message); }
});

document.getElementById('btn-end').addEventListener('click', async () => {
  if (!confirm('End the draft?')) return;
  try { await api(API.drafts, 'end', {}); stopTimer(); stopPolling(); await fetchState(); }
  catch (e) { alert('Error: ' + e.message); }
});

document.getElementById('btn-restart').addEventListener('click', async () => {
  if (!confirm('Restart draft from the first unfilled pick? Existing picks will be kept.')) return;
  try {
    const data = await api(API.drafts, 'restart', {});
    applyState(data);
    startPolling();
    startTimer();
  } catch (e) { alert('Error: ' + e.message); }
});

document.getElementById('btn-reset-picks').addEventListener('click', async () => {
  if (!confirm('Reset ALL picks? This will clear every player assignment and return the draft to setup. This cannot be undone.')) return;
  try {
    const data = await api(API.drafts, 'reset_picks', {});
    applyState(data);
  } catch (e) { alert('Error: ' + e.message); }
});

document.getElementById('btn-autopick-now').addEventListener('click', async () => {
  try {
    const result = await api(API.drafts, 'autopick', {});
    if (result.player) {
      const pick = state.picks.find(p => p.pick_num == state.draft?.current_pick_num) || { pick_num: state.draft?.current_pick_num, team_name: '' };
      showAnnouncement(pick, result.player, true);
    }
    await fetchState();
  } catch (e) { alert('Error: ' + e.message); }
});

// ── Filters ───────────────────────────────────────────────────────────────────
document.getElementById('filter-search').addEventListener('input', renderRankings);
document.getElementById('filter-available').addEventListener('change', renderRankings);

// ── Admin Tabs ────────────────────────────────────────────────────────────────
function switchAdminTab(name) {
  if (state.teamsNeedSetup && name !== 'teams' && name !== 'players') {
    shakeSetupWarning();
    return;
  }
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.admin-tab-panel').forEach(p => p.classList.add('hidden'));
  const tab = document.querySelector(`.admin-tab[data-tab="${name}"]`);
  if (tab) tab.classList.add('active');
  const panel = document.getElementById('admin-tab-' + name);
  if (panel) panel.classList.remove('hidden');
}

function setTeamsNeedSetup(needed) {
  state.teamsNeedSetup = needed;
  const btn     = document.getElementById('btn-setup-picks');
  const cancel  = document.getElementById('btn-setup-picks-cancel');
  const warning = document.getElementById('setup-picks-warning');
  const tabs    = document.querySelectorAll('.admin-tab:not([data-tab="teams"])');
  btn.classList.toggle('btn-needs-action', needed);
  cancel.classList.toggle('hidden', !needed);
  warning.classList.toggle('hidden', !needed);
  tabs.forEach(t => t.classList.toggle('tab-locked', needed));
}

function shakeSetupWarning() {
  const warning = document.getElementById('setup-picks-warning');
  warning.classList.remove('shake');
  // force reflow so animation restarts
  void warning.offsetWidth;
  warning.classList.add('shake');
}

document.querySelectorAll('.admin-tab').forEach(tab => {
  tab.addEventListener('click', () => switchAdminTab(tab.dataset.tab));
});

// ── Import tabs ───────────────────────────────────────────────────────────────
document.querySelectorAll('.import-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.import-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.import-tab-panel').forEach(p => p.classList.add('hidden'));
    tab.classList.add('active');
    document.getElementById('import-tab-' + tab.dataset.tab).classList.remove('hidden');
  });
});

document.getElementById('btn-paste-import').addEventListener('click', async () => {
  const textarea = document.getElementById('paste-names');
  const result   = document.getElementById('import-result');
  const names    = textarea.value.split('\n').map(n => n.trim()).filter(Boolean);
  if (!names.length) { result.textContent = 'Paste at least one name.'; result.className = 'import-result error'; return; }
  try {
    const data = await api(API.players, 'bulk_names', { names, replace: true });
    result.textContent = `Imported ${data.imported} players.`; result.className = 'import-result';
    textarea.value = '';
    await fetchState();
    setTeamsNeedSetup(true);
  } catch (e) { result.textContent = 'Import failed: ' + e.message; result.className = 'import-result error'; }
});

document.getElementById('btn-import').addEventListener('click', async () => {
  const fileInput = document.getElementById('csv-file');
  const result    = document.getElementById('import-result');
  if (!fileInput.files.length) { result.textContent = 'Select a CSV file first.'; result.className = 'import-result error'; return; }
  const form = new FormData();
  form.append('csv', fileInput.files[0]);
  try {
    const data = await apiForm(API.players, 'import', form);
    result.textContent = `Imported ${data.imported} players.` + (data.errors.length ? ` Errors: ${data.errors.join('; ')}` : '');
    result.className = 'import-result' + (data.errors.length ? ' error' : '');
    await fetchState();
    setTeamsNeedSetup(true);
  } catch (e) { result.textContent = 'Import failed: ' + e.message; result.className = 'import-result error'; }
});

document.getElementById('btn-clear-players').addEventListener('click', async () => {
  if (!confirm('Delete all players for this draft?')) return;
  try { await api(API.players, 'clear_all', {}); await fetchState(); setTeamsNeedSetup(true); }
  catch (e) { alert('Error: ' + e.message); }
});

// ── Utility ───────────────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(iso) {
  if (!iso) return '\u2014';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

window.addEventListener('resize', () => { fitBoardToScreen(); renderBoard(); });

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await fetchState();
  if (state.draft?.status === 'active') {
    state.timerMax = state.draft.timer_minutes * 60;
    startPolling();
    startTimer();
  }
}

(async () => {
  const authed = await checkAuth();
  if (authed) await init();
})();
