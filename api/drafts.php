<?php
require_once __DIR__ . '/helpers.php';

$action = getAction();

try {
    $db = dbLoad();

    // ── helpers ───────────────────────────────────────────────────────────────

    function sortedTeams(array $db): array {
        $teams = $db['teams'];
        usort($teams, fn($a, $b) => $a['draft_order'] <=> $b['draft_order']);
        return $teams;
    }

    function snakeTeamForPick(array $teams, int $pickNum): array {
        $n = count($teams);
        $round = (int)ceil($pickNum / $n);
        $pos   = ($pickNum - 1) % $n;
        if ($round % 2 === 0) $pos = ($n - 1) - $pos;
        return $teams[$pos];
    }

    function buildPickSlots(array &$db, int $draftId, int $totalRounds): void {
        $teams = sortedTeams($db);
        $n     = count($teams);
        if ($n === 0) return;
        $total = $n * $totalRounds;
        for ($p = 1; $p <= $total; $p++) {
            $round = (int)ceil($p / $n);
            $team  = snakeTeamForPick($teams, $p);
            $db['picks'][] = [
                'id'            => nextId($db['picks']),
                'draft_id'      => $draftId,
                'round'         => $round,
                'pick_num'      => $p,
                'team_id'       => $team['id'],
                'player_id'     => null,
                'is_pre_assigned'=> 0,
                'is_auto_pick'  => 0,
                'picked_at'     => null,
                'created_at'    => nowUtc(),
            ];
        }
    }

    function getDraftPicks(array $db): array {
        $draft = $db['draft'];
        if (!$draft) return [];
        $picks  = array_filter($db['picks'], fn($p) => $p['draft_id'] === $draft['id']);
        $picks  = array_values($picks);
        usort($picks, fn($a, $b) => $a['pick_num'] <=> $b['pick_num']);

        $teamMap   = array_column($db['teams'], null, 'id');
        $playerMap = array_column($db['players'], null, 'id');

        foreach ($picks as &$pick) {
            $team = $teamMap[$pick['team_id']] ?? null;
            $pick['team_name'] = $team['name'] ?? '';
            if ($pick['player_id']) {
                $player = $playerMap[$pick['player_id']] ?? null;
                $pick['player_name']     = $player['name'] ?? '';
                $pick['player_rank']     = $player['rank'] ?? null;
                $pick['player_position'] = $player['position'] ?? null;
            } else {
                $pick['player_name']     = null;
                $pick['player_rank']     = null;
                $pick['player_position'] = null;
            }
        }
        unset($pick);
        return $picks;
    }

    function advanceTimer(array &$db): void {
        $draft = &$db['draft'];
        if (!$draft || $draft['status'] !== 'active') return;
        if (!$draft['auto_pick_enabled']) {
            $draft['timer_end'] = null;
            $draft['timer_remaining_seconds'] = null;
            return;
        }
        $end = (new DateTime('now', new DateTimeZone('UTC')))
            ->modify('+' . $draft['timer_minutes'] . ' minutes')
            ->format('Y-m-d H:i:s');
        $draft['timer_end'] = $end;
        $draft['timer_remaining_seconds'] = null;
    }

    function nextUnfilledPick(array $db, int $afterPickNum): int {
        $draft = $db['draft'];
        $total = count(array_filter($db['picks'], fn($p) => $p['draft_id'] === $draft['id']));
        $next  = $afterPickNum + 1;
        while ($next <= $total) {
            foreach ($db['picks'] as $p) {
                if ($p['draft_id'] === $draft['id'] && $p['pick_num'] === $next && $p['player_id'] === null) {
                    return $next;
                }
            }
            $next++;
        }
        return $next; // beyond total = draft complete
    }

    function getNextAvailablePlayer(array $db): ?array {
        $draft = $db['draft'];
        $draftedIds = array_filter(
            array_column(
                array_filter($db['picks'], fn($p) => $p['draft_id'] === $draft['id'] && $p['player_id'] !== null),
                'player_id'
            )
        );
        $available = array_filter($db['players'], fn($p) => !in_array($p['id'], $draftedIds, true));
        if (empty($available)) return null;
        usort($available, fn($a, $b) => $a['rank'] <=> $b['rank']);
        return reset($available);
    }

    function fullState(array $db): array {
        $teams = sortedTeams($db);
        usort($db['players'], fn($a, $b) => $a['rank'] <=> $b['rank']);
        return [
            'draft'      => $db['draft'],
            'picks'      => getDraftPicks($db),
            'teams'      => $teams,
            'players'    => $db['players'],
            'serverTime' => (new DateTime('now', new DateTimeZone('UTC')))->format('c'),
        ];
    }

    // ── routing ───────────────────────────────────────────────────────────────

    if ($action === 'state') {
        jsonResponse(fullState($db));

    } elseif ($action === 'create') {
        $data = getInput();
        if (empty($data['total_rounds'])) jsonError('total_rounds is required');
        if (empty($db['teams'])) jsonError('Add teams before creating a draft');

        // Reset draft + picks
        $db['draft'] = null;
        $db['picks'] = [];

        $draft = [
            'id'                     => 1,
            'status'                 => 'setup',
            'total_rounds'           => (int)$data['total_rounds'],
            'timer_minutes'          => (int)($data['timer_minutes'] ?? 2),
            'auto_pick_enabled'      => (int)($data['auto_pick_enabled'] ?? 1),
            'current_pick_num'       => 1,
            'timer_end'              => null,
            'timer_remaining_seconds'=> null,
            'created_at'             => nowUtc(),
            'updated_at'             => nowUtc(),
        ];
        $db['draft'] = $draft;
        buildPickSlots($db, 1, (int)$data['total_rounds']);
        dbSave($db);
        jsonResponse($draft, 201);

    } elseif ($action === 'start') {
        if (!$db['draft']) jsonError('No draft found');
        if ($db['draft']['status'] === 'active') jsonError('Draft already active');
        $db['draft']['status'] = 'active';
        $db['draft']['updated_at'] = nowUtc();
        advanceTimer($db);
        dbSave($db);
        jsonResponse(['success' => true]);

    } elseif ($action === 'pause') {
        if (!$db['draft']) jsonError('No draft found');
        if ($db['draft']['status'] !== 'active') jsonError('Draft is not active');
        $remaining = null;
        if ($db['draft']['timer_end']) {
            $now = new DateTime('now', new DateTimeZone('UTC'));
            $end = new DateTime($db['draft']['timer_end'], new DateTimeZone('UTC'));
            $remaining = max(0, $end->getTimestamp() - $now->getTimestamp());
        }
        $db['draft']['status'] = 'paused';
        $db['draft']['timer_end'] = null;
        $db['draft']['timer_remaining_seconds'] = $remaining;
        $db['draft']['updated_at'] = nowUtc();
        dbSave($db);
        jsonResponse(['success' => true]);

    } elseif ($action === 'resume') {
        if (!$db['draft']) jsonError('No draft found');
        if ($db['draft']['status'] !== 'paused') jsonError('Draft is not paused');
        $timerEnd = null;
        if ($db['draft']['auto_pick_enabled'] && $db['draft']['timer_remaining_seconds'] !== null) {
            $timerEnd = (new DateTime('now', new DateTimeZone('UTC')))
                ->modify('+' . $db['draft']['timer_remaining_seconds'] . ' seconds')
                ->format('Y-m-d H:i:s');
        }
        $db['draft']['status'] = 'active';
        $db['draft']['timer_end'] = $timerEnd;
        $db['draft']['timer_remaining_seconds'] = null;
        $db['draft']['updated_at'] = nowUtc();
        dbSave($db);
        jsonResponse(['success' => true]);

    } elseif ($action === 'end') {
        if (!$db['draft']) jsonError('No draft found');
        $db['draft']['status'] = 'completed';
        $db['draft']['timer_end'] = null;
        $db['draft']['updated_at'] = nowUtc();
        dbSave($db);
        jsonResponse(['success' => true]);

    } elseif ($action === 'reset') {
        $db['draft'] = null;
        $db['picks'] = [];
        dbSave($db);
        jsonResponse(['success' => true]);

    } elseif ($action === 'pick') {
        $data = getInput();
        if (!$db['draft']) jsonError('No draft found');
        if ($db['draft']['status'] !== 'active') jsonError('Draft is not active');

        $playerId = (int)($data['player_id'] ?? 0);
        if (!$playerId) jsonError('player_id is required');
        $pickNum = (int)($data['pick_num'] ?? $db['draft']['current_pick_num']);

        // Validate pick slot exists and is empty
        $pickIdx = null;
        foreach ($db['picks'] as $i => $p) {
            if ($p['draft_id'] === $db['draft']['id'] && $p['pick_num'] === $pickNum) {
                $pickIdx = $i; break;
            }
        }
        if ($pickIdx === null) jsonError('Pick slot not found');
        if ($db['picks'][$pickIdx]['player_id'] !== null) jsonError('Pick slot already filled');

        // Validate player not already drafted
        foreach ($db['picks'] as $p) {
            if ($p['draft_id'] === $db['draft']['id'] && (int)$p['player_id'] === $playerId) {
                jsonError('Player already drafted');
            }
        }

        $db['picks'][$pickIdx]['player_id']  = $playerId;
        $db['picks'][$pickIdx]['is_auto_pick'] = 0;
        $db['picks'][$pickIdx]['picked_at']  = nowUtc();

        $next = nextUnfilledPick($db, $pickNum);
        $total = count(array_filter($db['picks'], fn($p) => $p['draft_id'] === $db['draft']['id']));

        if ($next > $total) {
            $db['draft']['status'] = 'completed';
            $db['draft']['timer_end'] = null;
        } else {
            $db['draft']['current_pick_num'] = $next;
            advanceTimer($db);
        }
        $db['draft']['updated_at'] = nowUtc();
        dbSave($db);
        jsonResponse(['success' => true, 'next_pick_num' => $next]);

    } elseif ($action === 'autopick') {
        if (!$db['draft']) jsonError('No draft found');
        if ($db['draft']['status'] !== 'active') jsonError('Draft is not active');

        $player = getNextAvailablePlayer($db);
        if (!$player) jsonError('No available players');

        $pickNum = (int)$db['draft']['current_pick_num'];
        $pickIdx = null;
        foreach ($db['picks'] as $i => $p) {
            if ($p['draft_id'] === $db['draft']['id'] && $p['pick_num'] === $pickNum) {
                $pickIdx = $i; break;
            }
        }
        if ($pickIdx === null) jsonError('Pick slot not found');

        $db['picks'][$pickIdx]['player_id']   = $player['id'];
        $db['picks'][$pickIdx]['is_auto_pick'] = 1;
        $db['picks'][$pickIdx]['picked_at']   = nowUtc();

        $next  = nextUnfilledPick($db, $pickNum);
        $total = count(array_filter($db['picks'], fn($p) => $p['draft_id'] === $db['draft']['id']));

        if ($next > $total) {
            $db['draft']['status'] = 'completed';
            $db['draft']['timer_end'] = null;
        } else {
            $db['draft']['current_pick_num'] = $next;
            advanceTimer($db);
        }
        $db['draft']['updated_at'] = nowUtc();
        dbSave($db);

        // Return enriched pick info for announcement
        $teams = array_column($db['teams'], null, 'id');
        $pick  = $db['picks'][$pickIdx];
        $pick['team_name'] = $teams[$pick['team_id']]['name'] ?? '';
        jsonResponse(['success' => true, 'player' => $player, 'pick' => $pick, 'next_pick_num' => $next]);

    } elseif ($action === 'preassign') {
        $data = getInput();
        if (!$db['draft']) jsonError('No draft found');
        if ($db['draft']['status'] === 'completed') jsonError('Draft is completed');

        $pickNum  = (int)($data['pick_num'] ?? 0);
        $playerId = (int)($data['player_id'] ?? 0);
        if (!$pickNum || !$playerId) jsonError('pick_num and player_id required');

        if ($db['draft']['status'] === 'active' && $pickNum <= $db['draft']['current_pick_num']) {
            jsonError('Cannot pre-assign a past or current pick');
        }

        // Validate player not already assigned
        foreach ($db['picks'] as $p) {
            if ($p['draft_id'] === $db['draft']['id'] && (int)$p['player_id'] === $playerId) {
                jsonError('Player already assigned');
            }
        }

        foreach ($db['picks'] as &$p) {
            if ($p['draft_id'] === $db['draft']['id'] && $p['pick_num'] === $pickNum) {
                $p['player_id']      = $playerId;
                $p['is_pre_assigned'] = 1;
                $p['picked_at']      = null;
                break;
            }
        }
        unset($p);
        dbSave($db);
        jsonResponse(['success' => true]);

    } elseif ($action === 'clear_pick') {
        $data = getInput();
        if (!$db['draft']) jsonError('No draft found');
        $pickNum = (int)($data['pick_num'] ?? 0);
        if (!$pickNum) jsonError('pick_num required');

        foreach ($db['picks'] as &$p) {
            if ($p['draft_id'] === $db['draft']['id'] && $p['pick_num'] === $pickNum) {
                $p['player_id']       = null;
                $p['is_pre_assigned'] = 0;
                $p['is_auto_pick']    = 0;
                $p['picked_at']       = null;
                break;
            }
        }
        unset($p);
        dbSave($db);
        jsonResponse(['success' => true]);

    } elseif ($action === 'update_settings') {
        $data = getInput();
        if (!$db['draft']) jsonError('No draft found');
        if ($db['draft']['status'] === 'active') jsonError('Cannot change settings while draft is active');
        if (isset($data['timer_minutes']))    $db['draft']['timer_minutes'] = (int)$data['timer_minutes'];
        if (isset($data['auto_pick_enabled'])) $db['draft']['auto_pick_enabled'] = (int)$data['auto_pick_enabled'];
        $db['draft']['updated_at'] = nowUtc();
        dbSave($db);
        jsonResponse(['success' => true]);

    } else {
        jsonError('Unknown action', 404);
    }

} catch (Exception $e) {
    jsonError('Error: ' . $e->getMessage(), 500);
}
