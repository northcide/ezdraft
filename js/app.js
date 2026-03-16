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
  teamId:           null,
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
  timerSeconds:     null,
  teamsNeedSetup:       false,
  mobilePlayerListVisible:  false,
  mobileAvailableOnly:      true,
  mobileExpandedRounds:     new Set(),
  mobileCurrentRound:       0,
  lastManualPickNum:        null,
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
  const isTeam  = state.role === 'team';
  document.querySelectorAll('.admin-only').forEach(el => {
    el.classList.toggle('hidden', !isAdmin);
  });
  document.getElementById('rankings-panel')
    .classList.toggle('hidden', isMobileNonAdmin());
  document.getElementById('topbar-role').textContent =
    isAdmin ? '(Admin)' : isTeam ? '(Team)' : '(Coach \u2014 view only)';
}

// Login type toggle
document.querySelectorAll('.login-type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.login-type-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('login-team-row')
      .classList.toggle('hidden', btn.dataset.mode !== 'team');
  });
});

document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const league    = document.getElementById('login-league').value.trim();
  const pin       = document.getElementById('login-pin').value.trim();
  const isTeamMode = document.querySelector('.login-type-btn.active')?.dataset.mode === 'team';
  const errEl     = document.getElementById('login-error');
  errEl.classList.add('hidden');
  const teamName = isTeamMode ? document.getElementById('login-team').value.trim() : '';
  const payload = { league_name: league, pin, mode: isTeamMode ? 'team' : 'admin' };
  if (isTeamMode && teamName !== '') payload.team_name = teamName;
  try {
    const data = await api(API.auth, 'login', payload);
    state.role             = data.role;
    state.leagueName       = data.league_name;
    state.teamId           = data.team_id ?? null;
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
// Uses a setTimeout chain (not setInterval) so polls never stack and each one
// waits for the previous response before scheduling the next.
function startPolling() {
  stopPolling();
  state.pollInterval = setTimeout(_doPoll, 2000);
}
function stopPolling() {
  if (state.pollInterval) { clearTimeout(state.pollInterval); state.pollInterval = null; }
}
async function _doPoll() {
  state.pollInterval = null;       // cleared before fetch; applyState reschedules
  await fetchState();              // applyState inside will call startPolling() if needed
}

async function fetchState() {
  try {
    const data = await api(API.drafts, 'state');
    if (data.serverTime) state.serverOffset = Date.now() - new Date(data.serverTime).getTime();
    applyState(data);
  } catch (e) {
    console.warn('Poll error:', e.message);
    // On error, retry after a short back-off so a blip doesn't kill polling
    if (state.selectedDraftId) state.pollInterval = setTimeout(_doPoll, 4000);
  }
}

// Re-sync immediately when the user returns to the tab (fixes mobile backgrounding)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.selectedDraftId) {
    stopPolling();   // cancel any pending timer
    fetchState();    // immediate catch-up; applyState will restart polling
  }
});

function applyState(data) {
  const prevStatus = state.draft?.status;

  // Detect newly filled picks via polling — runs for all roles
  {
    const isInitialLoad  = state.draft === null;
    const isDraftSwitch  = state.draft?.id !== data.draft?.id;
    const oldFilled = new Set((state.picks || []).filter(p => p.player_id).map(p => p.pick_num));
    const newlyFilled = (data.picks || []).filter(p => {
      if (!p.player_id || oldFilled.has(p.pick_num)) return false;
      // Skip admin's own manual pick — makePick already showed the announcement
      if (state.role === 'admin' && p.pick_num == state.lastManualPickNum) return false;
      // Skip team's own manual pick — makePick already showed the announcement
      // Do NOT skip auto-picks — the server picked for us, modal may still be open
      if (state.role === 'team' && p.team_id == state.teamId && !p.is_auto_pick) return false;
      return true;
    });
    if (!isInitialLoad && !isDraftSwitch && data.draft?.status === 'active' && newlyFilled.length > 0) {
      const pick = newlyFilled[newlyFilled.length - 1];
      // If the server auto-picked for this team while the confirm modal was open, close it
      if (state.role === 'team' && pick.team_id == state.teamId && pick.is_auto_pick) {
        document.getElementById('pick-confirm-modal').classList.add('hidden');
      }
      showAnnouncement(pick, { name: pick.player_name, position: pick.player_position || '' }, !!pick.is_auto_pick);
    }
  }

  state.draft           = data.draft;
  state.picks           = data.picks   || [];
  state.teams           = data.teams   || [];
  state.players         = data.players || [];
  if (data.role)             state.role            = data.role;
  if (data.team_id !== undefined) state.teamId     = data.team_id;
  if (state.role === 'team' && state.teamId) {
    const teamName = state.teams.find(t => t.id == state.teamId)?.name;
    if (teamName) document.getElementById('topbar-role').textContent = `(${teamName})`;
  }
  if (data.allDrafts)        state.allDrafts        = data.allDrafts;
  if (data.accessibleDrafts) state.accessibleDrafts = data.accessibleDrafts;
  if (data.selectedDraftId !== undefined) state.selectedDraftId = data.selectedDraftId;

  if (state.draft) state.timerMax = state.draft.timer_minutes * 60;

  // Detect draft just completed
  const justCompleted = state.draft?.status === 'completed' && prevStatus === 'active';
  if (justCompleted) showDraftComplete();

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

  // Total draft time label (admin only)
  const totalEl = document.getElementById('timer-total');
  if (totalEl) {
    if (state.role === 'admin' && state.picks?.length && state.draft?.timer_minutes) {
      const totalMins = state.picks.length * state.draft.timer_minutes;
      const h = Math.floor(totalMins / 60);
      const m = totalMins % 60;
      totalEl.textContent = h > 0 ? ` (${h}h ${m}m)` : ` (${m}m)`;
    } else {
      totalEl.textContent = '';
    }
  }

  // Timer
  if (state.draft?.status === 'active') {
    if (!state.timerInterval) startTimer();
  } else {
    stopTimer();
    updateTimerDisplay(null);
  }

  // Polling: coaches/teams need updates in every state (setup→active transition,
  // paused boards, completed results). Admins only need it when active/paused.
  const wantsPoll = !!state.draft && (
    state.draft.status === 'active' ||
    state.draft.status === 'paused' ||
    state.role === 'coach' ||
    state.role === 'team'
  );
  if (wantsPoll) {
    if (!state.pollInterval) startPolling();
  } else {
    stopPolling();
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

  if (state.draft && state.selectedDraftId) {
    badge.className = `badge badge-${state.draft.status}`;
    badge.textContent = state.draft.status;
    badge.classList.remove('hidden');
    delBtn.classList.toggle('hidden', state.draft.status === 'active');
    if (content) content.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
    delBtn.classList.add('hidden');
    if (content) content.classList.add('hidden');
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
    state.mobileExpandedRounds.clear();
    state.mobileCurrentRound = 0;
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
  const mode = d?.coach_mode ?? 'shared';
  const modeRadio = document.querySelector(`input[name="coach_mode"][value="${mode}"]`);
  if (modeRadio) modeRadio.checked = true;
  const sharedFields = document.getElementById('shared-coach-fields');
  if (sharedFields) sharedFields.style.display = mode === 'team' ? 'none' : '';

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
// Coach mode radio change handler
document.querySelectorAll('input[name="coach_mode"]').forEach(r =>
  r.addEventListener('change', () => {
    const sharedFields = document.getElementById('shared-coach-fields');
    if (sharedFields) sharedFields.style.display = r.value === 'team' ? 'none' : '';
  })
);

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  if (!state.draft) return;
  const payload = {
    name:              document.getElementById('setting-draft-name').value.trim(),
    timer_minutes:     parseInt(document.getElementById('setting-timer').value, 10),
    auto_pick_enabled: document.getElementById('setting-autopick').checked ? 1 : 0,
    coach_name:        document.getElementById('setting-coach-name').value.trim(),
    coach_pin:         document.getElementById('setting-coach-pin').value.trim(),
    coach_mode:        document.querySelector('input[name="coach_mode"]:checked')?.value ?? 'shared',
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
  state.timerSeconds = remainSec;
  updateTimerDisplay(remainSec);
  if (remainMs <= 0) { stopTimer(); triggerAutoPick(); }
}

function updateTimerDisplay(seconds) {
  const hasTimer = !!(state.draft?.auto_pick_enabled && state.draft?.timer_end);

  // Topbar countdown text (bar hidden via CSS)
  const display   = document.getElementById('timer-display');
  const countdown = document.getElementById('timer-countdown');
  if (display && countdown) {
    if (hasTimer && seconds !== null) {
      display.classList.remove('hidden');
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      countdown.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
      countdown.className = 'timer-countdown';
      if (seconds <= 30) countdown.classList.add('warn');
      if (seconds <= 10) { countdown.classList.remove('warn'); countdown.classList.add('urgent'); }
    } else {
      display.classList.add('hidden');
    }
  }

  // Cell countdown text
  const ctdwn = document.getElementById('cell-timer-countdown');
  if (ctdwn) {
    if (hasTimer && seconds !== null) {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      ctdwn.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    } else {
      ctdwn.textContent = '';
    }
  }
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

// ── Audio / Haptics ───────────────────────────────────────────────────────────
let audioCtx = null;

function unlockAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (_) {}
}
// iOS Safari requires AudioContext creation inside a user gesture
document.addEventListener('touchstart', unlockAudio, { passive: true });
document.addEventListener('click',      unlockAudio, { passive: true });

function playPickSound(isComplete = false) {
  // Haptic feedback — works on Android; iOS does not support navigator.vibrate
  if (navigator.vibrate) {
    navigator.vibrate(isComplete ? [100, 60, 100, 60, 200] : [100]);
  }
  // Synthesised chime via Web Audio API
  if (!audioCtx) return; // not yet unlocked (iOS autoplay restriction)
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    // Normal pick: two-note ding (E5 → G5)
    // Draft complete: four-note ascending fanfare (C5 E5 G5 C6)
    const freqs = isComplete ? [523.25, 659.25, 783.99, 1046.50] : [659.25, 783.99];
    freqs.forEach((freq, i) => {
      const osc  = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = audioCtx.currentTime + i * 0.13;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
      osc.start(t);
      osc.stop(t + 0.5);
    });
  } catch (_) {}
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
  // Force animation restart — fixes iOS Safari not re-playing on subsequent shows
  const inner = el.querySelector('.announcement-inner');
  el.style.animation = 'none';
  if (inner) inner.style.animation = 'none';
  void el.offsetWidth; // trigger reflow
  el.style.animation = '';
  if (inner) inner.style.animation = '';
  playPickSound();
  if (state.announcementTimeout) clearTimeout(state.announcementTimeout);
  state.announcementTimeout = setTimeout(() => {
    el.classList.add('fadeout');
    setTimeout(() => el.classList.add('hidden'), 500);
  }, 4000);
}

function showDraftComplete() {
  // Brief full-screen overlay (replace any current announcement)
  if (state.announcementTimeout) clearTimeout(state.announcementTimeout);
  const el = document.getElementById('announcement');
  el.classList.remove('fadeout');
  document.getElementById('ann-pick-num').textContent  = '';
  document.getElementById('ann-team-name').textContent = '\u{1F3C6} Draft Complete!';
  document.getElementById('ann-player-name').textContent = 'Final Results';
  document.getElementById('ann-player-pos').textContent  = 'All picks have been made';
  el.classList.remove('hidden', 'fadeout');
  el.style.animation = 'none';
  const inner = el.querySelector('.announcement-inner');
  if (inner) inner.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  if (inner) inner.style.animation = '';
  state.announcementTimeout = setTimeout(() => {
    el.classList.add('fadeout');
    setTimeout(() => el.classList.add('hidden'), 500);
  }, 5000);

  playPickSound(true);
  // Persistent banner (shown until draft is no longer completed)
  document.getElementById('draft-complete-banner').classList.remove('hidden');
}

document.getElementById('announcement').addEventListener('click', () => {
  const el = document.getElementById('announcement');
  el.classList.add('fadeout');
  setTimeout(() => el.classList.add('hidden'), 500);
});

// ── Rankings ──────────────────────────────────────────────────────────────────
function currentPickTeamId() {
  const pick = state.picks?.find(p => p.pick_num === state.draft?.current_pick_num);
  return pick?.team_id ?? null;
}

function showPickConfirm(player) {
  const teamName = state.teams?.find(t => t.id == state.teamId)?.name ?? 'your team';
  document.getElementById('pick-confirm-text').textContent =
    `Draft "${esc(player.name)}" for ${esc(teamName)}?`;
  document.getElementById('pick-confirm-modal').classList.remove('hidden');

  const confirmBtn = document.getElementById('btn-pick-confirm');
  const handler = async () => {
    confirmBtn.removeEventListener('click', handler);
    document.getElementById('pick-confirm-modal').classList.add('hidden');
    await makePick(state.draft.current_pick_num, player.id, player);
  };
  confirmBtn.addEventListener('click', handler);
}

document.getElementById('btn-pick-cancel').addEventListener('click', () => {
  document.getElementById('pick-confirm-modal').classList.add('hidden');
});

function renderRankings() {
  const list        = document.getElementById('rankings-list');
  const search      = document.getElementById('filter-search').value.trim().toLowerCase();
  const filterAvail = document.getElementById('filter-available').checked;
  const draftedIds  = new Set(state.picks.filter(p => p.player_id).map(p => Number(p.player_id)));

  // Map player_id → pick info (team_id, team_name) for drafted players
  const draftedByTeam = {};
  state.picks.filter(p => p.player_id).forEach(p => {
    draftedByTeam[Number(p.player_id)] = { teamId: p.team_id, teamName: p.team_name };
  });

  let players = state.players;
  if (filterAvail) {
    if (state.role === 'coach' || state.role === 'team') {
      // Keep available players + own team's picks (so coaches/teams can see their roster)
      players = players.filter(p => {
        if (!draftedIds.has(Number(p.id))) return true;
        return draftedByTeam[Number(p.id)]?.teamId == state.teamId;
      });
    } else {
      players = players.filter(p => !draftedIds.has(Number(p.id)));
    }
  }
  if (search) players = players.filter(p => p.name.toLowerCase().includes(search));

  if (players.length === 0) {
    list.innerHTML = '<div class="empty-state">No players match.</div>';
    return;
  }
  list.innerHTML = '';
  const isMyTurnNow = state.role === 'team'
    && state.draft?.status === 'active'
    && currentPickTeamId() == state.teamId;  // loose equality (int vs string)

  players.forEach(p => {
    const drafted   = draftedIds.has(Number(p.id));
    const pickInfo  = draftedByTeam[Number(p.id)];
    const isMyPick  = drafted && pickInfo?.teamId == state.teamId
                      && (state.role === 'coach' || state.role === 'team');

    const card = document.createElement('div');
    card.dataset.playerId = p.id;

    if (drafted && isMyPick) {
      card.className = 'player-card is-my-pick';
    } else if (drafted) {
      card.className = 'player-card is-drafted';
    } else {
      card.className = 'player-card';
    }

    card.innerHTML = `<span class="player-rank">#${p.rank}</span><span class="player-name">${esc(p.name)}</span>`;

    if (drafted && pickInfo) {
      const badge = document.createElement('span');
      badge.className = 'player-team-badge' + (isMyPick ? ' is-my-team' : '');
      badge.textContent = isMyPick ? '✓' : esc(pickInfo.teamName);
      card.appendChild(badge);
    }

    if (!drafted && state.role === 'admin') {
      card.draggable = true;
      card.addEventListener('dragstart', onPlayerDragStart);
      card.addEventListener('dragend',   onPlayerDragEnd);
      card.addEventListener('click',     () => onPlayerClick(p));
    } else if (!drafted && isMyTurnNow) {
      const pill = document.createElement('button');
      pill.className = 'btn-pick-pill';
      pill.textContent = 'PICK';
      pill.addEventListener('click', e => { e.stopPropagation(); showPickConfirm(p); });
      card.appendChild(pill);
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
    state.lastManualPickNum = pickNum;
    showAnnouncement(pick, player);
    await fetchState();
    state.lastManualPickNum = null;
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
    let pickCounterHtml = '';
    if (state.teamId) {
      const teamPicks = state.picks.filter(pk => pk.team_id == state.teamId);
      const pickedCount = teamPicks.filter(pk => pk.player_id).length;
      const totalCount  = teamPicks.length;
      pickCounterHtml = `<span class="mobile-pick-counter">${pickedCount}/${totalCount}</span>`;
    }
    panelHeader.innerHTML =
      `<span class="mobile-player-panel-title">Players</span>` +
      pickCounterHtml +
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

    // Map player_id → pick info for drafted players
    const draftedByTeamM = {};
    state.picks.filter(pk => pk.player_id).forEach(pk => {
      draftedByTeamM[Number(pk.player_id)] = { teamId: pk.team_id, teamName: pk.team_name };
    });

    let players = [...state.players].sort((a, b) => a.rank - b.rank);
    if (state.mobileAvailableOnly) {
      if (state.role === 'coach' || state.role === 'team') {
        // Always show own team's picks so the roster is visible
        players = players.filter(p =>
          !draftedIds.has(Number(p.id)) || draftedByTeamM[Number(p.id)]?.teamId == state.teamId
        );
      } else {
        players = players.filter(p => !draftedIds.has(Number(p.id)));
      }
    }

    if (players.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = state.mobileAvailableOnly ? 'No available players.' : 'No players loaded.';
      scroll.appendChild(empty);
    } else {
      const isMyTurnMobile = state.role === 'team'
        && isActive
        && currentPickTeamId() == state.teamId;
      players.forEach(p => {
        const isDrafted = draftedIds.has(Number(p.id));
        const pickInfo  = draftedByTeamM[Number(p.id)];
        const isMyPick  = isDrafted && pickInfo?.teamId == state.teamId
                          && (state.role === 'coach' || state.role === 'team');

        const row = document.createElement('div');
        row.className = 'mobile-player-row' + (isDrafted && !isMyPick ? ' is-drafted' : '')
                                             + (isMyPick ? ' is-my-pick' : '');
        row.innerHTML =
          `<span class="mobile-player-rank">#${p.rank}</span>` +
          `<span class="mobile-player-name">${esc(p.name)}</span>`;

        if (isDrafted && pickInfo) {
          const badge = document.createElement('span');
          badge.className = 'player-team-badge' + (isMyPick ? ' is-my-team' : '');
          badge.textContent = isMyPick ? '✓' : esc(pickInfo.teamName);
          row.appendChild(badge);
        }

        if (!isDrafted && isMyTurnMobile) {
          const pill = document.createElement('button');
          pill.className = 'btn-pick-pill';
          pill.textContent = 'PICK';
          pill.addEventListener('click', e => { e.stopPropagation(); showPickConfirm(p); });
          row.appendChild(pill);
        }
        scroll.appendChild(row);
      });
    }
    panel.appendChild(scroll);
    container.appendChild(panel);
  }

  // ── Round cards ──
  // Auto-expand the current round when it first appears or advances
  const currentRound = n > 0 && currentNum > 0 ? Math.ceil(currentNum / n) : 1;
  if (state.mobileCurrentRound !== currentRound) {
    state.mobileCurrentRound = currentRound;
    state.mobileExpandedRounds.add(currentRound);
  }
  if (state.mobileExpandedRounds.size === 0) state.mobileExpandedRounds.add(currentRound);

  for (let r = 1; r <= rounds; r++) {
    const start          = (r - 1) * n + 1;
    const end            = r * n;
    const isCurrentRound = currentNum >= start && currentNum <= end;
    const isExpanded     = state.mobileExpandedRounds.has(r);
    let   filled         = 0;
    for (let p = start; p <= end; p++) { if (pickMap[p]?.player_id) filled++; }

    const card = document.createElement('div');
    card.className = 'mobile-round-card' + (isCurrentRound ? ' is-current-round' : '');

    const header = document.createElement('div');
    header.className = 'mobile-round-header';
    header.innerHTML =
      `<span class="mobile-round-num">Round ${r}</span>` +
      `<span class="mobile-round-progress">${filled} / ${n}</span>` +
      `<span class="mobile-round-chevron">${isExpanded ? '▲' : '▼'}</span>`;

    const body = document.createElement('div');
    body.className = 'mobile-round-body' + (isExpanded ? '' : ' hidden');

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
      if (state.mobileExpandedRounds.has(r)) {
        state.mobileExpandedRounds.delete(r);
      } else {
        state.mobileExpandedRounds.add(r);
      }
      body.classList.toggle('hidden');
      header.querySelector('.mobile-round-chevron').textContent =
        body.classList.contains('hidden') ? '▼' : '▲';
    });

    card.appendChild(header);
    card.appendChild(body);
    container.appendChild(card);
  }

  const savedPlayerScroll = wrap.querySelector('.mobile-player-scroll')?.scrollTop ?? 0;
  wrap.innerHTML = '';
  wrap.appendChild(container);
  if (savedPlayerScroll > 0) {
    const el = wrap.querySelector('.mobile-player-scroll');
    if (el) el.scrollTop = savedPlayerScroll;
  }
}

function isMobileCoach() {
  return state.role === 'coach' && window.innerWidth < 768;
}

function isMobileNonAdmin() {
  return (state.role === 'coach' || state.role === 'team') && window.innerWidth < 768;
}

// ── Board ─────────────────────────────────────────────────────────────────────
function renderBoard() {
  document.getElementById('rankings-panel').classList.toggle('hidden', isMobileNonAdmin());
  if (isMobileNonAdmin()) { renderMobileBoard(); return; }
  const wrap = document.getElementById('board-wrap');
  const banner = document.getElementById('draft-complete-banner');
  if (banner) banner.classList.toggle('hidden', state.draft?.status !== 'completed');
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
    if (onClockTeamId && t.id == onClockTeamId) { th.classList.add('is-on-clock'); th.id = 'clock-header'; }
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

      if (state.role === 'admin') {
        td.addEventListener('dragover',  onCellDragOver);
        td.addEventListener('dragleave', onCellDragLeave);
        td.addEventListener('drop', e => onCellDrop(e, pick));
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
        if (isCurrent) td.id = 'clock-cell';
        td.innerHTML = `<span class="cell-pick-num">#${pick.pick_num}</span>` +
          (isCurrent ? `<span class="cell-clock-label">ON THE CLOCK</span>` +
                       `<span id="cell-timer-countdown" class="cell-timer-countdown"></span>` : '');
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  wrap.innerHTML = '';
  wrap.appendChild(table);
  fitBoardToScreen();
  updateTimerDisplay(state.timerSeconds); // refresh countdown text in new cell DOM
}

function fitBoardToScreen() {
  const panel  = document.getElementById('board-panel');
  const wrap   = document.getElementById('board-wrap');
  if (!state.draft || !panel) return;
  const rounds    = state.draft.total_rounds;
  // Subtract height of every sibling before board-wrap
  let overhead = 20;
  for (const child of panel.children) {
    if (child === wrap) break;
    overhead += child.offsetHeight;
  }
  const available = panel.clientHeight - overhead;
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
async function onCellDrop(e, pick) {
  e.preventDefault(); e.currentTarget.classList.remove('drop-target');
  if (!state.dragPlayerId || !state.draft) return;
  const playerId   = state.dragPlayerId;
  state.dragPlayerId = null;
  const player     = state.players.find(p => Number(p.id) === playerId);
  const playerName = player?.name || `Player #${playerId}`;
  const slotDesc   = pick.team_name ? `${pick.team_name} (pick #${pick.pick_num})` : `pick #${pick.pick_num}`;
  const existing   = pick.player_id ? ` Replaces: ${pick.player_name}.` : '';
  if (!confirm(`Assign ${playerName} to ${slotDesc}?${existing}`)) return;
  try {
    await api(API.drafts, 'force_assign', { pick_num: pick.pick_num, player_id: playerId });
    await fetchState();
  } catch (err) { alert('Error: ' + err.message); }
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

    if (state.role === 'admin') {
      item.innerHTML =
        `<span class="team-order">${t.draft_order}.</span>` +
        `<input type="text" class="team-name-input input-sm" value="${esc(t.name)}" title="Team name">` +
        `<input type="text" class="team-pin-input input-sm" placeholder="PIN" value="${esc(t.pin || '')}" title="Team login PIN">` +
        `<button class="team-pin-set btn btn-sm btn-secondary">Set</button>` +
        `<button class="btn-delete" title="Remove">\u2715</button>`;

      const nameInput = item.querySelector('.team-name-input');
      const pinInput  = item.querySelector('.team-pin-input');
      const pinBtn    = item.querySelector('.team-pin-set');

      const saveName = async () => {
        const name = nameInput.value.trim();
        if (!name || name === t.name) return;
        try {
          await api(API.teams, 'update', { id: t.id, name, draft_order: t.draft_order });
          const team = state.teams.find(x => x.id === t.id);
          if (team) team.name = name;
          t.name = name;
        } catch (e) { nameInput.value = t.name; alert('Error: ' + e.message); }
      };

      nameInput.addEventListener('blur', saveName);
      nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') nameInput.blur(); });

      const savePin = async () => {
        const pin = pinInput.value.trim();
        try {
          await api(API.teams, 'set_pin', { id: t.id, pin });
          pinBtn.textContent = '✓';
          pinBtn.classList.add('btn-success');
          setTimeout(() => { pinBtn.textContent = 'Set'; pinBtn.classList.remove('btn-success'); }, 1500);
          const team = state.teams.find(x => x.id === t.id);
          if (team) team.pin = pin || null;
        } catch (e) { alert('Error: ' + e.message); }
      };

      pinBtn.addEventListener('click', savePin);
      pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') savePin(); });
      item.querySelector('.btn-delete').addEventListener('click', () => deleteTeam(t.id));
    } else {
      item.innerHTML = `<span class="team-order">${t.draft_order}.</span><span class="team-name">${esc(t.name)}</span>`;
    }

    list.appendChild(item);
  });
}

async function deleteTeam(id) {
  try {
    await api(API.teams, 'delete', { id });
    await fetchState();
    setTeamsNeedSetup(true);
  } catch (e) { alert('Error: ' + e.message); }
}

// ── Bulk Team Creation ─────────────────────────────────────────────────────────
(function initBulkTeams() {
  const sel = document.getElementById('team-count-select');
  for (let i = 2; i <= 16; i++) {
    const o = document.createElement('option');
    o.value = i; o.textContent = i;
    sel.appendChild(o);
  }

  sel.addEventListener('change', function() {
    const n = parseInt(this.value) || 0;
    const container = document.getElementById('bulk-team-rows');
    container.innerHTML = '';
    document.getElementById('bulk-team-footer').classList.toggle('hidden', !n);
    for (let i = 0; i < n; i++) {
      const row = document.createElement('div');
      row.className = 'bulk-team-row';
      row.innerHTML =
        `<input type="text" class="bulk-team-name input-sm" placeholder="Team ${i + 1} Name">` +
        `<input type="text" class="bulk-team-pin  input-sm" placeholder="PIN (optional)">`;
      container.appendChild(row);
    }
  });

  document.getElementById('btn-save-all-teams').addEventListener('click', async () => {
    const teams = [...document.querySelectorAll('.bulk-team-row')].map(r => ({
      name: r.querySelector('.bulk-team-name').value.trim(),
      pin:  r.querySelector('.bulk-team-pin').value.trim(),
    }));
    if (teams.some(t => !t.name)) { alert('All team names are required.'); return; }
    const clearExisting = document.getElementById('bulk-clear-existing').checked;
    try {
      await api(API.teams, 'bulk_create', { teams, clear_existing: clearExisting });
      document.getElementById('team-count-select').value = '';
      document.getElementById('bulk-team-rows').innerHTML = '';
      document.getElementById('bulk-team-footer').classList.add('hidden');
      document.getElementById('bulk-clear-existing').checked = false;
      await fetchState();
      setTeamsNeedSetup(true);
    } catch (e) { alert('Error: ' + e.message); }
  });
})();

// ── Controls ──────────────────────────────────────────────────────────────────
function updateControls() {
  const status        = state.draft?.status || 'none';
  const btnStart      = document.getElementById('btn-start');
  const btnRestart    = document.getElementById('btn-restart');
  const btnPause      = document.getElementById('btn-pause');
  const btnResume     = document.getElementById('btn-resume');
  const btnEnd        = document.getElementById('btn-end');
  const btnAutopick   = document.getElementById('btn-autopick-now');
  const btnUndo       = document.getElementById('btn-undo');
  const btnResetPicks = document.getElementById('btn-reset-picks');
  const bar           = document.getElementById('board-controls-bar');

  if (bar) bar.classList.toggle('hidden', !state.draft || state.role !== 'admin');

  const isCompleted  = status === 'completed';
  const hasFilledPick = state.picks.some(p => p.player_id);
  btnStart.classList.toggle('hidden', isCompleted);
  btnStart.disabled  = !(status === 'setup');
  btnRestart.classList.toggle('hidden', !isCompleted);
  btnEnd.disabled    = !(status === 'active' || status === 'paused');
  btnPause.classList.toggle('hidden',    status !== 'active');
  btnResume.classList.toggle('hidden',   status !== 'paused');
  btnAutopick.classList.toggle('hidden', !(status === 'active' && state.draft?.auto_pick_enabled));
  btnUndo.classList.toggle('hidden', !(hasFilledPick && (status === 'active' || status === 'paused' || status === 'completed')));
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

// (add-team button removed; teams are now created in bulk)

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

document.getElementById('btn-undo').addEventListener('click', async () => {
  try {
    const data = await api(API.drafts, 'undo_pick', {});
    applyState(data);
    if (state.draft?.status === 'active') { stopTimer(); startTimer(); }
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
  await fetchState(); // applyState inside handles polling and timer startup
}

(async () => {
  const authed = await checkAuth();
  if (authed) await init();
})();
