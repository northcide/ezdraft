<?php
require_once __DIR__ . '/helpers.php';

$action = getAction();

try {
    if ($action === 'check') {
        $role = currentRole();
        if (!$role) jsonError('Not authenticated', 401);
        $db   = getDB();
        $name = $db->query("SELECT value FROM settings WHERE `key`='league_name'")->fetchColumn();
        $result = [
            'role'       => $role,
            'league_name'=> $name ?: 'ezDraft',
            'csrf_token' => $_SESSION['csrf_token'],
        ];
        if ($role === 'coach') {
            $result['accessibleDrafts'] = getAccessibleDrafts($db);
        }
        jsonResponse($result);

    } elseif ($action === 'login') {
        $ip   = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
        checkRateLimit($ip);

        $data     = getInput();
        $league   = trim($data['league_name'] ?? '');
        $pin      = trim($data['pin'] ?? '');
        $mode     = trim($data['mode'] ?? 'admin');
        $teamName = trim($data['team_name'] ?? '');

        if ($league === '') jsonError('League name is required');
        if ($pin === '')    jsonError('PIN is required');

        $db = getDB();

        if ($mode === 'admin') {
            $row = $db->query(
                "SELECT `key`, value FROM settings WHERE `key` IN ('league_name','admin_pin')"
            )->fetchAll(PDO::FETCH_KEY_PAIR);

            if (strcasecmp($league, $row['league_name'] ?? '') === 0
                && verifyPin($pin, $row['admin_pin'] ?? '')) {
                // Rehash plaintext PIN on first login after upgrade
                rehashPinIfNeeded($db, $pin, $row['admin_pin'] ?? '', 'settings', 'value', 'key', 'admin_pin');
                clearRateLimit($ip);
                session_regenerate_id(true);
                $_SESSION['role']        = 'admin';
                $_SESSION['league_name'] = $row['league_name'];
                unset($_SESSION['accessible_draft_ids'], $_SESSION['selected_draft_id']);
                jsonResponse([
                    'role'        => 'admin',
                    'league_name' => $row['league_name'],
                    'csrf_token'  => $_SESSION['csrf_token'],
                ]);
            }

            recordFailedLogin($ip);
            jsonError('League name or PIN not found', 401);
        }

        // Team tab path
        if ($teamName !== '') {
            $draftStmt = $db->prepare(
                "SELECT id FROM drafts WHERE name = ? AND coach_mode = 'team'"
            );
            $draftStmt->execute([$league]);
            $d = $draftStmt->fetch();
            if (!$d) { recordFailedLogin($ip); jsonError('Invalid draft name or not in team mode', 401); }

            $teamStmt = $db->prepare(
                "SELECT id, name, pin FROM teams WHERE draft_id = ? AND name = ?"
            );
            $teamStmt->execute([$d['id'], $teamName]);
            $t = $teamStmt->fetch();
            if (!$t || !verifyPin($pin, $t['pin'] ?? '')) {
                recordFailedLogin($ip);
                jsonError('Invalid team name or PIN', 401);
            }
            // Rehash plaintext PIN on first login after upgrade
            rehashPinIfNeeded($db, $pin, $t['pin'] ?? '', 'teams', 'pin', 'id', $t['id']);
            clearRateLimit($ip);
            session_regenerate_id(true);
            $_SESSION['role']                 = 'team';
            $_SESSION['team_id']              = $t['id'];
            $_SESSION['accessible_draft_ids'] = [$d['id']];
            $_SESSION['selected_draft_id']    = $d['id'];
            jsonResponse([
                'role'       => 'team',
                'league_name'=> $league,
                'csrf_token' => $_SESSION['csrf_token'],
            ]);
        }

        // Shared coach login: coach_name + coach_pin
        $stmt = $db->prepare(
            "SELECT id, name, coach_pin FROM drafts WHERE LOWER(coach_name)=LOWER(?) AND coach_name IS NOT NULL AND coach_pin IS NOT NULL"
        );
        $stmt->execute([$league]);
        $allMatched = $stmt->fetchAll();

        $matchedDrafts = array_filter($allMatched, fn($d) => verifyPin($pin, $d['coach_pin'] ?? ''));

        if (empty($matchedDrafts)) {
            recordFailedLogin($ip);
            jsonError('League name or PIN not found', 401);
        }

        // Rehash plaintext PINs on first login after upgrade
        foreach ($matchedDrafts as $md) {
            rehashPinIfNeeded($db, $pin, $md['coach_pin'] ?? '', 'drafts', 'coach_pin', 'id', $md['id']);
        }

        clearRateLimit($ip);
        $accessibleIds = array_values(array_column($matchedDrafts, 'id'));
        session_regenerate_id(true);
        $_SESSION['role']                 = 'coach';
        $_SESSION['league_name']          = $league;
        $_SESSION['accessible_draft_ids'] = $accessibleIds;

        // Auto-select: prefer live draft, else first accessible
        $placeholders = implode(',', array_fill(0, count($accessibleIds), '?'));
        $liveStmt = $db->prepare("SELECT id FROM drafts WHERE id IN ($placeholders) AND status IN ('active','paused') ORDER BY updated_at DESC LIMIT 1");
        $liveStmt->execute(array_map('intval', $accessibleIds));
        $live = $liveStmt->fetchColumn();
        $_SESSION['selected_draft_id'] = $live ?: $accessibleIds[0];

        $accessible = getAccessibleDrafts($db);
        jsonResponse([
            'role'            => 'coach',
            'league_name'     => $league,
            'accessibleDrafts'=> $accessible,
            'csrf_token'      => $_SESSION['csrf_token'],
        ]);

    } elseif ($action === 'logout') {
        validateCsrf();
        $_SESSION = [];
        session_destroy();
        jsonResponse(['success' => true]);

    } elseif ($action === 'generate_token') {
        requireAdmin();
        $data    = getInput();
        $type    = $data['type'] ?? '';
        $db      = getDB();
        $token   = bin2hex(random_bytes(32));
        $expires = (new DateTime('+4 hours', new DateTimeZone('UTC')))->format('Y-m-d H:i:s');

        if ($type === 'coach') {
            $draftId = (int)($data['draft_id'] ?? 0);
            $draft = $db->prepare("SELECT id, coach_mode FROM drafts WHERE id=? AND archived=0");
            $draft->execute([$draftId]);
            $d = $draft->fetch();
            if (!$d) jsonError('Draft not found', 404);
            if ($d['coach_mode'] !== 'shared') jsonError('Draft is not in shared coach mode');
            $db->prepare("UPDATE drafts SET coach_login_token=?, coach_token_expires_at=? WHERE id=?")
               ->execute([$token, $expires, $draftId]);
        } elseif ($type === 'team') {
            $teamId = (int)($data['team_id'] ?? 0);
            $r = $db->prepare("SELECT id FROM teams WHERE id=?");
            $r->execute([$teamId]);
            if (!$r->fetch()) jsonError('Team not found', 404);
            $db->prepare("UPDATE teams SET login_token=?, token_expires_at=? WHERE id=?")
               ->execute([$token, $expires, $teamId]);
        } else {
            jsonError('type must be "coach" or "team"');
        }

        jsonResponse(['token' => $token, 'expires_at' => str_replace(' ', 'T', $expires) . 'Z']);

    } else {
        jsonError('Unknown action', 404);
    }

} catch (PDOException $e) {
    error_log('ezDraft auth error: ' . $e->getMessage());
    jsonError('A server error occurred', 500);
}

function getAccessibleDrafts(PDO $db): array {
    $ids = $_SESSION['accessible_draft_ids'] ?? [];
    if (empty($ids)) return [];
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $stmt = $db->prepare("SELECT id, name, status, started_at, completed_at FROM drafts WHERE id IN ($placeholders) ORDER BY created_at DESC");
    $stmt->execute(array_map('intval', $ids));
    return $stmt->fetchAll();
}
