<?php
require_once __DIR__ . '/helpers.php';

$action = getAction();

try {
    if ($action === 'check') {
        $role = currentRole();
        if (!$role) jsonError('Not authenticated', 401);
        $db   = getDB();
        $name = $db->query("SELECT value FROM settings WHERE `key`='league_name'")->fetchColumn();
        $result = ['role' => $role, 'league_name' => $name ?: 'EasyDraft'];
        if ($role === 'coach') {
            $accessible = getAccessibleDrafts($db);
            $result['accessibleDrafts'] = $accessible;
        }
        jsonResponse($result);

    } elseif ($action === 'login') {
        $data     = getInput();
        $league   = trim($data['league_name'] ?? '');
        $pin      = trim($data['pin'] ?? '');
        $mode     = trim($data['mode'] ?? 'admin');
        $teamName = trim($data['team_name'] ?? '');

        if ($league === '') jsonError('League name is required');
        if ($pin === '')    jsonError('PIN is required');

        $db = getDB();

        if ($mode === 'admin') {
            // Admin-only path
            $row = $db->query(
                "SELECT `key`, value FROM settings WHERE `key` IN ('league_name','admin_pin')"
            )->fetchAll(PDO::FETCH_KEY_PAIR);

            if (strcasecmp($league, $row['league_name'] ?? '') === 0 && $pin === ($row['admin_pin'] ?? '')) {
                $_SESSION['role']        = 'admin';
                $_SESSION['league_name'] = $row['league_name'];
                unset($_SESSION['accessible_draft_ids'], $_SESSION['selected_draft_id']);
                jsonResponse(['role' => 'admin', 'league_name' => $row['league_name']]);
            }

            jsonError('League name or PIN not found', 401);
        }

        // Team tab path
        if ($teamName !== '') {
            // Per-team login: draft name + team name + PIN
            $draftStmt = $db->prepare(
                "SELECT id FROM drafts WHERE name = ? AND coach_mode = 'team'"
            );
            $draftStmt->execute([$league]);
            $d = $draftStmt->fetch();
            if (!$d) jsonError('Invalid draft name or not in team mode', 401);

            $teamStmt = $db->prepare(
                "SELECT id, name FROM teams WHERE draft_id = ? AND name = ? AND pin = ?"
            );
            $teamStmt->execute([$d['id'], $teamName, $pin]);
            $t = $teamStmt->fetch();
            if (!$t) jsonError('Invalid team name or PIN', 401);

            $_SESSION['role']                 = 'team';
            $_SESSION['team_id']              = $t['id'];
            $_SESSION['accessible_draft_ids'] = [$d['id']];
            $_SESSION['selected_draft_id']    = $d['id'];
            jsonResponse(['role' => 'team', 'league_name' => $league]);
        }

        // Shared coach login: coach_name + coach_pin (no team name)
        $stmt = $db->prepare(
            "SELECT id, name FROM drafts WHERE LOWER(coach_name)=LOWER(?) AND coach_pin=? AND coach_name IS NOT NULL AND coach_pin IS NOT NULL"
        );
        $stmt->execute([$league, $pin]);
        $matchedDrafts = $stmt->fetchAll();

        if (empty($matchedDrafts)) {
            jsonError('League name or PIN not found', 401);
        }

        $accessibleIds = array_column($matchedDrafts, 'id');
        $_SESSION['role']                 = 'coach';
        $_SESSION['league_name']          = $league;
        $_SESSION['accessible_draft_ids'] = $accessibleIds;

        // Auto-select: prefer live draft, else first accessible
        $liveStmt = $db->prepare("SELECT id FROM drafts WHERE id IN (" . implode(',', array_fill(0, count($accessibleIds), '?')) . ") AND status IN ('active','paused') ORDER BY updated_at DESC LIMIT 1");
        $liveStmt->execute($accessibleIds);
        $live = $liveStmt->fetchColumn();
        $_SESSION['selected_draft_id'] = $live ?: $accessibleIds[0];

        $accessible = getAccessibleDrafts($db);
        jsonResponse(['role' => 'coach', 'league_name' => $league, 'accessibleDrafts' => $accessible]);

    } elseif ($action === 'logout') {
        $_SESSION = [];
        session_destroy();
        jsonResponse(['success' => true]);

    } else {
        jsonError('Unknown action', 404);
    }

} catch (PDOException $e) {
    jsonError('Database error: ' . $e->getMessage(), 500);
}

function getAccessibleDrafts(PDO $db): array {
    $ids = $_SESSION['accessible_draft_ids'] ?? [];
    if (empty($ids)) return [];
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $stmt = $db->prepare("SELECT id, name, status, started_at, completed_at FROM drafts WHERE id IN ($placeholders) ORDER BY created_at DESC");
    $stmt->execute(array_map('intval', $ids));
    return $stmt->fetchAll();
}
