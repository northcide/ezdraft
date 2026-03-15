<?php
require_once __DIR__ . '/helpers.php';

$action = getAction();
$method = $_SERVER['REQUEST_METHOD'];

try {
    $db = getDB();

    // ── helpers ──────────────────────────────────────────────────────────────

    function getActiveDraft(PDO $db): ?array {
        $stmt = $db->query("SELECT * FROM drafts ORDER BY id DESC LIMIT 1");
        return $stmt->fetch() ?: null;
    }

    /**
     * Calculate which team picks at pick_num (1-indexed) in a snake draft.
     * Teams array must be sorted by draft_order ascending.
     */
    function snakeTeamForPick(array $teams, int $pickNum): array {
        $n = count($teams);
        if ($n === 0) return [];
        $round = (int)ceil($pickNum / $n);
        $pos = ($pickNum - 1) % $n; // 0-indexed
        if ($round % 2 === 0) {
            $pos = ($n - 1) - $pos; // reverse for even rounds
        }
        return $teams[$pos];
    }

    function buildPickSlots(PDO $db, int $draftId, int $totalRounds): void {
        $teamStmt = $db->query('SELECT * FROM teams ORDER BY draft_order ASC');
        $teams = $teamStmt->fetchAll();
        $n = count($teams);
        if ($n === 0) return;

        $total = $n * $totalRounds;
        $insert = $db->prepare(
            'INSERT IGNORE INTO picks (draft_id, round, pick_num, team_id) VALUES (?, ?, ?, ?)'
        );
        for ($p = 1; $p <= $total; $p++) {
            $round = (int)ceil($p / $n);
            $team = snakeTeamForPick($teams, $p);
            $insert->execute([$draftId, $round, $p, $team['id']]);
        }
    }

    function getDraftState(PDO $db): array {
        $draft = getActiveDraft($db);
        if (!$draft) {
            return ['draft' => null, 'picks' => [], 'teams' => [], 'players' => []];
        }

        $picks = $db->prepare(
            'SELECT pk.*, p.name AS player_name, p.rank AS player_rank, p.position AS player_position,
                    t.name AS team_name
             FROM picks pk
             LEFT JOIN players p ON pk.player_id = p.id
             JOIN teams t ON pk.team_id = t.id
             WHERE pk.draft_id = ?
             ORDER BY pk.pick_num ASC'
        );
        $picks->execute([$draft['id']]);

        $teams = $db->query('SELECT * FROM teams ORDER BY draft_order ASC')->fetchAll();

        $players = $db->query(
            'SELECT p.*, ' .
            '(SELECT pk2.pick_num FROM picks pk2 WHERE pk2.player_id = p.id LIMIT 1) AS pick_num ' .
            'FROM players p ORDER BY p.`rank` ASC'
        )->fetchAll();

        // Compute server time for timer sync
        $serverTime = (new DateTime('now', new DateTimeZone('UTC')))->format('c');

        return [
            'draft'      => $draft,
            'picks'      => $picks->fetchAll(),
            'teams'      => $teams,
            'players'    => $players,
            'serverTime' => $serverTime,
        ];
    }

    function advanceTimer(PDO $db, array $draft): void {
        if ($draft['status'] !== 'active') return;
        if (!$draft['auto_pick_enabled']) {
            // No timer end needed; just clear it
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
            'SELECT p.* FROM players p
             WHERE p.id NOT IN (
                 SELECT pk.player_id FROM picks pk
                 WHERE pk.draft_id = ? AND pk.player_id IS NOT NULL
             )
             ORDER BY p.`rank` ASC LIMIT 1'
        );
        $stmt->execute([$draftId]);
        return $stmt->fetch() ?: null;
    }

    // ── routing ───────────────────────────────────────────────────────────────

    if ($method === 'GET' && $action === 'state') {
        $state = getDraftState($db);
        // Re-run picks fetch (getDraftState already does it but result not in $state)
        $draft = $state['draft'];
        if ($draft) {
            $picks = $db->prepare(
                'SELECT pk.*, p.name AS player_name, p.rank AS player_rank, p.position AS player_position,
                        t.name AS team_name
                 FROM picks pk
                 LEFT JOIN players p ON pk.player_id = p.id
                 JOIN teams t ON pk.team_id = t.id
                 WHERE pk.draft_id = ?
                 ORDER BY pk.pick_num ASC'
            );
            $picks->execute([$draft['id']]);
            $state['picks'] = $picks->fetchAll();
        }
        $state['serverTime'] = (new DateTime('now', new DateTimeZone('UTC')))->format('c');
        jsonResponse($state);

    } elseif ($method === 'POST' && $action === 'create') {
        $data = getInput();
        if (empty($data['total_rounds'])) jsonError('total_rounds is required');

        // Check teams exist
        $teamCount = (int)$db->query('SELECT COUNT(*) FROM teams')->fetchColumn();
        if ($teamCount === 0) jsonError('Add teams before creating a draft');

        // Delete any existing draft
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

        $stmt = $db->prepare('SELECT * FROM drafts WHERE id = ?');
        $stmt->execute([$draftId]);
        jsonResponse($stmt->fetch(), 201);

    } elseif ($method === 'POST' && $action === 'start') {
        $draft = getActiveDraft($db);
        if (!$draft) jsonError('No draft found');
        if ($draft['status'] === 'active') jsonError('Draft already active');

        $db->prepare("UPDATE drafts SET status='active' WHERE id=?")->execute([$draft['id']]);
        $draft['status'] = 'active';
        advanceTimer($db, $draft);
        jsonResponse(['success' => true]);

    } elseif ($method === 'POST' && $action === 'pause') {
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

    } elseif ($method === 'POST' && $action === 'resume') {
        $draft = getActiveDraft($db);
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

    } elseif ($method === 'POST' && $action === 'end') {
        $draft = getActiveDraft($db);
        if (!$draft) jsonError('No draft found');
        $db->prepare("UPDATE drafts SET status='completed', timer_end=NULL WHERE id=?")
           ->execute([$draft['id']]);
        jsonResponse(['success' => true]);

    } elseif ($method === 'POST' && $action === 'reset') {
        $db->exec('DELETE FROM drafts');
        jsonResponse(['success' => true]);

    } elseif ($method === 'POST' && $action === 'pick') {
        $data = getInput();
        $draft = getActiveDraft($db);
        if (!$draft) jsonError('No draft found');
        if ($draft['status'] !== 'active') jsonError('Draft is not active');

        $playerId = (int)($data['player_id'] ?? 0);
        if (!$playerId) jsonError('player_id is required');

        $pickNum = (int)($data['pick_num'] ?? $draft['current_pick_num']);

        // Validate pick slot
        $pickStmt = $db->prepare('SELECT * FROM picks WHERE draft_id=? AND pick_num=?');
        $pickStmt->execute([$draft['id'], $pickNum]);
        $pick = $pickStmt->fetch();
        if (!$pick) jsonError('Pick slot not found');
        if ($pick['player_id']) jsonError('Pick slot already filled');

        // Validate player not already drafted
        $taken = $db->prepare('SELECT id FROM picks WHERE draft_id=? AND player_id=?');
        $taken->execute([$draft['id'], $playerId]);
        if ($taken->fetch()) jsonError('Player already drafted');

        // Make the pick
        $db->prepare(
            'UPDATE picks SET player_id=?, is_auto_pick=0, picked_at=NOW() WHERE draft_id=? AND pick_num=?'
        )->execute([$playerId, $draft['id'], $pickNum]);

        // Advance to next empty pick
        $nextPick = $pickNum + 1;
        $totalPicks = $db->prepare('SELECT COUNT(*) FROM picks WHERE draft_id=?');
        $totalPicks->execute([$draft['id']]);
        $total = (int)$totalPicks->fetchColumn();

        // Find next unfilled pick
        while ($nextPick <= $total) {
            $check = $db->prepare('SELECT player_id FROM picks WHERE draft_id=? AND pick_num=?');
            $check->execute([$draft['id'], $nextPick]);
            $row = $check->fetch();
            if ($row && $row['player_id'] === null) break;
            $nextPick++;
        }

        if ($nextPick > $total) {
            // Draft complete
            $db->prepare("UPDATE drafts SET status='completed', current_pick_num=?, timer_end=NULL WHERE id=?")
               ->execute([$nextPick, $draft['id']]);
        } else {
            $db->prepare('UPDATE drafts SET current_pick_num=? WHERE id=?')
               ->execute([$nextPick, $draft['id']]);
            $draft['current_pick_num'] = $nextPick;
            advanceTimer($db, $draft);
        }

        jsonResponse(['success' => true, 'next_pick_num' => $nextPick]);

    } elseif ($method === 'POST' && $action === 'autopick') {
        $draft = getActiveDraft($db);
        if (!$draft) jsonError('No draft found');
        if ($draft['status'] !== 'active') jsonError('Draft is not active');

        $player = getNextAvailablePlayer($db, $draft['id']);
        if (!$player) jsonError('No available players');

        $pickNum = (int)$draft['current_pick_num'];
        $pick = $db->prepare('SELECT * FROM picks WHERE draft_id=? AND pick_num=?');
        $pick->execute([$draft['id'], $pickNum]);
        if (!$pick->fetch()) jsonError('Pick slot not found');

        $db->prepare(
            'UPDATE picks SET player_id=?, is_auto_pick=1, picked_at=NOW() WHERE draft_id=? AND pick_num=?'
        )->execute([$player['id'], $draft['id'], $pickNum]);

        // Advance
        $nextPick = $pickNum + 1;
        $totalPicks = (int)$db->prepare('SELECT COUNT(*) FROM picks WHERE draft_id=?')
            ->execute([$draft['id']]) ? $db->query("SELECT COUNT(*) FROM picks WHERE draft_id={$draft['id']}")->fetchColumn() : 0;

        $total = (int)$db->prepare('SELECT COUNT(*) FROM picks WHERE draft_id=?')
                         ->execute([$draft['id']]);
        $totalStmt = $db->prepare('SELECT COUNT(*) FROM picks WHERE draft_id=?');
        $totalStmt->execute([$draft['id']]);
        $total = (int)$totalStmt->fetchColumn();

        while ($nextPick <= $total) {
            $check = $db->prepare('SELECT player_id FROM picks WHERE draft_id=? AND pick_num=?');
            $check->execute([$draft['id'], $nextPick]);
            $row = $check->fetch();
            if ($row && $row['player_id'] === null) break;
            $nextPick++;
        }

        if ($nextPick > $total) {
            $db->prepare("UPDATE drafts SET status='completed', current_pick_num=?, timer_end=NULL WHERE id=?")
               ->execute([$nextPick, $draft['id']]);
        } else {
            $db->prepare('UPDATE drafts SET current_pick_num=? WHERE id=?')
               ->execute([$nextPick, $draft['id']]);
            $draft['current_pick_num'] = $nextPick;
            advanceTimer($db, $draft);
        }

        jsonResponse(['success' => true, 'player' => $player, 'next_pick_num' => $nextPick]);

    } elseif ($method === 'POST' && $action === 'preassign') {
        $data = getInput();
        $draft = getActiveDraft($db);
        if (!$draft) jsonError('No draft found');
        if ($draft['status'] === 'completed') jsonError('Draft is completed');

        $pickNum  = (int)($data['pick_num'] ?? 0);
        $playerId = (int)($data['player_id'] ?? 0);
        if (!$pickNum || !$playerId) jsonError('pick_num and player_id required');

        // Can only pre-assign future picks
        if ($pickNum < $draft['current_pick_num'] && $draft['status'] === 'active') {
            jsonError('Cannot pre-assign a past or current pick');
        }

        // Validate player not already assigned anywhere in this draft
        $taken = $db->prepare('SELECT id FROM picks WHERE draft_id=? AND player_id=?');
        $taken->execute([$draft['id'], $playerId]);
        if ($taken->fetch()) jsonError('Player already assigned');

        $db->prepare(
            'UPDATE picks SET player_id=?, is_pre_assigned=1, picked_at=NULL WHERE draft_id=? AND pick_num=?'
        )->execute([$playerId, $draft['id'], $pickNum]);
        jsonResponse(['success' => true]);

    } elseif ($method === 'POST' && $action === 'clear_pick') {
        $data = getInput();
        $draft = getActiveDraft($db);
        if (!$draft) jsonError('No draft found');

        $pickNum = (int)($data['pick_num'] ?? 0);
        if (!$pickNum) jsonError('pick_num required');

        $db->prepare(
            'UPDATE picks SET player_id=NULL, is_pre_assigned=0, is_auto_pick=0, picked_at=NULL WHERE draft_id=? AND pick_num=?'
        )->execute([$draft['id'], $pickNum]);
        jsonResponse(['success' => true]);

    } elseif ($method === 'POST' && $action === 'update_settings') {
        $data = getInput();
        $draft = getActiveDraft($db);
        if (!$draft) jsonError('No draft found');
        if ($draft['status'] === 'active') jsonError('Cannot change settings while draft is active');

        $db->prepare(
            'UPDATE drafts SET timer_minutes=?, auto_pick_enabled=? WHERE id=?'
        )->execute([
            (int)($data['timer_minutes'] ?? $draft['timer_minutes']),
            (int)($data['auto_pick_enabled'] ?? $draft['auto_pick_enabled']),
            $draft['id'],
        ]);
        jsonResponse(['success' => true]);

    } else {
        jsonError('Unknown action', 404);
    }

} catch (PDOException $e) {
    jsonError('Database error: ' . $e->getMessage(), 500);
}
