<?php
require_once __DIR__ . '/helpers.php';
requireAuth();

$action = getAction();

try {
    $db = getDB();

    // ── helpers ───────────────────────────────────────────────────────────────

    function getContextDraft(PDO $db): ?array {
        $role = currentRole();
        if ($role === 'admin' && !empty($_SESSION['selected_draft_id'])) {
            $stmt = $db->prepare('SELECT * FROM drafts WHERE id=?');
            $stmt->execute([(int)$_SESSION['selected_draft_id']]);
            return $stmt->fetch() ?: null;
        }
        if (in_array($role, ['coach', 'team']) && !empty($_SESSION['selected_draft_id'])) {
            $accessible = array_map('intval', $_SESSION['accessible_draft_ids'] ?? []);
            $sel = (int)$_SESSION['selected_draft_id'];
            if (in_array($sel, $accessible, true)) {
                $stmt = $db->prepare('SELECT * FROM drafts WHERE id=?');
                $stmt->execute([$sel]);
                return $stmt->fetch() ?: null;
            }
        }
        // Fallback: live draft
        $stmt = $db->query("SELECT * FROM drafts WHERE status IN ('active','paused') ORDER BY updated_at DESC LIMIT 1");
        return $stmt->fetch() ?: null;
    }

    function sortedTeams(PDO $db, int $draftId): array {
        $stmt = $db->prepare('SELECT * FROM teams WHERE draft_id=? ORDER BY draft_order ASC');
        $stmt->execute([$draftId]);
        return array_map(
            fn($r) => array_merge(
                array_diff_key($r, ['pin' => 1, 'login_token' => 1]),
                [
                    'has_pin'          => !empty($r['pin']),
                    'token_expires_at' => $r['token_expires_at']
                        ? str_replace(' ', 'T', $r['token_expires_at']) . 'Z'
                        : null,
                ]
            ),
            $stmt->fetchAll()
        );
    }

    function snakeTeamForPick(array $teams, int $pickNum): array {
        $n     = count($teams);
        $round = (int)ceil($pickNum / $n);
        $pos   = ($pickNum - 1) % $n;
        if ($round % 2 === 0) $pos = ($n - 1) - $pos;
        return $teams[$pos];
    }

    function buildPickSlots(PDO $db, int $draftId, int $totalRounds): void {
        $teams = sortedTeams($db, $draftId);
        $n     = count($teams);
        if ($n === 0) return;
        $db->prepare('DELETE FROM picks WHERE draft_id=?')->execute([$draftId]);
        $stmt = $db->prepare(
            'INSERT INTO picks (draft_id, round, pick_num, team_id) VALUES (?,?,?,?)'
        );
        for ($p = 1; $p <= $n * $totalRounds; $p++) {
            $round = (int)ceil($p / $n);
            $team  = snakeTeamForPick($teams, $p);
            $stmt->execute([$draftId, $round, $p, $team['id']]);
        }
    }

    function advanceTimer(PDO $db, array $draft): void {
        if ($draft['status'] !== 'active') return;
        if (!$draft['auto_pick_enabled']) {
            $db->prepare('UPDATE drafts SET timer_end=NULL, timer_remaining_seconds=NULL WHERE id=?')
               ->execute([$draft['id']]);
            return;
        }
        $end = (new DateTime('now', new DateTimeZone('UTC')))
            ->modify('+' . $draft['timer_minutes'] . ' minutes')
            ->format('Y-m-d H:i:s');
        $db->prepare('UPDATE drafts SET timer_end=?, timer_remaining_seconds=NULL WHERE id=?')
           ->execute([$end, $draft['id']]);
    }

    function getNextAvailablePlayer(PDO $db, int $draftId): ?array {
        $stmt = $db->prepare(
            'SELECT * FROM players
             WHERE draft_id=? AND id NOT IN (
               SELECT player_id FROM picks WHERE draft_id=? AND player_id IS NOT NULL
             )
             ORDER BY `rank` ASC LIMIT 1'
        );
        $stmt->execute([$draftId, $draftId]);
        return $stmt->fetch() ?: null;
    }

    function nextUnfilledPickNum(PDO $db, int $draftId, int $afterPickNum): int {
        $totalStmt = $db->prepare('SELECT COUNT(*) FROM picks WHERE draft_id=?');
        $totalStmt->execute([$draftId]);
        $total = (int)$totalStmt->fetchColumn();
        $stmt  = $db->prepare('SELECT player_id, skipped FROM picks WHERE draft_id=? AND pick_num=?');
        $next  = $afterPickNum + 1;
        while ($next <= $total) {
            $stmt->execute([$draftId, $next]);
            $row = $stmt->fetch();
            if ($row && $row['player_id'] === null && !$row['skipped']) break;
            $next++;
        }
        return $next;
    }

    function fullState(PDO $db): array {
        $draft   = getContextDraft($db);
        $picks   = []; $teams = []; $players = [];

        if ($draft) {
            $stmt = $db->prepare(
                'SELECT pk.*, p.name AS player_name, p.rank AS player_rank, p.position AS player_position,
                        p.age AS player_age, p.is_pitcher AS player_is_pitcher, p.is_catcher AS player_is_catcher,
                        t.name AS team_name
                 FROM picks pk
                 LEFT JOIN players p ON pk.player_id = p.id
                 JOIN  teams t ON pk.team_id = t.id
                 WHERE pk.draft_id = ?
                 ORDER BY pk.pick_num ASC'
            );
            $stmt->execute([$draft['id']]);
            $picks   = $stmt->fetchAll();
            $teams   = sortedTeams($db, $draft['id']);
            $pStmt   = $db->prepare('SELECT * FROM players WHERE draft_id=? ORDER BY `rank` ASC');
            $pStmt->execute([$draft['id']]);
            $players = $pStmt->fetchAll();
        }

        $role      = currentRole();
        $allDrafts = null;
        $accessibleDrafts = null;

        if ($role === 'admin') {
            $allDrafts = array_map(
                fn($d) => array_merge(
                    array_diff_key($d, ['coach_pin' => 1, 'coach_login_token' => 1]),
                    [
                        'has_coach_pin'          => !empty($d['coach_pin']),
                        'coach_token_expires_at' => $d['coach_token_expires_at']
                            ? str_replace(' ', 'T', $d['coach_token_expires_at']) . 'Z'
                            : null,
                    ]
                ),
                $db->query(
                    'SELECT id, name, status, total_rounds, timer_minutes, auto_pick_enabled,
                            coach_name, coach_pin, coach_login_token, coach_token_expires_at,
                            coach_mode, created_at, started_at, completed_at, archived
                     FROM drafts WHERE archived = 0 ORDER BY created_at DESC'
                )->fetchAll()
            );
        } elseif ($role === 'coach') {
            $ids = array_map('intval', $_SESSION['accessible_draft_ids'] ?? []);
            if (!empty($ids)) {
                $placeholders = implode(',', array_fill(0, count($ids), '?'));
                $stmt = $db->prepare("SELECT id, name, status, started_at, completed_at FROM drafts WHERE id IN ($placeholders) ORDER BY created_at DESC");
                $stmt->execute($ids);
                $accessibleDrafts = $stmt->fetchAll();
            } else {
                $accessibleDrafts = [];
            }
        }

        // Append Z so JS parses timer_end as UTC (MySQL stores without timezone)
        if ($draft && $draft['timer_end']) {
            $draft['timer_end'] = str_replace(' ', 'T', $draft['timer_end']) . 'Z';
        }

        $archivedDrafts = null;
        if ($role === 'admin') {
            $archivedDrafts = $db->query(
                'SELECT id, name, status, completed_at FROM drafts WHERE archived = 1 ORDER BY completed_at DESC'
            )->fetchAll();
        }

        return [
            'draft'            => $draft,
            'picks'            => $picks,
            'teams'            => $teams,
            'players'          => $players,
            'role'             => $role,
            'team_id'          => ($role === 'team') ? ($_SESSION['team_id'] ?? null) : null,
            'allDrafts'        => $allDrafts,
            'archivedDrafts'   => $archivedDrafts,
            'accessibleDrafts' => $accessibleDrafts,
            'selectedDraftId'  => $_SESSION['selected_draft_id'] ?? null,
            'serverTime'       => (new DateTime('now', new DateTimeZone('UTC')))->format('c'),
        ];
    }

    // ── routing ───────────────────────────────────────────────────────────────

    if ($action === 'state') {
        jsonResponse(fullState($db));

    } elseif ($action === 'list') {
        requireAdmin();
        $drafts = array_map(
            fn($d) => array_merge(array_diff_key($d, ['coach_pin' => 1]), ['has_coach_pin' => !empty($d['coach_pin'])]),
            $db->query(
                'SELECT id, name, status, total_rounds, timer_minutes, auto_pick_enabled,
                        coach_name, coach_pin, created_at, started_at, completed_at
                 FROM drafts WHERE archived = 0 ORDER BY created_at DESC'
            )->fetchAll()
        );
        jsonResponse($drafts);

    } elseif ($action === 'list_archived') {
        requireAdmin();
        $drafts = $db->query(
            'SELECT id, name, status, total_rounds, timer_minutes, completed_at, started_at
             FROM drafts WHERE archived = 1 ORDER BY completed_at DESC'
        )->fetchAll();
        jsonResponse($drafts);

    } elseif ($action === 'archive') {
        requireAdmin();
        $draft = getContextDraft($db);
        if (!$draft) jsonError('No draft selected');
        if ($draft['status'] !== 'completed') jsonError('Only completed drafts can be archived');
        $db->prepare('UPDATE drafts SET archived = 1 WHERE id = ?')->execute([$draft['id']]);
        jsonResponse(fullState($db));

    } elseif ($action === 'unarchive') {
        requireAdmin();
        $draft = getContextDraft($db);
        if (!$draft) jsonError('No draft selected');
        $db->prepare('UPDATE drafts SET archived = 0 WHERE id = ?')->execute([$draft['id']]);
        jsonResponse(fullState($db));

    } elseif ($action === 'create') {
        requireAdmin();
        $data = getInput();
        if (empty($data['name'])) jsonError('name is required');
        $stmt = $db->prepare(
            'INSERT INTO drafts (name, status, total_rounds, timer_minutes, auto_pick_enabled, current_pick_num)
             VALUES (?, "setup", ?, ?, ?, 1)'
        );
        $stmt->execute([
            trim($data['name']),
            (int)($data['total_rounds'] ?? 10),
            (int)($data['timer_minutes'] ?? 2),
            (int)($data['auto_pick_enabled'] ?? 1),
        ]);
        $draftId = (int)$db->lastInsertId();
        $_SESSION['selected_draft_id'] = $draftId;
        jsonResponse(fullState($db), 201);

    } elseif ($action === 'select') {
        requireAdmin();
        $data    = getInput();
        $draftId = (int)($data['id'] ?? 0);
        if (!$draftId) jsonError('id required');
        $stmt = $db->prepare('SELECT id FROM drafts WHERE id=?');
        $stmt->execute([$draftId]);
        if (!$stmt->fetch()) jsonError('Draft not found', 404);
        $_SESSION['selected_draft_id'] = $draftId;
        jsonResponse(fullState($db));

    } elseif ($action === 'coach_select') {
        if (currentRole() !== 'coach') jsonError('Coach access required', 403);
        $data    = getInput();
        $draftId = (int)($data['id'] ?? 0);
        if (!$draftId) jsonError('id required');
        $accessible = array_map('intval', $_SESSION['accessible_draft_ids'] ?? []);
        if (!in_array($draftId, $accessible, true)) jsonError('Draft not accessible', 403);
        $_SESSION['selected_draft_id'] = $draftId;
        jsonResponse(fullState($db));

    } elseif ($action === 'update_settings') {
        requireAdmin();
        $data  = getInput();
        $draft = getContextDraft($db);
        if (!$draft) jsonError('No draft selected');
        if ($draft['status'] === 'active') jsonError('Cannot change settings while draft is active');

        $name      = isset($data['name'])             ? trim($data['name'])             : $draft['name'];
        $timer     = isset($data['timer_minutes'])     ? max(1, min(60, (int)$data['timer_minutes'])) : $draft['timer_minutes'];
        $auto      = isset($data['auto_pick_enabled']) ? (int)$data['auto_pick_enabled'] : $draft['auto_pick_enabled'];
        $coachName = array_key_exists('coach_name', $data) ? (trim($data['coach_name']) ?: null) : $draft['coach_name'];
        // Only update coach_pin if a new non-empty value is provided; hash it before storing
        $rawPin    = array_key_exists('coach_pin', $data) ? trim($data['coach_pin']) : null;
        if ($rawPin !== null) {
            $coachPin = $rawPin !== '' ? hashPin($rawPin) : null;
        } else {
            $coachPin = $draft['coach_pin'];
        }
        $coachMode = in_array($data['coach_mode'] ?? '', ['shared', 'team']) ? $data['coach_mode'] : ($draft['coach_mode'] ?? 'shared');

        $db->prepare('UPDATE drafts SET name=?, timer_minutes=?, auto_pick_enabled=?, coach_name=?, coach_pin=?, coach_mode=? WHERE id=?')
           ->execute([$name, $timer, $auto, $coachName, $coachPin, $coachMode, $draft['id']]);
        jsonResponse(fullState($db));

    } elseif ($action === 'setup_picks') {
        requireAdmin();
        $draft = getContextDraft($db);
        if (!$draft) jsonError('No draft selected');
        if ($draft['status'] === 'active') jsonError('Cannot rebuild pick order while draft is active');
        $teams = sortedTeams($db, $draft['id']);
        if (empty($teams)) jsonError('Add teams before setting up pick order');
        $pcStmt = $db->prepare('SELECT COUNT(*) FROM players WHERE draft_id=?');
        $pcStmt->execute([$draft['id']]);
        $playerCount = (int)$pcStmt->fetchColumn();
        if (!$playerCount) jsonError('Import players before setting up pick order');
        $totalRounds = (int)ceil($playerCount / count($teams));
        $db->prepare('UPDATE drafts SET total_rounds=? WHERE id=?')->execute([$totalRounds, $draft['id']]);
        buildPickSlots($db, $draft['id'], $totalRounds);
        $db->prepare("UPDATE drafts SET status='setup', current_pick_num=1, started_at=NULL, completed_at=NULL, timer_end=NULL WHERE id=?")
           ->execute([$draft['id']]);
        jsonResponse(fullState($db));

    } elseif ($action === 'delete') {
        requireAdmin();
        $data    = getInput();
        $draftId = (int)($data['id'] ?? 0);
        if (!$draftId) jsonError('id required');
        $chk = $db->prepare("SELECT status FROM drafts WHERE id=?");
        $chk->execute([$draftId]);
        $row = $chk->fetch();
        if (!$row) jsonError('Draft not found', 404);
        if ($row['status'] === 'active') jsonError('Cannot delete an active draft');
        $db->prepare('DELETE FROM drafts WHERE id=?')->execute([$draftId]);
        if (!empty($_SESSION['selected_draft_id']) && (int)$_SESSION['selected_draft_id'] === $draftId) {
            unset($_SESSION['selected_draft_id']);
        }
        jsonResponse(fullState($db));

    } elseif ($action === 'start') {
        requireAdmin();
        $draft = getContextDraft($db);
        if (!$draft) jsonError('No draft selected');
        if ($draft['status'] === 'active') jsonError('Draft already active');
        $pickCount = $db->prepare('SELECT COUNT(*) FROM picks WHERE draft_id=?');
        $pickCount->execute([$draft['id']]);
        if (!(int)$pickCount->fetchColumn()) jsonError('Set up pick order before starting');
        // Skip any pre-assigned picks at the start
        $firstPick = nextUnfilledPickNum($db, $draft['id'], 0);
        $db->prepare("UPDATE drafts SET status='active', current_pick_num=?, started_at=COALESCE(started_at, NOW()) WHERE id=?")
           ->execute([$firstPick, $draft['id']]);
        $draft['status'] = 'active';
        $draft['current_pick_num'] = $firstPick;
        advanceTimer($db, $draft);
        jsonResponse(['success' => true]);

    } elseif ($action === 'pause') {
        requireAdmin();
        $draft = getContextDraft($db);
        if (!$draft) jsonError('No draft found');
        if ($draft['status'] !== 'active') jsonError('Draft is not active');
        $remaining = null;
        if ($draft['timer_end']) {
            $now = new DateTime('now', new DateTimeZone('UTC'));
            $end = new DateTime($draft['timer_end'], new DateTimeZone('UTC'));
            $remaining = max(0, $end->getTimestamp() - $now->getTimestamp());
        }
        $db->prepare("UPDATE drafts SET status='paused', timer_end=NULL, timer_remaining_seconds=? WHERE id=?")
           ->execute([$remaining, $draft['id']]);
        jsonResponse(['success' => true]);

    } elseif ($action === 'resume') {
        requireAdmin();
        $draft = getContextDraft($db);
        if (!$draft) jsonError('No draft found');
        if ($draft['status'] !== 'paused') jsonError('Draft is not paused');
        $timerEnd = null;
        if ($draft['auto_pick_enabled'] && $draft['timer_remaining_seconds'] !== null) {
            $timerEnd = (new DateTime('now', new DateTimeZone('UTC')))
                ->modify('+' . $draft['timer_remaining_seconds'] . ' seconds')
                ->format('Y-m-d H:i:s');
        }
        $db->prepare("UPDATE drafts SET status='active', timer_end=?, timer_remaining_seconds=NULL WHERE id=?")
           ->execute([$timerEnd, $draft['id']]);
        jsonResponse(['success' => true]);

    } elseif ($action === 'end') {
        requireAdmin();
        $draft = getContextDraft($db);
        if (!$draft) jsonError('No draft found');
        $db->prepare("UPDATE drafts SET status='completed', completed_at=NOW(), timer_end=NULL WHERE id=?")
           ->execute([$draft['id']]);
        jsonResponse(['success' => true]);

    } elseif ($action === 'restart') {
        requireAdmin();
        $draft = getContextDraft($db);
        if (!$draft) jsonError('No draft selected');
        if ($draft['status'] === 'active') jsonError('Draft is already active');
        $pcStmt = $db->prepare('SELECT COUNT(*) FROM picks WHERE draft_id=?');
        $pcStmt->execute([$draft['id']]);
        if (!(int)$pcStmt->fetchColumn()) jsonError('No pick order set up');
        // Find first unfilled pick; if all filled restart from pick 1
        $stmt = $db->prepare('SELECT pick_num FROM picks WHERE draft_id=? AND player_id IS NULL ORDER BY pick_num ASC LIMIT 1');
        $stmt->execute([$draft['id']]);
        $firstUnfilled = $stmt->fetchColumn() ?: 1;
        $db->prepare("UPDATE drafts SET status='active', current_pick_num=?, completed_at=NULL, timer_end=NULL, timer_remaining_seconds=NULL WHERE id=?")
           ->execute([$firstUnfilled, $draft['id']]);
        $draft['status'] = 'active';
        $draft['current_pick_num'] = $firstUnfilled;
        advanceTimer($db, $draft);
        jsonResponse(fullState($db));

    } elseif ($action === 'reset_picks') {
        requireAdmin();
        $draft = getContextDraft($db);
        if (!$draft) jsonError('No draft selected');
        if ($draft['status'] === 'active') jsonError('Cannot reset picks while draft is active');
        $db->prepare('UPDATE picks SET player_id=NULL, is_pre_assigned=0, is_auto_pick=0, skipped=0, picked_at=NULL WHERE draft_id=?')
           ->execute([$draft['id']]);
        $db->prepare("UPDATE drafts SET status='setup', current_pick_num=1, started_at=NULL, completed_at=NULL, timer_end=NULL WHERE id=?")
           ->execute([$draft['id']]);
        jsonResponse(fullState($db));

    } elseif ($action === 'pick') {
        $role = currentRole();
        if ($role !== 'admin' && $role !== 'team') jsonError('Forbidden', 403);
        $data  = getInput();
        $draft = getContextDraft($db);
        if (!$draft) jsonError('No draft found');
        if (!in_array($draft['status'], ['active', 'completed'], true)) jsonError('Draft is not active');

        $playerId = (int)($data['player_id'] ?? 0);
        if (!$playerId) jsonError('player_id is required');
        $pickNum = (int)($data['pick_num'] ?? $draft['current_pick_num']);

        $pickStmt = $db->prepare('SELECT * FROM picks WHERE draft_id=? AND pick_num=?');
        $pickStmt->execute([$draft['id'], $pickNum]);
        $pick = $pickStmt->fetch();
        if (!$pick)             jsonError('Pick slot not found');
        if ($pick['player_id']) jsonError('Pick slot already filled');

        // Team role: verify this pick belongs to the logged-in team
        if ($role === 'team') {
            if ((int)$pick['team_id'] !== (int)($_SESSION['team_id'] ?? 0)) {
                jsonError('Not your pick', 403);
            }
        }

        $taken = $db->prepare('SELECT id FROM picks WHERE draft_id=? AND player_id=?');
        $taken->execute([$draft['id'], $playerId]);
        if ($taken->fetch()) jsonError('Player already drafted');

        $db->prepare('UPDATE picks SET player_id=?, is_auto_pick=0, is_pre_assigned=0, picked_at=NOW() WHERE draft_id=? AND pick_num=?')
           ->execute([$playerId, $draft['id'], $pickNum]);

        if ($draft['status'] === 'active') {
            $totalStmt = $db->prepare('SELECT COUNT(*) FROM picks WHERE draft_id=?');
            $totalStmt->execute([$draft['id']]);
            $total = (int)$totalStmt->fetchColumn();
            $next  = nextUnfilledPickNum($db, $draft['id'], $pickNum);

            // Also complete if no undrafted players remain (picks may outnumber players)
            $availStmt = $db->prepare(
                'SELECT COUNT(*) FROM players WHERE draft_id=? AND id NOT IN (SELECT player_id FROM picks WHERE draft_id=? AND player_id IS NOT NULL)'
            );
            $availStmt->execute([$draft['id'], $draft['id']]);
            $noPlayersLeft = (int)$availStmt->fetchColumn() === 0;

            if ($next > $total || $noPlayersLeft) {
                $db->prepare("UPDATE drafts SET status='completed', completed_at=NOW(), current_pick_num=?, timer_end=NULL WHERE id=?")
                   ->execute([$next, $draft['id']]);
            } else {
                $db->prepare('UPDATE drafts SET current_pick_num=? WHERE id=?')
                   ->execute([$next, $draft['id']]);
                $draft['current_pick_num'] = $next;
                advanceTimer($db, $draft);
            }
        }
        jsonResponse(['success' => true]);

    } elseif ($action === 'autopick') {
        requireAdmin();
        $draft = getContextDraft($db);
        if (!$draft) jsonError('No draft found');
        if ($draft['status'] !== 'active') jsonError('Draft is not active');

        $player = getNextAvailablePlayer($db, $draft['id']);
        if (!$player) {
            // All players drafted but pick slots remain — complete the draft
            $db->prepare("UPDATE drafts SET status='completed', completed_at=NOW(), timer_end=NULL WHERE id=?")
               ->execute([$draft['id']]);
            jsonResponse(['success' => true]);
        }

        $pickNum  = (int)$draft['current_pick_num'];
        $pickStmt = $db->prepare('SELECT * FROM picks WHERE draft_id=? AND pick_num=?');
        $pickStmt->execute([$draft['id'], $pickNum]);
        if (!$pickStmt->fetch()) jsonError('Pick slot not found');

        $db->prepare('UPDATE picks SET player_id=?, is_auto_pick=1, picked_at=NOW() WHERE draft_id=? AND pick_num=?')
           ->execute([$player['id'], $draft['id'], $pickNum]);

        $totalStmt = $db->prepare('SELECT COUNT(*) FROM picks WHERE draft_id=?');
        $totalStmt->execute([$draft['id']]);
        $total = (int)$totalStmt->fetchColumn();
        $next  = nextUnfilledPickNum($db, $draft['id'], $pickNum);

        // Complete if no undrafted players remain (picks may outnumber players)
        $availStmt2 = $db->prepare(
            'SELECT COUNT(*) FROM players WHERE draft_id=? AND id NOT IN (SELECT player_id FROM picks WHERE draft_id=? AND player_id IS NOT NULL)'
        );
        $availStmt2->execute([$draft['id'], $draft['id']]);
        $noPlayersLeft2 = (int)$availStmt2->fetchColumn() === 0;

        if ($next > $total || $noPlayersLeft2) {
            $db->prepare("UPDATE drafts SET status='completed', completed_at=NOW(), current_pick_num=?, timer_end=NULL WHERE id=?")
               ->execute([$next, $draft['id']]);
        } else {
            $db->prepare('UPDATE drafts SET current_pick_num=? WHERE id=?')
               ->execute([$next, $draft['id']]);
            $draft['current_pick_num'] = $next;
            advanceTimer($db, $draft);
        }

        $pickInfo = $db->prepare(
            'SELECT pk.*, t.name AS team_name FROM picks pk JOIN teams t ON pk.team_id=t.id WHERE pk.draft_id=? AND pk.pick_num=?'
        );
        $pickInfo->execute([$draft['id'], $pickNum]);
        jsonResponse(['success' => true, 'player' => $player, 'pick' => $pickInfo->fetch(), 'next_pick_num' => $next]);

    } elseif ($action === 'preassign') {
        requireAdmin();
        $data  = getInput();
        $draft = getContextDraft($db);
        if (!$draft) jsonError('No draft found');

        $pickNum  = (int)($data['pick_num']  ?? 0);
        $playerId = (int)($data['player_id'] ?? 0);
        if (!$pickNum || !$playerId) jsonError('pick_num and player_id required');

        if ($draft['status'] === 'active' && $pickNum <= (int)$draft['current_pick_num']) {
            jsonError('Cannot pre-assign a past or current pick');
        }

        $taken = $db->prepare('SELECT id FROM picks WHERE draft_id=? AND player_id=?');
        $taken->execute([$draft['id'], $playerId]);
        if ($taken->fetch()) jsonError('Player already assigned');

        $db->prepare('UPDATE picks SET player_id=?, is_pre_assigned=1, picked_at=NULL WHERE draft_id=? AND pick_num=?')
           ->execute([$playerId, $draft['id'], $pickNum]);
        jsonResponse(['success' => true]);

    } elseif ($action === 'force_assign') {
        requireAdmin();
        $data     = getInput();
        $draft    = getContextDraft($db);
        if (!$draft) jsonError('No draft found');
        $pickNum  = (int)($data['pick_num']  ?? 0);
        $playerId = (int)($data['player_id'] ?? 0);
        if (!$pickNum || !$playerId) jsonError('pick_num and player_id required');

        $pickStmt = $db->prepare('SELECT * FROM picks WHERE draft_id=? AND pick_num=?');
        $pickStmt->execute([$draft['id'], $pickNum]);
        if (!$pickStmt->fetch()) jsonError('Pick slot not found');

        $playerStmt = $db->prepare('SELECT id FROM players WHERE id=? AND draft_id=?');
        $playerStmt->execute([$playerId, $draft['id']]);
        if (!$playerStmt->fetch()) jsonError('Player not found');

        // Remove player from any other slot in this draft
        $db->prepare('UPDATE picks SET player_id=NULL, is_pre_assigned=0, is_auto_pick=0, picked_at=NULL WHERE draft_id=? AND player_id=? AND pick_num!=?')
           ->execute([$draft['id'], $playerId, $pickNum]);

        // Determine is_pre_assigned: 1 only for future slots while draft is active/paused
        $currentPickNum = (int)$draft['current_pick_num'];
        $isFuture       = $draft['status'] === 'setup'
                          || (in_array($draft['status'], ['active','paused'], true) && $pickNum > $currentPickNum);
        $isCurrentPick  = $draft['status'] === 'active' && $pickNum == $currentPickNum;
        $isPreAssigned  = $isFuture ? 1 : 0;

        $db->prepare('UPDATE picks SET player_id=?, is_pre_assigned=?, is_auto_pick=0, skipped=0, picked_at=NOW() WHERE draft_id=? AND pick_num=?')
           ->execute([$playerId, $isPreAssigned, $draft['id'], $pickNum]);

        // If assigned to the current active pick, advance to next unfilled
        if ($isCurrentPick) {
            $totalStmt = $db->prepare('SELECT COUNT(*) FROM picks WHERE draft_id=?');
            $totalStmt->execute([$draft['id']]);
            $total = (int)$totalStmt->fetchColumn();
            $next  = nextUnfilledPickNum($db, $draft['id'], $pickNum);
            if ($next > $total) {
                $db->prepare("UPDATE drafts SET status='completed', completed_at=NOW(), current_pick_num=?, timer_end=NULL WHERE id=?")
                   ->execute([$next, $draft['id']]);
            } else {
                $db->prepare('UPDATE drafts SET current_pick_num=? WHERE id=?')
                   ->execute([$next, $draft['id']]);
                $draft['current_pick_num'] = $next;
                advanceTimer($db, $draft);
            }
        }
        jsonResponse(['success' => true]);

    } elseif ($action === 'skip_pick') {
        requireAdmin();
        $draft = getContextDraft($db);
        if (!$draft) jsonError('No draft found');
        if ($draft['status'] !== 'active') jsonError('Draft is not active');
        $pickNum = (int)$draft['current_pick_num'];
        $db->prepare('UPDATE picks SET skipped=1 WHERE draft_id=? AND pick_num=?')
           ->execute([$draft['id'], $pickNum]);
        $totalStmt = $db->prepare('SELECT COUNT(*) FROM picks WHERE draft_id=?');
        $totalStmt->execute([$draft['id']]);
        $total = (int)$totalStmt->fetchColumn();
        $next  = nextUnfilledPickNum($db, $draft['id'], $pickNum);
        if ($next > $total) {
            $db->prepare("UPDATE drafts SET status='completed', completed_at=NOW(), current_pick_num=?, timer_end=NULL WHERE id=?")
               ->execute([$next, $draft['id']]);
        } else {
            $db->prepare('UPDATE drafts SET current_pick_num=? WHERE id=?')
               ->execute([$next, $draft['id']]);
            $draft['current_pick_num'] = $next;
            advanceTimer($db, $draft);
        }
        jsonResponse(fullState($db));

    } elseif ($action === 'toggle_skip') {
        requireAdmin();
        $data    = getInput();
        $draft   = getContextDraft($db);
        if (!$draft) jsonError('No draft found');
        if ($draft['status'] === 'completed' || $draft['archived']) jsonError('Draft is finished');
        $pickNum = (int)($data['pick_num'] ?? 0);
        if (!$pickNum) jsonError('pick_num required');
        // During active drafts, use skip_pick for the current slot — not toggle_skip
        if ($draft['status'] === 'active' && $pickNum == $draft['current_pick_num']) {
            jsonError('Use skip_pick to skip the current slot');
        }
        $pickStmt = $db->prepare('SELECT * FROM picks WHERE draft_id=? AND pick_num=?');
        $pickStmt->execute([$draft['id'], $pickNum]);
        $pick = $pickStmt->fetch();
        if (!$pick) jsonError('Pick slot not found');
        if ($pick['player_id']) jsonError('Cannot skip a slot that has a player assigned');
        $newVal = $pick['skipped'] ? 0 : 1;
        $db->prepare('UPDATE picks SET skipped=? WHERE draft_id=? AND pick_num=?')
           ->execute([$newVal, $draft['id'], $pickNum]);
        jsonResponse(fullState($db));

    } elseif ($action === 'undo_pick') {
        requireAdmin();
        $draft = getContextDraft($db);
        if (!$draft) jsonError('No draft found');

        // Find the most recently filled, non-pre-assigned pick
        $stmt = $db->prepare(
            'SELECT * FROM picks WHERE draft_id=? AND player_id IS NOT NULL
             ORDER BY pick_num DESC LIMIT 1'
        );
        $stmt->execute([$draft['id']]);
        $lastPick = $stmt->fetch();
        if (!$lastPick) jsonError('No picks to undo');

        // Clear the pick
        $db->prepare('UPDATE picks SET player_id=NULL, is_auto_pick=0, is_pre_assigned=0, picked_at=NULL WHERE id=?')
           ->execute([$lastPick['id']]);

        // Restore draft state: go back to this pick_num, reactivate if completed
        $newStatus = ($draft['status'] === 'completed') ? 'active' : $draft['status'];
        $db->prepare(
            "UPDATE drafts SET current_pick_num=?, status=?, completed_at=IF(?='completed',completed_at,NULL), timer_end=NULL, timer_remaining_seconds=NULL WHERE id=?"
        )->execute([$lastPick['pick_num'], $newStatus, $draft['status'], $draft['id']]);

        if ($newStatus === 'active') {
            $draft['status']           = 'active';
            $draft['current_pick_num'] = $lastPick['pick_num'];
            advanceTimer($db, $draft);
        }

        jsonResponse(fullState($db));

    } elseif ($action === 'clear_pick') {
        requireAdmin();
        $data    = getInput();
        $draft   = getContextDraft($db);
        if (!$draft) jsonError('No draft found');
        $pickNum = (int)($data['pick_num'] ?? 0);
        if (!$pickNum) jsonError('pick_num required');
        $db->prepare('UPDATE picks SET player_id=NULL, is_pre_assigned=0, is_auto_pick=0, picked_at=NULL WHERE draft_id=? AND pick_num=?')
           ->execute([$draft['id'], $pickNum]);
        if ($draft['status'] === 'completed') {
            $db->prepare("UPDATE drafts SET status='paused', completed_at=NULL, current_pick_num=? WHERE id=?")
               ->execute([$pickNum, $draft['id']]);
        }
        jsonResponse(['success' => true]);

    } else {
        jsonError('Unknown action', 404);
    }

} catch (PDOException $e) {
    error_log('EasyDraft drafts error: ' . $e->getMessage());
    jsonError('A server error occurred', 500);
}
