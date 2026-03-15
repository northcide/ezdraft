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
    <div class="login-logo">&#9918; EasyDraft</div>
    <div id="login-error" class="login-error hidden"></div>
    <form id="login-form" autocomplete="off">
      <label class="login-label">League / Draft Name</label>
      <input id="login-league" type="text" class="login-input" placeholder="Enter league or draft name" autocomplete="off">
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

<!-- Main App -->
<div id="app">

  <!-- Top Bar -->
  <header id="topbar">
    <div class="topbar-left">
      <span class="logo">&#9918; EasyDraft</span>
      <span id="draft-status-badge" class="badge badge-setup">Setup</span>
    </div>
    <div class="topbar-center" id="timer-area">
      <div id="timer-display" class="timer-display hidden">
        <span id="timer-countdown" class="timer-countdown">2:00</span>
        <div id="timer-bar-wrap"><div id="timer-bar"></div></div>
      </div>
    </div>
    <div class="topbar-right">
      <span id="topbar-role" class="topbar-role"></span>
      <button id="btn-admin" class="btn btn-secondary admin-only">&#9881; Admin</button>
      <button id="btn-logout" class="btn btn-secondary">Sign Out</button>
    </div>
  </header>

  <!-- Coach Draft Selector Bar (visible only for coaches with multiple drafts) -->
  <div id="coach-draft-bar" class="coach-draft-bar hidden">
    <span class="coach-draft-label">Viewing:</span>
    <select id="coach-draft-selector" class="coach-draft-selector"></select>
  </div>

  <!-- Admin Panel (collapsible) -->
  <div id="admin-panel" class="admin-panel hidden admin-only">

    <!-- Draft Selector Row -->
    <div class="draft-selector-row">
      <div class="draft-selector-left">
        <label class="draft-selector-label">Draft</label>
        <select id="draft-selector" class="draft-selector-select">
          <option value="">&#8212; Select a draft &#8212;</option>
        </select>
        <span id="draft-selector-badge" class="badge badge-setup hidden"></span>
        <button id="btn-delete-draft" class="btn btn-sm btn-danger-outline hidden">Delete</button>
      </div>
      <div id="draft-controls-inline" class="draft-controls-inline hidden">
        <button id="btn-start"        class="btn btn-sm btn-success" disabled>&#9654; Start</button>
        <button id="btn-restart"      class="btn btn-sm btn-success hidden">&#9654; Restart</button>
        <button id="btn-pause"        class="btn btn-sm btn-warning hidden">&#9646;&#9646; Pause</button>
        <button id="btn-resume"       class="btn btn-sm btn-success hidden">&#9654; Resume</button>
        <button id="btn-end"          class="btn btn-sm btn-danger" disabled>&#9646; End</button>
        <button id="btn-autopick-now" class="btn btn-sm btn-secondary hidden">&#9889; Auto-pick</button>
      </div>
      <div class="draft-selector-right">
        <!-- Inline new draft form, hidden by default -->
        <div id="new-draft-inline" class="new-draft-inline hidden">
          <input type="text" id="new-draft-name" class="input-sm" placeholder="Draft name" style="width:160px">
          <button id="btn-confirm-new-draft" class="btn btn-sm btn-primary">Create</button>
          <button id="btn-cancel-new-draft" class="btn btn-sm btn-secondary">Cancel</button>
        </div>
        <button id="btn-new-draft" class="btn btn-sm btn-primary">+ New Draft</button>
      </div>
    </div>

    <!-- Draft Content (shown when a draft is selected) -->
    <div id="draft-content" class="draft-content hidden">

      <!-- Tab Navigation -->
      <div class="admin-tabs">
        <button class="admin-tab active" data-tab="settings">1. Settings</button>
        <button class="admin-tab" data-tab="teams">2. Teams</button>
        <button class="admin-tab" data-tab="players">3. Players</button>
        <button class="admin-tab" data-tab="controls">&#9888; Danger Zone</button>
      </div>

      <!-- Settings Tab -->
      <div id="admin-tab-settings" class="admin-tab-panel">
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
        <div class="tab-field-row">
          <div class="tab-field-group">
            <label class="tab-label">Coach Access Name</label>
            <input type="text" id="setting-coach-name" class="input-sm" style="width:200px" placeholder="e.g. Majors Coaches">
          </div>
          <div class="tab-field-group">
            <label class="tab-label">Coach PIN</label>
            <input type="text" id="setting-coach-pin" class="input-sm" style="width:160px" placeholder="e.g. majors2026">
          </div>
        </div>
        <div class="admin-row" style="margin-top:14px">
          <button id="btn-save-settings" class="btn btn-secondary">Save Settings</button>
        </div>
      </div>

      <!-- Teams Tab -->
      <div id="admin-tab-teams" class="admin-tab-panel hidden">
        <div id="team-list" class="team-list" style="max-height:220px"></div>
        <div class="admin-row" style="margin-top:10px">
          <input type="text" id="new-team-name" placeholder="Team name" class="input-sm">
          <button id="btn-add-team" class="btn btn-sm btn-primary">+ Add Team</button>
        </div>
      </div>

      <!-- Players Tab -->
      <div id="admin-tab-players" class="admin-tab-panel hidden">
        <div class="import-tabs">
          <button class="import-tab active" data-tab="paste">Paste List</button>
          <button class="import-tab" data-tab="csv">CSV File</button>
        </div>
        <div id="import-tab-paste" class="import-tab-panel">
          <p class="help-text">One name per line &#8212; order determines ranking (line 1 = rank 1).</p>
          <textarea id="paste-names" class="paste-textarea" placeholder="John Smith&#10;Jane Doe&#10;Mike Johnson&#10;..."></textarea>
          <div class="admin-row">
            <button id="btn-paste-import" class="btn btn-primary">Import List</button>
            <button id="btn-clear-players" class="btn btn-danger-outline">Clear All Players</button>
          </div>
        </div>
        <div id="import-tab-csv" class="import-tab-panel hidden">
          <p class="help-text">CSV columns: <code>name, rank, position, age, coaches_kid</code></p>
          <div class="admin-row">
            <input type="file" id="csv-file" accept=".csv">
            <button id="btn-import" class="btn btn-primary">Import CSV</button>
          </div>
        </div>
        <div id="import-result" class="import-result"></div>
        <div class="tab-divider"></div>
        <div id="setup-picks-warning" class="setup-picks-warning hidden">
          &#9888; Teams or players changed &mdash; update the pick order before starting.
        </div>
        <div class="admin-row">
          <button id="btn-setup-picks" class="btn btn-primary">&#9654; Setup Pick Order</button>
          <button id="btn-setup-picks-cancel" class="btn btn-secondary hidden">Cancel</button>
          <span class="help-text" style="margin:0">Calculates rounds from player count &divide; teams, then builds the snake draft order.</span>
        </div>
      </div>

      <!-- Danger Zone Tab -->
      <div id="admin-tab-controls" class="admin-tab-panel hidden">
        <div class="controls-group">
          <div class="admin-row">
            <button id="btn-reset-picks" class="btn btn-danger-outline">&#8635; Reset All Picks</button>
          </div>
          <p class="help-text" style="margin-top:6px">Clears all player assignments and returns the draft to setup. Teams and players are kept.</p>
        </div>
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
            <button id="btn-toggle-reorder" class="btn btn-sm btn-secondary" title="Reorder players">&#8693; Reorder</button>
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
      <div class="board-header">
        <h2 id="board-draft-name">Draft Board</h2>
        <span id="current-pick-label" class="current-pick-label"></span>
      </div>
      <div id="board-wrap" class="board-wrap">
        <div class="empty-state">Select a draft to see the board.</div>
      </div>
    </main>

  </div>
</div>

<script src="js/app.js?v=<?= $jsV ?>"></script>
</body>
</html>
