<?php
if (!empty($_GET['token'])) {
    require_once __DIR__ . '/api/helpers.php';
    $raw = trim($_GET['token']);
    if (preg_match('/^[0-9a-f]{64}$/', $raw)) {
        $db  = getDB();
        $now = (new DateTime('now', new DateTimeZone('UTC')))->format('Y-m-d H:i:s');

        // Try team token
        $s = $db->prepare("SELECT id AS team_id, draft_id FROM teams
                           WHERE login_token=? AND token_expires_at IS NOT NULL AND token_expires_at > ?");
        $s->execute([$raw, $now]);
        $team = $s->fetch();
        if ($team) {
            session_regenerate_id(true);
            $_SESSION['role']                 = 'team';
            $_SESSION['team_id']              = (int)$team['team_id'];
            $_SESSION['accessible_draft_ids'] = [(int)$team['draft_id']];
            $_SESSION['selected_draft_id']    = (int)$team['draft_id'];
            header('Location: ' . $_SERVER['PHP_SELF'], true, 302);
            exit;
        }

        // Try coach token
        $s = $db->prepare("SELECT id, coach_name FROM drafts
                           WHERE coach_login_token=? AND coach_token_expires_at IS NOT NULL
                             AND coach_token_expires_at > ? AND coach_mode='shared' AND archived=0");
        $s->execute([$raw, $now]);
        $draft = $s->fetch();
        if ($draft) {
            session_regenerate_id(true);
            $_SESSION['role']                 = 'coach';
            $_SESSION['league_name']          = $draft['coach_name'];
            $_SESSION['accessible_draft_ids'] = [(int)$draft['id']];
            $_SESSION['selected_draft_id']    = (int)$draft['id'];
            header('Location: ' . $_SERVER['PHP_SELF'], true, 302);
            exit;
        }

        // Check if token exists but is expired (don't leak info for unrecognized tokens)
        $s = $db->prepare("SELECT 1 FROM teams WHERE login_token=? UNION
                           SELECT 1 FROM drafts WHERE coach_login_token=? LIMIT 1");
        $s->execute([$raw, $raw]);
        if ($s->fetch()) {
            $tokenExpiredMessage = 'This login link has expired. Please ask your admin for a new one.';
        }
    }
}
?>
<?php
$cssV = filemtime(__DIR__ . '/css/app.css');
$jsV  = filemtime(__DIR__ . '/js/app.js');
?><!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EasyDraft</title>
  <link rel="stylesheet" href="css/app.css?v=<?= $cssV ?>">
</head>
<body>

<!-- Login Overlay -->
<div id="login-overlay" class="login-overlay">
  <div class="login-card">
    <div class="login-logo">EasyDraft</div>
    <?php if (!empty($tokenExpiredMessage)): ?>
      <div class="token-expired-notice"><?= htmlspecialchars($tokenExpiredMessage) ?></div>
    <?php endif; ?>
    <div id="login-error" class="login-error hidden"></div>
    <form id="login-form" autocomplete="off">
      <div id="login-type-toggle" class="login-type-toggle">
        <button type="button" class="login-type-btn" data-mode="admin">Admin</button>
        <button type="button" class="login-type-btn active" data-mode="team">Team</button>
      </div>
      <label class="login-label">League / Draft Name</label>
      <input id="login-league" type="text" class="login-input" placeholder="Enter league or draft name" autocomplete="off">
      <div id="login-team-row">
        <label class="login-label">Team Name <span style="font-weight:400;opacity:.7">(optional)</span></label>
        <input id="login-team" type="text" class="login-input" placeholder="Team name (leave blank for shared coach login)" autocomplete="off">
      </div>
      <label class="login-label">PIN</label>
      <input id="login-pin" type="password" class="login-input" placeholder="Enter PIN" autocomplete="new-password">
      <button type="submit" class="login-btn">Sign In</button>
    </form>
  </div>
</div>

<!-- Pick Announcement Overlay -->
<div id="announcement" class="announcement hidden">
  <div class="announcement-inner">
    <div class="announcement-pick">Pick <span id="ann-pick-num"></span></div>
    <div class="announcement-team" id="ann-team-name"></div>
    <div class="announcement-selects">selects</div>
    <div class="announcement-player" id="ann-player-name"></div>
    <div class="announcement-position" id="ann-player-pos"></div>
  </div>
</div>

<!-- Delete Confirmation Modal -->
<div id="delete-confirm-modal" class="pick-confirm-overlay hidden">
  <div class="pick-confirm-box">
    <p id="delete-confirm-text" class="pick-confirm-msg"></p>
    <div class="pick-confirm-actions">
      <button id="btn-delete-confirm" class="btn btn-danger">Delete</button>
      <button id="btn-delete-cancel"  class="btn btn-secondary">Cancel</button>
    </div>
  </div>
</div>

<!-- Pick Confirmation Modal -->
<div id="pick-confirm-modal" class="pick-confirm-overlay hidden">
  <div class="pick-confirm-box">
    <p id="pick-confirm-text" class="pick-confirm-msg"></p>
    <div class="pick-confirm-actions">
      <button id="btn-pick-confirm" class="btn btn-success">Confirm Pick</button>
      <button id="btn-pick-cancel"  class="btn btn-secondary">Cancel</button>
    </div>
  </div>
</div>

<!-- Main App -->
<div id="app">

  <!-- Top Bar -->
  <header id="topbar">
    <div class="topbar-left">
      <span class="logo">EasyDraft</span>
    </div>
    <div class="topbar-center" id="timer-area">
      <div id="timer-display" class="timer-display hidden">
        <span id="timer-countdown" class="timer-countdown">2:00</span>
        <div id="timer-bar-wrap"><div id="timer-bar"></div></div>
      </div>
      <div id="paused-display" class="paused-display hidden">&#9646;&#9646; PAUSED</div>
    </div>
    <div class="topbar-right">
      <span id="topbar-role" class="topbar-role"></span>
      <button id="btn-mute" class="btn btn-secondary btn-mute" title="Toggle audio announcements">&#128266;</button>
      <button id="btn-admin" class="btn btn-secondary admin-only">&#9881; Admin</button>
      <button id="btn-logout" class="btn btn-secondary">Sign Out</button>
    </div>
  </header>

  <!-- Draft Bar: selector + title + controls — always visible -->
  <div id="draft-bar" class="draft-bar">

    <!-- Admin: draft selector (left) -->
    <div class="draft-bar-left admin-only">
      <label class="draft-selector-label">Draft</label>
      <select id="draft-selector" class="draft-selector-select">
        <option value="">&#8212; Select a draft &#8212;</option>
      </select>
      <span id="draft-selector-badge" class="badge badge-setup hidden"></span>
      <button id="btn-delete-draft" class="btn btn-sm btn-danger-outline hidden">Delete</button>
      <div id="new-draft-inline" class="new-draft-inline hidden">
        <input type="text" id="new-draft-name" class="input-sm" placeholder="Draft name" style="width:140px">
        <button id="btn-confirm-new-draft" class="btn btn-sm btn-primary">Create</button>
        <button id="btn-cancel-new-draft" class="btn btn-sm btn-secondary">Cancel</button>
      </div>
      <button id="btn-new-draft" class="btn btn-sm btn-primary">+ New Draft</button>
    </div>

    <!-- Coach: draft selector (shown only when coach has multiple drafts) -->
    <div id="coach-draft-bar" class="draft-bar-left hidden">
      <span class="coach-draft-label">Viewing:</span>
      <select id="coach-draft-selector" class="coach-draft-selector"></select>
    </div>

    <!-- Center: draft name + on-the-clock info / completion badge -->
    <div class="draft-bar-center">
      <div class="draft-bar-row1">
        <span id="board-draft-name" class="draft-bar-name"></span>
        <span id="current-pick-label" class="current-pick-label"></span>
        <span id="draft-complete-banner" class="draft-complete-banner hidden">&#127942; Draft Complete &mdash; Final Results</span>
      </div>
      <span id="draft-status-badge-mobile" class="badge badge-setup">Setup</span>
    </div>

    <!-- Font size controls (all roles) -->
    <div class="font-size-controls" title="Adjust player name size">
      <span class="font-size-a font-size-a--sm">A</span>
      <input type="range" id="font-size-slider" class="font-size-slider" min="10" max="28" step="1" value="17">
      <span class="font-size-a font-size-a--lg">A</span>
    </div>

    <!-- Admin: draft controls (right) -->
    <div id="board-controls-bar" class="draft-bar-right admin-only hidden">
      <button id="btn-start"        class="btn btn-sm btn-success" disabled>&#9654; Start</button>
      <button id="btn-restart"      class="btn btn-sm btn-success hidden">&#9654; Restart</button>
      <button id="btn-archive"      class="btn btn-sm btn-secondary hidden">Archive</button>
      <button id="btn-unarchive"    class="btn btn-sm btn-secondary hidden">Unarchive</button>
      <button id="btn-pause"        class="btn btn-sm btn-warning hidden">&#9646;&#9646; Pause</button>
      <button id="btn-resume"       class="btn btn-sm btn-success hidden">&#9654; Resume</button>
      <button id="btn-end"          class="btn btn-sm btn-danger" disabled>&#9646; End</button>
      <button id="btn-autopick-now" class="btn btn-sm btn-secondary hidden">&#9889; Auto-pick</button>
      <button id="btn-undo"        class="btn btn-sm btn-secondary hidden">&#8617; Undo</button>
    </div>

  </div>

  <!-- Admin Panel (collapsible) — tabs only -->
  <div id="admin-panel" class="admin-panel hidden admin-only">
    <div id="draft-content" class="draft-content hidden">

      <!-- Stepper Navigation -->
      <div class="stepper-nav">
        <button class="stepper-step active" data-step="settings">
          <span class="step-num">1</span>
          <span class="step-label">Settings</span>
          <span class="step-badge" id="step-badge-settings"></span>
        </button>
        <div class="stepper-connector"></div>
        <button class="stepper-step" data-step="teams">
          <span class="step-num">2</span>
          <span class="step-label">Teams</span>
          <span class="step-badge" id="step-badge-teams"></span>
        </button>
        <div class="stepper-connector"></div>
        <button class="stepper-step" data-step="players">
          <span class="step-num">3</span>
          <span class="step-label">Players</span>
          <span class="step-badge" id="step-badge-players"></span>
        </button>
        <div class="stepper-connector"></div>
        <button class="stepper-step" data-step="pickorder">
          <span class="step-num">4</span>
          <span class="step-label">Pick Order</span>
          <span class="step-badge" id="step-badge-pickorder"></span>
        </button>
        <button id="btn-collapse-tabs" class="stepper-collapse" title="Collapse panel">&#9660;</button>
      </div>

      <!-- Step 1: Settings -->
      <div id="stepper-panel-settings" class="stepper-panel">
        <div class="tab-field-row">
          <div class="tab-field-group">
            <label class="tab-label">Draft Name</label>
            <input type="text" id="setting-draft-name" class="input-sm" style="width:200px">
          </div>
          <div class="tab-field-group">
            <label class="tab-label">Timer (min)</label>
            <input type="number" id="setting-timer" min="0" max="30" value="2" class="input-sm input-num">
          </div>
          <div class="tab-field-group">
            <label class="tab-label">&nbsp;</label>
            <label class="label-check"><input type="checkbox" id="setting-autopick" checked> Auto-pick on expire</label>
          </div>
        </div>
        <div class="tab-divider"></div>
        <div class="admin-row" id="coach-mode-row">
          <label class="label-check">
            <input type="radio" name="coach_mode" value="shared" checked> Shared Coach Login
          </label>
          <label class="label-check">
            <input type="radio" name="coach_mode" value="team"> Team Login
          </label>
        </div>
        <div id="shared-coach-fields">
          <div class="tab-field-row" style="margin-top:4px">
            <div class="tab-field-group">
              <label class="tab-label">Coach Access Name</label>
              <input type="text" id="setting-coach-name" class="input-sm" style="width:200px" placeholder="e.g. Majors Coaches">
            </div>
            <div class="tab-field-group">
              <label class="tab-label">Coach PIN</label>
              <input type="text" id="setting-coach-pin" class="input-sm" style="width:160px" placeholder="e.g. majors2026">
            </div>
          </div>
        </div>
        <div id="coach-link-row" class="admin-row" style="margin-top:10px;gap:10px;display:none">
          <span id="coach-link-status" class="token-status token-status--none">No link</span>
          <button id="btn-gen-coach-link" class="btn btn-sm btn-secondary">Generate &amp; Copy Link</button>
        </div>
        <div class="admin-row" style="margin-top:6px">
          <button id="btn-save-settings" class="btn btn-secondary" disabled>Save Settings</button>
        </div>
        <div class="tab-divider" style="margin-top:18px"></div>
        <details class="danger-zone-details">
          <summary class="danger-zone-summary">&#9888; Danger Zone</summary>
          <div class="controls-group" style="padding:8px 0 4px">
            <div class="admin-row">
              <button id="btn-reset-picks" class="btn btn-danger-outline">&#8635; Reset All Picks</button>
            </div>
            <p class="help-text" style="margin-top:6px">Clears all player assignments and returns the draft to setup. Teams and players are kept.</p>
          </div>
        </details>
      </div>

      <!-- Step 2: Teams -->
      <div id="stepper-panel-teams" class="stepper-panel hidden">
        <div id="team-list" class="team-list" style="max-height:220px"></div>
        <div class="add-single-row admin-only" style="margin-top:8px">
          <input type="text" id="add-team-name" class="input-sm" placeholder="New team name" style="flex:1;min-width:120px">
          <input type="text" id="add-team-pin" class="input-sm" placeholder="PIN (optional)" style="width:110px">
          <button id="btn-add-team" class="btn btn-sm btn-primary">+ Add Team</button>
        </div>
        <div class="quick-add-toggle-row admin-only" style="margin-top:8px">
          <button id="btn-quick-add-toggle" class="btn-link-muted">+ Add multiple at once</button>
        </div>
        <div id="quick-add-teams" class="hidden" style="margin-top:8px">
          <p class="help-text">One team name per line. PINs can be set individually after.</p>
          <textarea id="quick-add-names" class="paste-textarea" style="min-height:80px"
                    placeholder="Red Sox&#10;Yankees&#10;Cubs&#10;..."></textarea>
          <div class="admin-row" style="margin-top:6px">
            <label class="label-check">
              <input type="checkbox" id="quick-add-clear"> Replace existing teams
            </label>
            <button id="btn-quick-add-submit" class="btn btn-sm btn-primary">Add Teams</button>
            <button id="btn-quick-add-cancel" class="btn btn-sm btn-secondary">Cancel</button>
          </div>
        </div>
      </div>

      <!-- Step 3: Players -->
      <div id="stepper-panel-players" class="stepper-panel hidden">
        <p class="help-text">One entry per line. Optionally include age, P (pitcher), C (catcher) in any order after the name: <code>John Smith, 10, P</code> &mdash; CSV columns: <code>name, age, pitcher, catcher</code></p>
        <textarea id="paste-names" class="paste-textarea"
                  placeholder="John Smith,10,P&#10;Jane Doe,11,C&#10;Mike Johnson,9,P,C&#10;..."></textarea>
        <div class="admin-row" style="margin-top:6px">
          <button id="btn-paste-import" class="btn btn-primary">Import List</button>
          <label class="btn btn-secondary btn-sm" style="cursor:pointer">
            Import CSV <input type="file" id="csv-file" accept=".csv" style="display:none">
          </label>
          <label class="label-check" style="margin-left:4px">
            <input type="checkbox" id="paste-replace"> Replace existing players
          </label>
          <button id="btn-clear-players" class="btn btn-danger-outline">Clear All Players</button>
        </div>
        <div id="import-result" class="import-result"></div>
        <div class="tab-divider"></div>
        <div class="add-single-row admin-only">
          <input type="text"   id="add-player-name"     class="input-sm" placeholder="Player name" style="flex:1;min-width:130px">
          <input type="text" inputmode="numeric" maxlength="2" id="add-player-age" class="input-sm" placeholder="Age" style="width:46px">
          <input type="text"   id="add-player-position" class="input-sm" placeholder="Position (optional)" style="width:130px">
          <label class="label-check"><input type="checkbox" id="add-player-pitcher"> P</label>
          <label class="label-check"><input type="checkbox" id="add-player-catcher"> C</label>
          <button id="btn-add-player" class="btn btn-sm btn-primary">+ Add Player</button>
        </div>
      </div>

      <!-- Step 4: Pick Order -->
      <div id="stepper-panel-pickorder" class="stepper-panel hidden">
        <div id="pickorder-summary" class="pickorder-summary"></div>
        <div id="pickorder-needs-rebuild" class="pickorder-notice hidden">
          &#9888; Teams or players changed &mdash; rebuild the pick order before starting.
        </div>
        <div class="admin-row" style="margin-top:10px">
          <button id="btn-setup-picks" class="btn btn-primary">&#9654; Build Pick Order</button>
          <span class="help-text" style="margin:0">Calculates rounds from player count &divide; teams, then builds the snake draft order.</span>
        </div>
        <div id="pickorder-ready" class="pickorder-ready hidden"></div>
      </div>

    </div>
  </div>

  <!-- Main Content -->
  <div id="main-content">

    <!-- Left: Rankings / Reorder -->
    <aside id="rankings-panel">
      <div id="rankings-view">
        <div class="rankings-header">
          <div class="rankings-header-row">
            <input type="text" id="filter-search" class="search-input" placeholder="Search players&#8230;" autocomplete="off">
            <button id="btn-toggle-reorder" class="btn btn-sm btn-secondary admin-only" title="Reorder players">&#8693; Reorder</button>
            <button id="btn-hide-rankings" class="btn btn-sm btn-secondary" title="Hide player list">&#10094;</button>
          </div>
          <label class="filter-check">
            <input type="checkbox" id="filter-available" checked> Available only
          </label>
        </div>
        <div id="rankings-list" class="rankings-list">
          <div class="empty-state">No players loaded.</div>
        </div>
      </div>
      <div id="reorder-view" class="hidden">
        <div class="rankings-header reorder-header">
          <span class="reorder-title">Drag to reorder</span>
          <span id="reorder-status" class="reorder-status"></span>
          <button id="btn-close-reorder" class="btn btn-sm btn-secondary">&#10005; Done</button>
        </div>
        <div id="player-reorder-list-sidebar" class="player-reorder-list-sidebar"></div>
      </div>
    </aside>

    <!-- Right: Draft Board -->
    <main id="board-panel">
      <button id="btn-show-rankings" class="btn-show-rankings hidden" title="Show player list">&#10095;</button>
      <div id="board-wrap" class="board-wrap">
        <div class="empty-state">Select a draft to see the board.</div>
      </div>
    </main>

  </div>
</div>

<script src="js/app.js?v=<?= $jsV ?>"></script>
</body>
</html>
