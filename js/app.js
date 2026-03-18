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
  archivedDrafts:   [],
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
  csrfToken:                null,
  audioEnabled:             false,
};
state.audioEnabled = false; // always start muted — audio requires a user gesture to unlock

// ── Token helpers ─────────────────────────────────────────────────────────────
function tokenStatusHtml(expiresAt) {
  if (!expiresAt) return '<span class="token-status token-status--none">No link</span>';
  const exp = new Date(expiresAt), now = new Date();
  if (exp > now) {
    const minsLeft = Math.round((exp - now) / 60000);
    const label    = minsLeft < 60 ? `${minsLeft}m` : `${Math.floor(minsLeft/60)}h ${minsLeft%60}m`;
    return `<span class="token-status token-status--valid">Valid (${label})</span>`;
  }
  const minsAgo = Math.round((now - exp) / 60000);
  const label   = minsAgo < 60 ? `${minsAgo}m ago` : `${Math.round(minsAgo/60)}h ago`;
  return `<span class="token-status token-status--expired">Expired ${label}</span>`;
}

async function generateAndCopyToken(type, id) {
  const payload = type === 'coach' ? { type: 'coach', draft_id: id } : { type: 'team', team_id: id };
  const data = await api(API.auth, 'generate_token', payload);
  const url  = `${location.origin}${location.pathname}?token=${data.token}`;
  await navigator.clipboard.writeText(url);
  return data;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function checkAuth() {
  try {
    const data = await api(API.auth, 'check');
    state.role            = data.role;
    state.leagueName      = data.league_name;
    state.accessibleDrafts = data.accessibleDrafts || [];
    if (data.csrf_token) state.csrfToken = data.csrf_token;
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
    if (data.csrf_token) state.csrfToken = data.csrf_token;
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
    switchAdminStep('pickorder');
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
  const url     = `${endpoint}?action=${action}`;
  const headers = {};
  if (body) {
    headers['Content-Type'] = 'application/json';
    if (state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
  }
  const opts = { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined };
  const res  = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function apiForm(endpoint, action, formData) {
  const headers = {};
  if (state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
  const res  = await fetch(`${endpoint}?action=${action}`, { method: 'POST', body: formData, headers });
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
  const prevStatus  = state.draft?.status;
  const prevPickNum = state.draft?.current_pick_num;

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
  if (data.archivedDrafts)   state.archivedDrafts   = data.archivedDrafts;
  if (data.accessibleDrafts) state.accessibleDrafts = data.accessibleDrafts;
  if (data.selectedDraftId !== undefined) state.selectedDraftId = data.selectedDraftId;

  // ── Audio announcements ──────────────────────────────────────────────────
  const newPickNum = state.draft?.current_pick_num;

  if (state.draft?.status === 'active' && newPickNum !== prevPickNum) {
    // Reset timer tracking so threshold announcements don't false-fire on the new pick's timer
    state.timerSeconds = null;

    const donePick = state.picks.find(p => p.pick_num == prevPickNum);
    const nextPick = state.picks.find(p => p.pick_num == newPickNum);

    let msg = '';
    if (donePick?.player_name) {
      msg += `${donePick.team_name} picked ${donePick.player_name}. `;
    }
    if (nextPick) {
      const mins = state.draft.timer_minutes;
      if (state.draft.auto_pick_enabled && mins) {
        msg += `${nextPick.team_name} now has ${mins} minute${mins !== 1 ? 's' : ''} on the clock.`;
      } else {
        msg += `${nextPick.team_name} is now on the clock.`;
      }
    }
    if (msg) speak(msg);
  }

  // Draft just went active (start event)
  if (prevStatus !== 'active' && state.draft?.status === 'active') {
    const firstPick = state.picks.find(p => p.pick_num == state.draft.current_pick_num);
    if (firstPick) {
      const mins = state.draft.timer_minutes;
      const tmsg = (state.draft.auto_pick_enabled && mins)
        ? `${firstPick.team_name} has ${mins} minute${mins !== 1 ? 's' : ''} on the clock.`
        : `${firstPick.team_name} is on the clock.`;
      speak(`The draft has started. ${tmsg}`);
    }
  }
  // ────────────────────────────────────────────────────────────────────────

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
  updateStepBadges();
  updateStatusBadge();
  updateCurrentPickLabel();

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
  if (document.activeElement === sel) return; // don't clobber an open dropdown

  const drafts   = state.allDrafts    || [];
  const archived = state.archivedDrafts || [];

  sel.innerHTML = '<option value="">\u2014 Select a draft \u2014</option>';

  const activeGroup = document.createElement('optgroup');
  activeGroup.label = 'Active Drafts';
  drafts.forEach(d => {
    const opt = document.createElement('option');
    opt.value       = d.id;
    opt.textContent = `${d.name} (${d.status})`;
    if (d.id == state.selectedDraftId) opt.selected = true;
    activeGroup.appendChild(opt);
  });
  sel.appendChild(activeGroup);

  if (archived.length > 0) {
    const archGroup = document.createElement('optgroup');
    archGroup.label = 'Archived';
    archGroup.id    = 'archived-optgroup';
    archived.forEach(d => {
      const opt = document.createElement('option');
      opt.value       = d.id;
      opt.textContent = `${d.name} (archived)`;
      if (d.id == state.selectedDraftId) opt.selected = true;
      archGroup.appendChild(opt);
    });
    sel.appendChild(archGroup);
  }

  // Update badge and delete button
  const badge   = document.getElementById('draft-selector-badge');
  const delBtn  = document.getElementById('btn-delete-draft');
  const content = document.getElementById('draft-content');

  if (state.draft && state.selectedDraftId) {
    const isArchived = !!state.draft.archived;
    badge.className = `badge badge-${isArchived ? 'archived' : state.draft.status}`;
    badge.textContent = isArchived ? 'archived' : state.draft.status;
    badge.classList.remove('hidden');
    delBtn.classList.toggle('hidden', state.draft.status === 'active' || isArchived);
    if (content) content.classList.toggle('hidden', isArchived);
  } else {
    badge.classList.add('hidden');
    delBtn.classList.add('hidden');
    if (content) content.classList.add('hidden');
  }
}

document.getElementById('draft-selector').addEventListener('change', async function() {
  if (state.teamsNeedSetup) {
    this.value = state.selectedDraftId || '';
    switchAdminStep('pickorder');
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
  if (document.activeElement === sel) return; // don't clobber an open dropdown

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

// ── Settings dirty-tracking ───────────────────────────────────────────────────
let _settingsSaveTimer = null;
let settingsDirty = false;

function markSettingsDirty() {
  settingsDirty = true;
  const btn = document.getElementById('btn-save-settings');
  if (!btn || btn.classList.contains('btn-saved')) return;
  btn.disabled = false;
  btn.classList.add('btn-primary');
  btn.classList.remove('btn-secondary');
  updateStepBadges();
  updateControls();
}

function markSettingsClean() {
  settingsDirty = false;
  const btn = document.getElementById('btn-save-settings');
  if (!btn) return;
  clearTimeout(_settingsSaveTimer);
  btn.textContent = '✓ Saved';
  btn.classList.remove('btn-primary', 'btn-saved');
  btn.classList.add('btn-secondary', 'btn-saved');
  _settingsSaveTimer = setTimeout(() => {
    btn.textContent = 'Save Settings';
    btn.classList.remove('btn-saved');
    btn.disabled = true;
    updateStepBadges();
  }, 2000);
}

const _settingsFields = ['setting-draft-name', 'setting-timer', 'setting-autopick',
                          'setting-coach-name', 'setting-coach-pin'];
_settingsFields.forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', markSettingsDirty);
  if (el) el.addEventListener('change', markSettingsDirty);
});
document.querySelectorAll('input[name="coach_mode"]').forEach(r =>
  r.addEventListener('change', markSettingsDirty)
);
document.querySelectorAll('input[name="draft_type"]').forEach(r =>
  r.addEventListener('change', markSettingsDirty)
);

// Audio toggle — topbar mute button + settings checkbox stay in sync
function setAudio(enabled) {
  state.audioEnabled = enabled;
  const btn = document.getElementById('btn-mute');
  if (btn) {
    btn.textContent = enabled ? '\uD83D\uDD0A' : '\uD83D\uDD07';
    btn.title       = enabled ? 'Mute audio announcements' : 'Unmute audio announcements';
    btn.classList.toggle('btn-mute--muted', !enabled);
  }
  const chk = document.getElementById('chk-audio-announce');
  if (chk) chk.checked = enabled;
}

setAudio(state.audioEnabled); // apply initial state to button

document.getElementById('btn-mute').addEventListener('click', () => {
  const enabling = !state.audioEnabled;
  unlockAudio();
  setAudio(enabling);
  if (enabling) {
    playPickSound(); // unlocks AudioContext within the gesture
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance('audio on'));
    }
  }
});


// ── Settings Form ─────────────────────────────────────────────────────────────
function fillSettingsForm() {
  if (settingsDirty) return; // don't overwrite user's unsaved changes during a poll
  const d = state.draft;
  const nameEl      = document.getElementById('setting-draft-name');
  const timerEl     = document.getElementById('setting-timer');
  const autoEl      = document.getElementById('setting-autopick');
  const coachNameEl = document.getElementById('setting-coach-name');
  const coachPinEl  = document.getElementById('setting-coach-pin');

  if (!nameEl) return;
  const draftType = d?.draft_type ?? 'snake';
  const typeRadio = document.querySelector(`input[name="draft_type"][value="${draftType}"]`);
  if (typeRadio) typeRadio.checked = true;

  const mode = d?.coach_mode ?? 'shared';
  const modeRadio = document.querySelector(`input[name="coach_mode"][value="${mode}"]`);
  if (modeRadio) modeRadio.checked = true;
  const sharedFields = document.getElementById('shared-coach-fields');
  if (sharedFields) sharedFields.style.display = mode === 'team' ? 'none' : '';
  const linkRow = document.getElementById('coach-link-row');
  if (linkRow) {
    linkRow.style.display = mode === 'shared' ? 'flex' : 'none';
    document.getElementById('coach-link-status').innerHTML =
      tokenStatusHtml(state.allDrafts?.find(d => d.id === state.draft?.id)?.coach_token_expires_at ?? null);
  }

  if (d) {
    nameEl.value      = d.name          || '';
    timerEl.value     = d.timer_minutes || 2;
    autoEl.checked    = !!d.auto_pick_enabled;
    coachNameEl.value   = d.coach_name  || '';
    coachPinEl.value    = '';
    coachPinEl.placeholder = d.has_coach_pin ? '(PIN set — leave blank to keep)' : 'Set a PIN';
  } else {
    nameEl.value = ''; timerEl.value = 2;
    autoEl.checked = true; coachNameEl.value = ''; coachPinEl.value = '';
  }

  // Reset button to neutral disabled state (form is now in sync with saved state)
  if (!settingsDirty) {
    const saveBtn = document.getElementById('btn-save-settings');
    if (saveBtn && !saveBtn.classList.contains('btn-saved')) {
      saveBtn.disabled = true;
      saveBtn.classList.remove('btn-primary');
      saveBtn.classList.add('btn-secondary');
    }
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
    switchAdminStep('settings');
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
    const linkRow = document.getElementById('coach-link-row');
    if (linkRow) linkRow.style.display = r.value === 'shared' ? 'flex' : 'none';
  })
);

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  if (!state.draft) return;
  const payload = {
    name:              document.getElementById('setting-draft-name').value.trim(),
    timer_minutes:     parseInt(document.getElementById('setting-timer').value, 10),
    auto_pick_enabled: document.getElementById('setting-autopick').checked ? 1 : 0,
    coach_name:        document.getElementById('setting-coach-name').value.trim(),
    // Only send coach_pin if a new value was entered; omitting keeps the existing PIN
    ...(document.getElementById('setting-coach-pin').value.trim()
        ? { coach_pin: document.getElementById('setting-coach-pin').value.trim() }
        : {}),
    coach_mode:        document.querySelector('input[name="coach_mode"]:checked')?.value ?? 'shared',
    draft_type:        document.querySelector('input[name="draft_type"]:checked')?.value ?? 'snake',
  };
  try {
    const data = await api(API.drafts, 'update_settings', payload);
    markSettingsClean();
    applyState(data);
  } catch (e) {
    alert('Error: ' + e.message);
  }
});

document.getElementById('btn-gen-coach-link')?.addEventListener('click', async function () {
  if (!state.draft) return;
  this.disabled = true;
  try {
    const data = await generateAndCopyToken('coach', state.draft.id);
    const d = state.allDrafts?.find(x => x.id === state.draft.id);
    if (d) d.coach_token_expires_at = data.expires_at;
    document.getElementById('coach-link-status').innerHTML = tokenStatusHtml(data.expires_at);
    this.textContent = 'Copied!';
    setTimeout(() => { this.textContent = 'Generate & Copy Link'; this.disabled = false; }, 2000);
  } catch(e) {
    alert('Error: ' + e.message);
    this.disabled = false;
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
  const prevSeconds = state.timerSeconds;
  state.timerSeconds = remainSec;
  updateTimerDisplay(remainSec);
  announceTimerIfNeeded(prevSeconds, remainSec);
  if (remainMs <= 0) { stopTimer(); triggerAutoPick(); }
}

function announceTimerIfNeeded(prevSec, nowSec) {
  if (!state.audioEnabled || prevSec === null || prevSec === nowSec) return;
  const pick = state.picks?.find(p => p.pick_num == state.draft?.current_pick_num);
  if (!pick) return;
  const team = pick.team_name;
  for (const m of [5, 4, 3, 2, 1]) {
    if (prevSec > m * 60 && nowSec <= m * 60) {
      speak(`${team} has ${m} minute${m !== 1 ? 's' : ''} on the clock.`);
      return;
    }
  }
  if (prevSec > 30 && nowSec <= 30) {
    speak(`${team} has 30 seconds on the clock.`);
  }
}

function updateTimerDisplay(seconds) {
  const draftActive   = state.draft?.status === 'active';
  const draftPaused   = state.draft?.status === 'paused';
  const autoPickOn    = !!(state.draft?.auto_pick_enabled);
  const hasTimer      = draftActive && autoPickOn;
  const hasCountdown  = hasTimer && seconds !== null;

  const fmtTime = s => {
    const m = Math.floor(s / 60), sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  // Topbar countdown
  const display   = document.getElementById('timer-display');
  const countdown = document.getElementById('timer-countdown');
  const pausedEl  = document.getElementById('paused-display');
  if (display && countdown) {
    if (hasTimer) {
      display.classList.remove('hidden');
      countdown.className = 'timer-countdown';
      if (hasCountdown) {
        countdown.textContent = fmtTime(seconds);
        if (seconds <= 30) countdown.classList.add('warn');
        if (seconds <= 10) { countdown.classList.remove('warn'); countdown.classList.add('urgent'); }
      } else {
        countdown.textContent = `${state.draft.timer_minutes}:00`;
      }
    } else {
      display.classList.add('hidden');
    }
  }
  if (pausedEl) {
    pausedEl.classList.toggle('hidden', !draftPaused);
  }

  // Cell countdown
  const ctdwn = document.getElementById('cell-timer-countdown');
  if (ctdwn) {
    ctdwn.textContent = draftPaused ? 'PAUSED' : (hasCountdown ? fmtTime(seconds) : '');
    ctdwn.classList.toggle('cell-timer-paused', draftPaused);
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
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    // Play a silent 1-sample buffer — required by iOS to fully unlock the context
    const buf = audioCtx.createBuffer(1, 1, 22050);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start(0);
  } catch (_) {}
}
// iOS Safari requires AudioContext creation inside a user gesture
document.addEventListener('touchstart', unlockAudio, { passive: true });
document.addEventListener('click',      unlockAudio, { passive: true });

function playPickSound(isComplete = false) {
  if (!state.audioEnabled) return;
  // Haptic feedback — works on Android; iOS does not support navigator.vibrate
  if (navigator.vibrate) {
    navigator.vibrate(isComplete ? [100, 60, 100, 60, 200] : [100]);
  }
  // Synthesised chime via Web Audio API
  if (!audioCtx) return;
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

function speak(text) {
  if (!state.audioEnabled || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  window.speechSynthesis.speak(utt);
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

function showDeleteConfirm(message, onConfirm) {
  document.getElementById('delete-confirm-text').textContent = message;
  document.getElementById('delete-confirm-modal').classList.remove('hidden');
  const confirmBtn = document.getElementById('btn-delete-confirm');
  const handler = () => {
    confirmBtn.removeEventListener('click', handler);
    document.getElementById('delete-confirm-modal').classList.add('hidden');
    onConfirm();
  };
  confirmBtn.addEventListener('click', handler);
}
document.getElementById('btn-delete-cancel').addEventListener('click', () => {
  document.getElementById('delete-confirm-modal').classList.add('hidden');
});

let closeCurrentPlayerEdit = null;

function renderRankings() {
  if (closeCurrentPlayerEdit) return; // don't clobber an active inline edit
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
        return draftedByTeam[Number(p.id)]?.teamId === Number(state.teamId);
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
    && Number(currentPickTeamId()) === Number(state.teamId);

  players.forEach(p => {
    const drafted   = draftedIds.has(Number(p.id));
    const pickInfo  = draftedByTeam[Number(p.id)];
    const isMyPick  = drafted && pickInfo?.teamId === Number(state.teamId)
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

    const renderCardDisplay = () => {
      if (closeCurrentPlayerEdit === renderCardDisplay) closeCurrentPlayerEdit = null;
      card.innerHTML = `<span class="player-rank">#${p.rank}</span><span class="player-name">${esc(p.name)}</span>${p.age ? `<span class="player-age">${p.age}</span>` : ''}`;

      if (drafted && pickInfo) {
        const badge = document.createElement('span');
        badge.className = 'player-team-badge' + (isMyPick ? ' is-my-team' : '');
        badge.textContent = isMyPick ? '✓' : esc(pickInfo.teamName);
        card.appendChild(badge);
      }

      if (!drafted && state.role === 'admin' && !state.draft?.archived) {
        const editBtn = document.createElement('button');
        editBtn.className = 'player-edit-btn';
        editBtn.title = 'Edit';
        editBtn.innerHTML = '&#9998;';
        editBtn.addEventListener('click', e => { e.stopPropagation(); renderCardEdit(); });
        card.appendChild(editBtn);

        const delBtn = document.createElement('button');
        delBtn.className = 'player-delete-btn';
        delBtn.title = 'Delete';
        delBtn.innerHTML = '&#10005;';
        delBtn.addEventListener('click', e => {
          e.stopPropagation();
          showDeleteConfirm(`Delete "${p.name}"?`, async () => {
            try {
              await api(API.players, 'delete', { id: p.id });
              await fetchState();
              setTeamsNeedSetup(true);
            } catch (err) { alert('Error: ' + err.message); }
          });
        });
        card.appendChild(delBtn);
      }
    };

    const renderCardEdit = () => {
      if (closeCurrentPlayerEdit) closeCurrentPlayerEdit();
      closeCurrentPlayerEdit = renderCardDisplay;

      card.draggable = false;
      card.innerHTML =
        `<span class="player-rank">#${p.rank}</span>` +
        `<input type="text"   class="player-edit-name input-sm" value="${esc(p.name)}" style="flex:1;min-width:80px">` +
        `<input type="text" inputmode="numeric" maxlength="2" class="player-edit-age input-sm" value="${p.age ?? ''}" placeholder="Age" style="width:40px">` +
        `<button class="player-edit-confirm" title="Save">&#10003;</button>` +
        `<button class="player-edit-reject"  title="Cancel">&#10005;</button>`;

      const nameIn = card.querySelector('.player-edit-name');
      const ageIn  = card.querySelector('.player-edit-age');
      nameIn.focus();
      nameIn.select();

      const doSave = async () => {
        const name = nameIn.value.trim();
        if (!name) { nameIn.focus(); return; }
        const newAge = ageIn.value.trim() && /^\d+$/.test(ageIn.value.trim()) ? parseInt(ageIn.value, 10) : null;
        try {
          await api(API.players, 'update', { id: p.id, name, rank: p.rank, position: p.position ?? null, age: newAge, is_pitcher: p.is_pitcher ?? 0, is_catcher: p.is_catcher ?? 0 });
          p.name = name; p.age = newAge;
          const sp = state.players.find(x => x.id === p.id);
          if (sp) { sp.name = name; sp.age = newAge; }
          card.innerHTML = `<span class="player-rank">#${p.rank}</span><span class="player-name">${esc(p.name)}</span>${p.age ? `<span class="player-age">${p.age}</span>` : ''}<span class="player-saved-flash">&#10003;</span>`;
          setTimeout(() => renderCardDisplay(), 1200);
        } catch (e) { alert('Error: ' + e.message); renderCardDisplay(); }
      };

      card.querySelector('.player-edit-confirm').addEventListener('click', e => { e.stopPropagation(); doSave(); });
      card.querySelector('.player-edit-reject').addEventListener('click',  e => { e.stopPropagation(); renderCardDisplay(); });
      nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); if (e.key === 'Escape') renderCardDisplay(); });
      ageIn.addEventListener('keydown',  e => { if (e.key === 'Enter') doSave(); if (e.key === 'Escape') renderCardDisplay(); });
    };

    renderCardDisplay();

    if (!drafted && state.role === 'admin' && !state.draft?.archived) {
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
  showPickConfirm(player);
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
          !draftedIds.has(Number(p.id)) || draftedByTeamM[Number(p.id)]?.teamId === Number(state.teamId)
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
        const isMyPick  = isDrafted && pickInfo?.teamId === Number(state.teamId)
                          && (state.role === 'coach' || state.role === 'team');

        const row = document.createElement('div');
        row.className = 'mobile-player-row' + (isDrafted && !isMyPick ? ' is-drafted' : '')
                                             + (isMyPick ? ' is-my-pick' : '');
        row.innerHTML =
          `<span class="mobile-player-rank">#${p.rank}</span>` +
          `<span class="mobile-player-name">${esc(p.name)}</span>` +
          `${p.age ? `<span class="player-age">${p.age}</span>` : ''}`;

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
        playerCell = `<span class="mobile-pick-player">${esc(pick.player_name)}</span>${pick.player_age ? `<span class="mobile-pick-age">${pick.player_age}</span>` : ''}`;
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
  if (state.dragPlayerId !== null) return; // don't clobber an in-progress drag-to-board
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
      const isSkipped     = !isFilled && Number(pick.skipped);
      const isSetup       = state.draft.status === 'setup';

      if (isCurrent)     td.classList.add('is-current');
      if (isFilled)      td.classList.add('is-filled');
      else if (isSkipped) td.classList.add('is-skipped');
      else               td.classList.add('is-pick-slot');
      if (isPreassigned) { td.classList.remove('is-filled'); td.classList.add('is-preassigned'); }

      if (state.role === 'admin' && !state.draft?.archived && !isFilled) {
        td.addEventListener('dragover',  onCellDragOver);
        td.addEventListener('dragleave', onCellDragLeave);
        td.addEventListener('drop', e => onCellDrop(e, pick));
      }

      if (isFilled) {
        td.innerHTML = `<span class="cell-pick-num">#${pick.pick_num}</span>
          <span class="cell-player">${pick.player_name.split(' ').map(w => `<span>${esc(w)}</span>`).join('')}</span>
          ${pick.player_age ? `<span class="cell-player-age">${pick.player_age}</span>` : ''}
          ${state.role === 'admin' && !state.draft?.archived ? '<button class="cell-clear-btn" title="Remove pick">\u2715</button>' : ''}`;
        if (state.role === 'admin' && !state.draft?.archived) {
          td.querySelector('.cell-clear-btn').addEventListener('click', e => {
            e.stopPropagation();
            clearPick(pick.pick_num);
          });
          td.addEventListener('contextmenu', e => { e.preventDefault(); clearPick(pick.pick_num); });
        }
      } else if (isSkipped) {
        td.innerHTML = `<span class="cell-pick-num">#${pick.pick_num}</span>
          <span class="cell-skip-label">SKIP</span>
          ${state.role === 'admin' && !state.draft?.archived ? '<button class="cell-unskip-btn" title="Unskip this slot">&#8617;</button>' : ''}`;
        if (state.role === 'admin' && !state.draft?.archived) {
          td.querySelector('.cell-unskip-btn').addEventListener('click', e => {
            e.stopPropagation();
            toggleSkip(pick.pick_num);
          });
        }
      } else {
        if (isCurrent) td.id = 'clock-cell';
        td.innerHTML = `<span class="cell-pick-num">#${pick.pick_num}</span>` +
          (isCurrent
            ? `<span class="cell-clock-label">ON THE CLOCK</span>` +
              `<span id="cell-timer-countdown" class="cell-timer-countdown"></span>` +
              (state.role === 'admin' ? `<button class="cell-skip-btn" title="Skip this pick">Skip</button>` : '')
            : (state.role === 'admin' && !state.draft?.archived
                ? `<button class="cell-skip-btn" title="Skip this slot">Skip</button>`
                : ''));
        if (isCurrent && state.role === 'admin') {
          td.querySelector('.cell-skip-btn')?.addEventListener('click', e => {
            e.stopPropagation();
            skipPick();
          });
        } else if (state.role === 'admin' && !state.draft?.archived) {
          td.querySelector('.cell-skip-btn')?.addEventListener('click', e => {
            e.stopPropagation();
            toggleSkip(pick.pick_num);
          });
        }
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

function clearPick(pickNum) {
  const pick = state.picks.find(p => p.pick_num == pickNum);
  const playerName = pick?.player_name || `pick #${pickNum}`;

  document.getElementById('pick-confirm-text').textContent =
    `Remove "${playerName}" from pick #${pickNum}?`;
  document.getElementById('pick-confirm-modal').classList.remove('hidden');

  const confirmBtn = document.getElementById('btn-pick-confirm');
  const handler = async () => {
    confirmBtn.removeEventListener('click', handler);
    document.getElementById('pick-confirm-modal').classList.add('hidden');
    try {
      await api(API.drafts, 'clear_pick', { pick_num: pickNum });
      await fetchState();
    } catch (e) { alert('Error: ' + e.message); }
  };
  confirmBtn.addEventListener('click', handler);
}

async function skipPick() {
  try {
    const data = await api(API.drafts, 'skip_pick', {});
    applyState(data);
    if (state.draft?.status === 'active') { stopTimer(); startTimer(); }
  } catch (e) { alert('Error: ' + e.message); }
}

async function toggleSkip(pickNum) {
  try {
    const data = await api(API.drafts, 'toggle_skip', { pick_num: pickNum });
    applyState(data);
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
function onCellDrop(e, pick) {
  e.preventDefault(); e.currentTarget.classList.remove('drop-target');
  if (!state.dragPlayerId || !state.draft) return;
  const playerId = state.dragPlayerId;
  state.dragPlayerId = null;
  const player   = state.players.find(p => Number(p.id) === playerId);
  const playerName = player?.name || `Player #${playerId}`;
  const slotDesc   = pick.team_name ? `${esc(pick.team_name)} (pick #${pick.pick_num})` : `pick #${pick.pick_num}`;
  const existing   = pick.player_id ? ` Replaces: ${esc(pick.player_name)}.` : '';

  document.getElementById('pick-confirm-text').textContent =
    `Assign "${playerName}" to ${slotDesc}?${existing}`;
  document.getElementById('pick-confirm-modal').classList.remove('hidden');

  const confirmBtn = document.getElementById('btn-pick-confirm');
  const handler = async () => {
    confirmBtn.removeEventListener('click', handler);
    document.getElementById('pick-confirm-modal').classList.add('hidden');
    try {
      await api(API.drafts, 'force_assign', { pick_num: pick.pick_num, player_id: playerId });
      await fetchState();
    } catch (err) { alert('Error: ' + err.message); }
  };
  confirmBtn.addEventListener('click', handler);
}

// ── Player Reorder ────────────────────────────────────────────────────────────
let reorderDragSrcIdx = null;

function renderReorderList() {
  if (reorderDragSrcIdx !== null) return; // don't clobber an in-progress reorder drag
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
  if (list.contains(document.activeElement)) return; // don't clobber an active name/PIN edit
  if (state.teams.length === 0) { list.innerHTML = '<div class="empty-state" style="padding:8px">No teams yet.</div>'; return; }
  list.innerHTML = '';
  state.teams.forEach(t => {
    const item = document.createElement('div');
    item.className = 'team-item';

    if (state.role === 'admin') {
      item.innerHTML =
        `<span class="team-order">${t.draft_order}.</span>` +
        `<input type="text" class="team-name-input input-sm" value="${esc(t.name)}" title="Team name">` +
        `<input type="text" class="team-pin-input input-sm" placeholder="${t.has_pin ? '(PIN set — leave blank to keep)' : 'Set a PIN'}" title="Team login PIN">` +
        `<button class="team-pin-set btn btn-sm btn-secondary">Set</button>` +
        (state.draft?.coach_mode === 'team'
          ? tokenStatusHtml(t.token_expires_at)
            + `<button class="btn-gen-team-link btn btn-sm btn-secondary" data-team-id="${t.id}">Link</button>`
          : '') +
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
          if (team) { team.has_pin = pin !== ''; delete team.pin; }
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


document.getElementById('team-list').addEventListener('click', async e => {
  const btn = e.target.closest('.btn-gen-team-link');
  if (!btn) return;
  const teamId = parseInt(btn.dataset.teamId, 10);
  btn.disabled = true;
  try {
    const data = await generateAndCopyToken('team', teamId);
    const team = state.teams?.find(t => t.id === teamId);
    if (team) team.token_expires_at = data.expires_at;
    btn.textContent = 'Copied!';
    setTimeout(() => { renderTeamList(); }, 2000);
  } catch(e) {
    alert('Error: ' + e.message);
    btn.disabled = false;
  }
});

async function deleteTeam(id) {
  try {
    await api(API.teams, 'delete', { id });
    await fetchState();
    setTeamsNeedSetup(true);
  } catch (e) { alert('Error: ' + e.message); }
}

// ── Quick-add multiple teams ───────────────────────────────────────────────────
(function initQuickAddTeams() {
  const toggleBtn = document.getElementById('btn-quick-add-toggle');
  const panel     = document.getElementById('quick-add-teams');
  const cancelBtn = document.getElementById('btn-quick-add-cancel');
  const submitBtn = document.getElementById('btn-quick-add-submit');
  const textarea  = document.getElementById('quick-add-names');
  if (!toggleBtn) return;
  toggleBtn.addEventListener('click', () => {
    panel.classList.remove('hidden');
    toggleBtn.classList.add('hidden');
    textarea.focus();
  });
  cancelBtn.addEventListener('click', () => {
    panel.classList.add('hidden');
    toggleBtn.classList.remove('hidden');
    textarea.value = '';
    document.getElementById('quick-add-clear').checked = false;
  });
  submitBtn.addEventListener('click', async () => {
    const names = textarea.value.split('\n').map(n => n.trim()).filter(Boolean);
    if (!names.length) { textarea.focus(); return; }
    const teams = names.map(name => ({ name, pin: '' }));
    const clearExisting = document.getElementById('quick-add-clear').checked;
    try {
      await api(API.teams, 'bulk_create', { teams, clear_existing: clearExisting });
      textarea.value = '';
      document.getElementById('quick-add-clear').checked = false;
      panel.classList.add('hidden');
      toggleBtn.classList.remove('hidden');
      await fetchState();
      setTeamsNeedSetup(true);
    } catch (e) { alert('Error: ' + e.message); }
  });
}());

// ── Controls ──────────────────────────────────────────────────────────────────
function updateControls() {
  const status        = state.draft?.status || 'none';
  const isArchived    = !!state.draft?.archived;
  const btnStart      = document.getElementById('btn-start');
  const btnRestart    = document.getElementById('btn-restart');
  const btnPause      = document.getElementById('btn-pause');
  const btnResume     = document.getElementById('btn-resume');
  const btnEnd        = document.getElementById('btn-end');
  const btnAutopick   = document.getElementById('btn-autopick-now');
  const btnUndo       = document.getElementById('btn-undo');
  const btnResetPicks = document.getElementById('btn-reset-picks');
  const btnArchive    = document.getElementById('btn-archive');
  const btnUnarchive  = document.getElementById('btn-unarchive');
  const bar           = document.getElementById('board-controls-bar');

  if (bar) bar.classList.toggle('hidden', !state.draft || state.role !== 'admin');

  const isCompleted   = status === 'completed';
  const hasFilledPick = state.picks.some(p => p.player_id);

  if (isArchived) {
    // Read-only: hide all action buttons except Unarchive
    btnStart.classList.add('hidden');
    btnRestart.classList.add('hidden');
    btnPause.classList.add('hidden');
    btnResume.classList.add('hidden');
    btnEnd.disabled = true;
    btnAutopick.classList.add('hidden');
    btnUndo.classList.add('hidden');
    if (btnArchive)   btnArchive.classList.add('hidden');
    if (btnUnarchive) btnUnarchive.classList.remove('hidden');
  } else {
    const setupIncomplete = settingsDirty
      || !state.teams.length
      || !state.players.length
      || !state.picks?.length
      || state.teamsNeedSetup;
    btnStart.classList.toggle('hidden', isCompleted);
    btnStart.disabled = !(status === 'setup') || setupIncomplete;
    btnStart.title = (status === 'setup' && setupIncomplete)
      ? (settingsDirty          ? 'Save settings first'
        : !state.teams.length   ? 'Add teams first'
        : !state.players.length ? 'Add players first'
        : 'Build the pick order first')
      : '';
    btnRestart.classList.toggle('hidden', !isCompleted);
    btnEnd.disabled    = !(status === 'active' || status === 'paused');
    btnPause.classList.toggle('hidden',    status !== 'active');
    btnResume.classList.toggle('hidden',   status !== 'paused');
    btnAutopick.classList.toggle('hidden', !(status === 'active' && state.draft?.auto_pick_enabled));
    btnUndo.classList.toggle('hidden', !(hasFilledPick && (status === 'active' || status === 'paused' || status === 'completed')));
    if (btnArchive)   btnArchive.classList.toggle('hidden', !(isCompleted));
    if (btnUnarchive) btnUnarchive.classList.add('hidden');
  }

  if (btnResetPicks) btnResetPicks.disabled = (status === 'active');
}

function updateStatusBadge() {
  const status   = state.draft?.status || 'none';
  const cls      = 'badge badge-' + (status === 'none' ? 'setup' : status);
  const labels   = { none: 'No Draft', setup: 'Not Started' };
  const text     = labels[status] ?? (status.charAt(0).toUpperCase() + status.slice(1));
  const b = document.getElementById('draft-status-badge-mobile');
  if (b) { b.className = cls; b.textContent = text; }
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

// ── Collapse stepper panels ───────────────────────────────────────────────────
let adminTabsCollapsed = localStorage.getItem('ez_tabs_collapsed') === '1';

function applyTabsCollapsed() {
  document.querySelectorAll('.stepper-panel').forEach(p => {
    p.classList.toggle('panels-collapsed', adminTabsCollapsed);
  });
  document.getElementById('btn-collapse-tabs').textContent = adminTabsCollapsed ? '▲' : '▼';
}

applyTabsCollapsed();

document.getElementById('btn-collapse-tabs').addEventListener('click', () => {
  adminTabsCollapsed = !adminTabsCollapsed;
  localStorage.setItem('ez_tabs_collapsed', adminTabsCollapsed ? '1' : '0');
  applyTabsCollapsed();
});

// ── Add single team ───────────────────────────────────────────────────────────
document.getElementById('btn-add-team').addEventListener('click', async () => {
  const nameInput = document.getElementById('add-team-name');
  const pinInput  = document.getElementById('add-team-pin');
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  try {
    await api(API.teams, 'create', { name, pin: pinInput.value.trim() });
    nameInput.value = '';
    pinInput.value  = '';
    await fetchState();
    setTeamsNeedSetup(true);
  } catch (e) { alert('Error: ' + e.message); }
});
document.getElementById('add-team-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-add-team').click();
});

// ── Add single player ─────────────────────────────────────────────────────────
document.getElementById('btn-add-player').addEventListener('click', async () => {
  const nameInput    = document.getElementById('add-player-name');
  const ageInput     = document.getElementById('add-player-age');
  const posInput     = document.getElementById('add-player-position');
  const pitcherInput = document.getElementById('add-player-pitcher');
  const catcherInput = document.getElementById('add-player-catcher');
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  const nextRank = state.players.length > 0
    ? Math.max(...state.players.map(p => p.rank)) + 1
    : 1;
  const ageVal = ageInput.value.trim();
  try {
    await api(API.players, 'create', {
      name,
      position:   posInput.value.trim() || null,
      rank:       nextRank,
      age:        ageVal ? parseInt(ageVal, 10) : null,
      is_pitcher: pitcherInput.checked ? 1 : 0,
      is_catcher: catcherInput.checked ? 1 : 0,
    });
    nameInput.value    = '';
    ageInput.value     = '';
    posInput.value     = '';
    pitcherInput.checked = false;
    catcherInput.checked = false;
    await fetchState();
    setTeamsNeedSetup(true);
  } catch (e) { alert('Error: ' + e.message); }
});
document.getElementById('add-player-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-add-player').click();
});

// ── Hide / show rankings panel ────────────────────────────────────────────────
(function () {
  const panel   = document.getElementById('rankings-panel');
  const showBtn = document.getElementById('btn-show-rankings');
  if (!panel || !showBtn) return;

  function setRankingsVisible(visible) {
    panel.classList.toggle('rankings-hidden', !visible);
    showBtn.classList.toggle('hidden', visible);
    localStorage.setItem('ez_rankings_hidden', visible ? '0' : '1');
  }

  // Restore saved state
  if (localStorage.getItem('ez_rankings_hidden') === '1') setRankingsVisible(false);

  document.getElementById('btn-hide-rankings').addEventListener('click', () => setRankingsVisible(false));
  showBtn.addEventListener('click', () => setRankingsVisible(true));
}());

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
  try {
    const data = await api(API.drafts, 'resume', {});
    applyState(data);
    startTimer();
  } catch (e) { alert('Error: ' + e.message); }
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

document.getElementById('btn-archive').addEventListener('click', async () => {
  if (!confirm('Archive this draft? It will be moved to the Archived section.')) return;
  try {
    const data = await api(API.drafts, 'archive', {});
    applyState(data);
  } catch (e) { alert('Error: ' + e.message); }
});

document.getElementById('btn-unarchive').addEventListener('click', async () => {
  try {
    const data = await api(API.drafts, 'unarchive', {});
    applyState(data);
  } catch (e) { alert('Error: ' + e.message); }
});

// ── Filters ───────────────────────────────────────────────────────────────────
document.getElementById('filter-search').addEventListener('input', renderRankings);
document.getElementById('filter-available').addEventListener('change', renderRankings);

// ── Admin Stepper ─────────────────────────────────────────────────────────────
function switchAdminStep(name) {
  if (adminTabsCollapsed) {
    adminTabsCollapsed = false;
    localStorage.setItem('ez_tabs_collapsed', '0');
    applyTabsCollapsed();
  }
  document.querySelectorAll('.stepper-step').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.stepper-panel').forEach(p => p.classList.add('hidden'));
  const btn   = document.querySelector(`.stepper-step[data-step="${name}"]`);
  const panel = document.getElementById('stepper-panel-' + name);
  if (btn)   btn.classList.add('active');
  if (panel) panel.classList.remove('hidden');
}

function setTeamsNeedSetup(needed) {
  state.teamsNeedSetup = needed;
  const noticeEl = document.getElementById('pickorder-needs-rebuild');
  const setupBtn = document.getElementById('btn-setup-picks');
  if (noticeEl) noticeEl.classList.toggle('hidden', !needed);
  if (setupBtn) setupBtn.classList.toggle('btn-needs-action', needed);
  updateStepBadges();
  updateControls();
}

function updateStepBadges() {
  if (!state.draft) return;

  const settingsBadge = document.getElementById('step-badge-settings');
  if (settingsBadge) {
    settingsBadge.textContent = settingsDirty ? '!' : '✓';
    settingsBadge.className   = 'step-badge' + (settingsDirty ? ' step-badge-warn' : ' step-badge-done');
  }

  const teamsBadge = document.getElementById('step-badge-teams');
  if (teamsBadge) {
    teamsBadge.textContent = state.teams.length || '';
    teamsBadge.className   = 'step-badge' + (state.teams.length ? ' step-badge-count' : '');
  }

  const playersBadge = document.getElementById('step-badge-players');
  if (playersBadge) {
    playersBadge.textContent = state.players.length || '';
    playersBadge.className   = 'step-badge' + (state.players.length ? ' step-badge-count' : '');
  }

  const pickBadge = document.getElementById('step-badge-pickorder');
  if (pickBadge) {
    if (!state.picks?.length) {
      pickBadge.textContent = ''; pickBadge.className = 'step-badge';
    } else if (state.teamsNeedSetup) {
      pickBadge.textContent = '!'; pickBadge.className = 'step-badge step-badge-warn';
    } else {
      pickBadge.textContent = '✓'; pickBadge.className = 'step-badge step-badge-done';
    }
  }

  updatePickOrderSummary();
}

function updatePickOrderSummary() {
  const summaryEl = document.getElementById('pickorder-summary');
  const readyEl   = document.getElementById('pickorder-ready');
  if (!summaryEl || !readyEl) return;
  const tc = state.teams.length, pc = state.players.length, picks = state.picks?.length ?? 0;
  if (!tc || !pc) {
    summaryEl.innerHTML = '<em>Add teams and players first.</em>';
    readyEl.classList.add('hidden');
    return;
  }
  const rounds = Math.round(picks / tc) || Math.round(pc / tc);
  summaryEl.innerHTML =
    `<span class="po-stat">${tc} team${tc !== 1 ? 's' : ''}</span> &middot; ` +
    `<span class="po-stat">${pc} player${pc !== 1 ? 's' : ''}</span> &middot; ` +
    `<span class="po-stat">~${rounds} round${rounds !== 1 ? 's' : ''}</span>`;
  if (picks > 0 && !state.teamsNeedSetup) {
    readyEl.textContent = `✓ Pick order ready — ${picks} picks across ${rounds} rounds`;
    readyEl.classList.remove('hidden');
  } else {
    readyEl.classList.add('hidden');
  }
}

document.querySelectorAll('.stepper-step').forEach(btn => {
  btn.addEventListener('click', () => switchAdminStep(btn.dataset.step));
});

document.getElementById('btn-paste-import').addEventListener('click', async () => {
  const textarea  = document.getElementById('paste-names');
  const result    = document.getElementById('import-result');
  const replaceEl = document.getElementById('paste-replace');
  const names     = textarea.value.split('\n').map(n => n.trim()).filter(Boolean);
  if (!names.length) { result.textContent = 'Paste at least one name.'; result.className = 'import-result error'; return; }

  const doImport = async (replace) => {
    try {
      const data = await api(API.players, 'bulk_names', { names, replace });
      result.textContent = `Imported ${data.imported} player${data.imported !== 1 ? 's' : ''}.`;
      result.className = 'import-result';
      textarea.value = '';
      replaceEl.checked = false;
      await fetchState();
      setTeamsNeedSetup(true);
    } catch (e) { result.textContent = 'Import failed: ' + e.message; result.className = 'import-result error'; }
  };

  if (replaceEl.checked && state.players.length) {
    showDeleteConfirm(
      `Replace all ${state.players.length} existing player${state.players.length !== 1 ? 's' : ''} with the new list?`,
      () => doImport(true)
    );
  } else {
    doImport(false);
  }
});

document.getElementById('csv-file').addEventListener('change', async function() {
  const result = document.getElementById('import-result');
  if (!this.files.length) return;
  const form = new FormData();
  form.append('csv', this.files[0]);
  try {
    const data = await apiForm(API.players, 'import', form);
    result.textContent = `Imported ${data.imported} players.` +
      (data.errors?.length ? ` Errors: ${data.errors.join('; ')}` : '');
    result.className = 'import-result' + (data.errors?.length ? ' error' : '');
    this.value = '';
    await fetchState();
    setTeamsNeedSetup(true);
  } catch (e) {
    result.textContent = 'Import failed: ' + e.message;
    result.className = 'import-result error';
  }
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

// ── Board font size controls ───────────────────────────────────────────────────
(function () {
  const KEY = 'easydraft_cell_font_size', DEFAULT = 17;
  const slider = document.getElementById('font-size-slider');

  function applyFontSize(px) {
    document.documentElement.style.setProperty('--cell-player-size', px + 'px');
    // Update slider fill gradient to reflect current position
    const pct = ((px - slider.min) / (slider.max - slider.min)) * 100;
    slider.style.background = `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}%, #d1d5db ${pct}%, #d1d5db 100%)`;
  }

  const saved = parseInt(localStorage.getItem(KEY), 10);
  const initial = saved >= +slider.min && saved <= +slider.max ? saved : DEFAULT;
  slider.value = initial;
  applyFontSize(initial);

  slider.addEventListener('input', () => {
    const px = +slider.value;
    applyFontSize(px);
    localStorage.setItem(KEY, px);
  });

  function nudge(delta) {
    const next = Math.min(+slider.max, Math.max(+slider.min, +slider.value + delta));
    slider.value = next;
    applyFontSize(next);
    localStorage.setItem(KEY, next);
  }

  document.querySelector('.font-size-a--sm').addEventListener('click', () => nudge(-1));
  document.querySelector('.font-size-a--lg').addEventListener('click', () => nudge(+1));
}());

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await fetchState(); // applyState inside handles polling and timer startup
}

(async () => {
  const authed = await checkAuth();
  if (authed) await init();
})();
