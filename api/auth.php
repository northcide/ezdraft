<?php
require_once __DIR__ . '/helpers.php';

$action = getAction();

try {
    if ($action === 'check') {
        $role = currentRole();
        if (!$role) jsonError('Not authenticated', 401);
        $db   = getDB();
        $name = $db->query("SELECT value FROM settings WHERE `key`='league_name'")->fetchColumn();
        jsonResponse(['role' => $role, 'league_name' => $name ?: 'EasyDraft']);

    } elseif ($action === 'login') {
        $data = getInput();
        $league = trim($data['league_name'] ?? '');
        $pin    = trim($data['pin'] ?? '');

        if ($league === '' || $pin === '') jsonError('League name and PIN are required');

        $db = getDB();
        $row = $db->query(
            "SELECT `key`, value FROM settings WHERE `key` IN ('league_name','admin_pin','coach_pin')"
        )->fetchAll(PDO::FETCH_KEY_PAIR);

        $storedLeague = $row['league_name'] ?? '';
        $adminPin     = $row['admin_pin']   ?? '';
        $coachPin     = $row['coach_pin']   ?? '';

        if (strcasecmp($league, $storedLeague) !== 0) {
            jsonError('League name not found', 401);
        }

        if ($pin === $adminPin) {
            $_SESSION['role']        = 'admin';
            $_SESSION['league_name'] = $storedLeague;
            jsonResponse(['role' => 'admin', 'league_name' => $storedLeague]);
        } elseif ($pin === $coachPin) {
            $_SESSION['role']        = 'coach';
            $_SESSION['league_name'] = $storedLeague;
            jsonResponse(['role' => 'coach', 'league_name' => $storedLeague]);
        } else {
            jsonError('Incorrect PIN', 401);
        }

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
