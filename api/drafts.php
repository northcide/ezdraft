<?php
require_once __DIR__ . '/helpers.php';
requireAuth();

$action = getAction();

try {
    $db = getDB();

    // ── helpers ───────────────────────────────────────────────────────────────

    function getActiveDraft(PDO $db): ?array {
        return $db->query('SELECT * FROM drafts ORDER BY id DESC LIMIT 1')->fetch() ?: null;
    }

    function sortedTeams(PDO $db): array {
        return $db->query('SELECT * FROM teams ORDER BY draft_order ASC')->fetchAll();
    }

    function snakeTeamForPick(array $teams, int $pickNum): array {
        $n     = count($teams);
        $round = (int)ceil($pickNum / $n);
        $pos   = ($pickNum - 1) % $n;
        if ($round % 2 === 0) $pos = ($n - 1) - $pos;
        return $teams[$pos];
    }

    function buildPickSlots(PDO $db, int $draftId, int $totalRounds): void {
        $teams = sortedTeams($db);
        $n     = count($teams);
        if ($n === 0) return;
        $stmt  = $db->prepare(
            'INSERT IGNORE INTO picks (draft_id, round, pick_num, team_id) VALUES (?,?,?,?)'
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
            ->format('Y-m-d\TH:i:s\Z');
        $db->prepare('UPDATE drafts SET timer_end=?, timer_remaining_seconds=NULL WHERE id=?')
           ->execute([$end, $draft['id']]);
    }

    function getNextAvailablePlayer(PDO $db, int $draftId): ?array {
        $stmt = $db->prepare(
            'SELECT * FROM players
             WHERE id NOT IN (SELECT player_id FROM picks WHERE draft_id=? AND player_id IS NOT NULL)
             ORDER BY `rank` ASC LIMIT 1'
        );
        $stmt->execute([$draftId]);
        return $stmt->fetch() ?: null;
    }

    function nextUnfilledPickNum(PDO $db, int $draftId, int $afterPickNum): int {
        $total = (int)$db->prepare('SELECT COUNT(*) FROM picks WHERE draft_id=?')
                         ->execute([$draftId]) ? $db->query("SELECT COUNT(*) FROM picks WHERE draft_id=$draftId")->fetchColumn() : 0;
        $totalStmt = $db->prepare('SELECT COUNT(*) FROM picks WHERE draft_id=?');
        $totalStmt->execute([$draftId]);
        $total = (int)$totalStmt->fetchColumn();

        $stmt  = $db->prepare('SELECT player_id FROM picks WHERE draft_id=? AND pick_num=?');
        $next  = $afterPickNum + 1;
        while ($next <= $total) {
            $stmt->execute([$draftId, $next]);
            $row = $stmt->fetch();
            if ($row && $row['player_id'] === null) break;
            $next++;
        }
        return $next;
    }

    function fullState(PDO $db): array {
        $draft = getActiveDraft($db);

        $picks = [];
        if ($draft) {
            $stmt = $db->prepare(
                'SELECT pk.*, p.name AS player_name, p.rank AS player_rank, p.position AS player_position,
                        t.name AS team_name
                 FROM picks pk
                 LEFT JOIN players p ON pk.player_id = p.id
                 JOIN  teams t ON pk.team_id = t.id
                 WHERE pk.draft_id = ?
                 ORDER BY pk.pick_num ASC'
            );
            $stmt->execute([$draft['id']]);
            $picks = $stmt->fetchAll();
        }

        $teams   = sortedTeams($db);
        $players = $db->query('SELECT * FROM players ORDER BY `rank` ASC')->fetchAll();
        $role    = currentRole();

        return [
            'draft'      => $draft,
            'picks'      => $picks,
            'teams'      => $teams,
            'players'    => $players,
            'role'       => $role,
            'serverTime' => (new DateTime('now', new DateTimeZone('UTC')))->format('c'),
        ];
    }

    // ── routing ───────────────────────────────────────────────────────────────

    if ($action === 'state') {
        jsonResponse(fullState($db));

    } elseif ($action === 'create') {
        requireAdmin();
        $data = getInput();
        if (empty($data['total_rounds'])) jsonError('total_rounds is required');
        if (!(int)$db->query('SELECT COUNT(*) FROM teams')->fetchColumn()) {
            jsonError('Add teams before creating a draft');
        }
        $db->exec('DELETE FROM drafts');
        $stmt = $db->prepare(
            'INSERT INTO drafts (status, total_rounds, timer_minutes, auto_pick_enabled, current_pick_num)
             VALUES ("setup", ?, ?, ?, 1)'
        );
        $stmt->execute([
            (int)$data['total_rounds'],
            (int)($data['timer_minutes'] ?? 2),
            (int)($data['auto_pick_enabled'] ?? 1),
        ]);
        $draftId = (int)$db->lastInsertId();
        buildPickSlots($db, $draftId, (int)$data['total_rounds']);
        $stmt = $db->prepare('SELECT * FROM drafts WHERE id=?');
        $stmt->execute([$draftId]);
        jsonResponse($stmt->fetch(), 201);

    } elseif ($action === 'start') {
        requireAdmin();
        $draft = getActiveDraft($db);
        if (!$draft) jsonError('No draft found');
        if ($draft['status'] === 'active') jsonError('Draft already active');
        $db->prepare("UPDATE drafts SET status='active' WHERE id=?")->execute([$draft['id']]);
        $draft['status'] = 'active';
        advanceTimer($db, $draft);
        jsonResponse(['success' => true]);

    } elseif ($action === 'pause') {
        requireAdmin();
        $draft = getActiveDraft($db);
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
        $draft = getActiveDraft($db);
        if (!$draft) jsonError('No draft found');
        if ($draft['status'] !== 'paused') jsonError('Draft is not paused');
        $timerEnd = null;
        if ($draft['auto_pick_enabled'] && $draft['timer_remaining_seconds'] !== null) {
            $timerEnd = (new DateTime('now', new DateTimeZone('UTC')))
                ->modify('+' . $draft['timer_remaining_seconds'] . ' seconds')
                ->format('Y-m-d\TH:i:s\Z');
        }
        $db->prepare("UPDATE drafts SET status='active', timer_end=?, timer_remaining_seconds=NULL WHERE id=?")
           ->execute([$timerEnd, $draft['id']]);
        jsonResponse(['success' => true]);

    } elseif ($action === 'end') {
        requireAdmin();
        $draft = getActiveDraft($db);
        if (!$draft) jsonError('No draft found');
        $db->prepare("UPDATE drafts SET status='completed', timer_end=NULL WHERE id=?")
           ->execute([$draft['id']]);
        jsonResponse(['success' => true]);

    } elseif ($action === 'reset') {
        requireAdmin();
        $db->exec('DELETE FROM drafts');
        jsonResponse(['success' => true]);

    } elseif ($action === 'pick') {
        requireAdmin();
        $data  = getInput();
        $draft = getActiveDraft($db);
        if (!$draft) jsonError('No draft found');
        if ($draft['status'] !== 'active') jsonError('Draft is not active');

        $playerId = (int)($data['player_id'] ?? 0);
        if (!$playerId) jsonError('player_id is required');
        $pickNum = (int)($data['pick_num'] ?? $draft['current_pick_num']);

        $pickStmt = $db->prepare('SELECT * FROM picks WHERE draft_id=? AND pick_num=?');
        $pickStmt->execute([$draft['id'], $pickNum]);
        $pick = $pickStmt->fetch();
        if (!$pick)               jsonError('Pick slot not found');
        if ($pick['player_id'])   jsonError('Pick slot already filled');

        $taken = $db->prepare('SELECT id FROM picks WHERE draft_id=? AND player_id=?');
        $taken->execute([$draft['id'], $playerId]);
        if ($taken->fetch()) jsonError('Player already drafted');

        $db->prepare('UPDATE picks SET player_id=?, is_auto_pick=0, picked_at=NOW() WHERE draft_id=? AND pick_num=?')
           ->execute([$playerId, $draft['id'], $pickNum]);

        $next  = nextUnfilledPickNum($db, $draft['id'], $pickNum);
        $total = (int)$db->prepare('SELECT COUNT(*) FROM picks WHERE draft_id=?')
                         ->execute([$draft['id']]);
        $totalStmt = $db->prepare('SELECT COUNT(*) FROM picks WHERE draft_id=?');
        $totalStmt->execute([$draft['id']]);
        $total = (int)$totalStmt->fetchColumn();

        if ($next > $total) {
            $db->prepare("UPDATE drafts SET status='completed', current_pick_num=?, timer_end=NULL WHERE id=?")
               ->execute([$next, $draft['id']]);
        } else {
            $db->prepare('UPDATE drafts SET current_pick_num=? WHERE id=?')
               ->execute([$next, $draft['id']]);
            $draft['current_pick_num'] = $next;
            advanceTimer($db, $draft);
        }
        jsonResponse(['success' => true, 'next_pick_num' => $next]);

    } elseif ($action === 'autopick') {
        requireAdmin();
        $draft = getActiveDraft($db);
        if (!$draft) jsonError('No draft found');
        if ($draft['status'] !== 'active') jsonError('Draft is not active');

        $player = getNextAvailablePlayer($db, $draft['id']);
        if (!$player) jsonError('No available players');

        $pickNum = (int)$draft['current_pick_num'];
        $pickStmt = $db->prepare('SELECT * FROM picks WHERE draft_id=? AND pick_num=?');
        $pickStmt->execute([$draft['id'], $pickNum]);
        if (!$pickStmt->fetch()) jsonError('Pick slot not found');

        $db->prepare('UPDATE picks SET player_id=?, is_auto_pick=1, picked_at=NOW() WHERE draft_id=? AND pick_num=?')
           ->execute([$player['id'], $draft['id'], $pickNum]);

        $totalStmt = $db->prepare('SELECT COUNT(*) FROM picks WHERE draft_id=?');
        $totalStmt->execute([$draft['id']]);
        $total = (int)$totalStmt->fetchColumn();
        $next  = nextUnfilledPickNum($db, $draft['id'], $pickNum);

        if ($next > $total) {
            $db->prepare("UPDATE drafts SET status='completed', current_pick_num=?, timer_end=NULL WHERE id=?")
               ->execute([$next, $draft['id']]);
        } else {
            $db->prepare('UPDATE drafts SET current_pick_num=? WHERE id=?')
               ->execute([$next, $draft['id']]);
            $draft['current_pick_num'] = $next;
            advanceTimer($db, $draft);
        }

        // Fetch pick info for announcement
        $pickInfo = $db->prepare(
            'SELECT pk.*, t.name AS team_name FROM picks pk JOIN teams t ON pk.team_id=t.id WHERE pk.draft_id=? AND pk.pick_num=?'
        );
        $pickInfo->execute([$draft['id'], $pickNum]);
        jsonResponse(['success' => true, 'player' => $player, 'pick' => $pickInfo->fetch(), 'next_pick_num' => $next]);

    } elseif ($action === 'preassign') {
        requireAdmin();
        $data  = getInput();
        $draft = getActiveDraft($db);
        if (!$draft) jsonError('No draft found');
        if ($draft['status'] === 'completed') jsonError('Draft is completed');

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

    } elseif ($action === 'clear_pick') {
        requireAdmin();
        $data  = getInput();
        $draft = getActiveDraft($db);
        if (!$draft) jsonError('No draft found');
        $pickNum = (int)($data['pick_num'] ?? 0);
        if (!$pickNum) jsonError('pick_num required');
        $db->prepare('UPDATE picks SET player_id=NULL, is_pre_assigned=0, is_auto_pick=0, picked_at=NULL WHERE draft_id=? AND pick_num=?')
           ->execute([$draft['id'], $pickNum]);
        jsonResponse(['success' => true]);

    } else {
        jsonError('Unknown action', 404);
    }

} catch (PDOException $e) {
    jsonError('Database error: ' . $e->getMessage(), 500);
}
