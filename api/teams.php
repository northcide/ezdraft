<?php
require_once __DIR__ . '/helpers.php';
requireAuth();

$action = getAction();

try {
    $db = getDB();

    if ($action === 'list') {
        $draftId = contextDraftId($db);
        $stmt    = $db->prepare('SELECT * FROM teams WHERE draft_id=? ORDER BY draft_order ASC');
        $stmt->execute([$draftId]);
        $rows = $stmt->fetchAll();
        // Replace pin with has_pin boolean for all roles
        $rows = array_map(fn($r) => array_merge(array_diff_key($r, ['pin' => 1]), ['has_pin' => !empty($r['pin'])]), $rows);
        jsonResponse($rows);

    } elseif ($action === 'create') {
        requireAdmin();
        $draftId  = contextDraftId($db);
        $data     = getInput();
        if (empty($data['name'])) jsonError('name is required');
        $rawPin   = trim($data['pin'] ?? '');
        $pin      = $rawPin !== '' ? hashPin($rawPin) : null;
        $maxStmt  = $db->prepare('SELECT COALESCE(MAX(draft_order),0) FROM teams WHERE draft_id=?');
        $maxStmt->execute([$draftId]);
        $maxOrder = (int)$maxStmt->fetchColumn();
        $stmt     = $db->prepare('INSERT INTO teams (draft_id, name, draft_order, pin) VALUES (?, ?, ?, ?)');
        $stmt->execute([$draftId, $data['name'], $maxOrder + 1, $pin]);
        $id   = $db->lastInsertId();
        $stmt = $db->prepare('SELECT * FROM teams WHERE id=?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        $row = array_merge(array_diff_key($row, ['pin' => 1]), ['has_pin' => !empty($row['pin'])]);
        jsonResponse($row, 201);

    } elseif ($action === 'update') {
        requireAdmin();
        $data = getInput();
        if (empty($data['id'])) jsonError('id is required');
        $db->prepare('UPDATE teams SET name=?, draft_order=? WHERE id=?')
           ->execute([$data['name'], (int)$data['draft_order'], (int)$data['id']]);
        jsonResponse(['success' => true]);

    } elseif ($action === 'delete') {
        requireAdmin();
        $data = getInput();
        if (empty($data['id'])) jsonError('id is required');
        $db->prepare('DELETE FROM teams WHERE id=?')->execute([(int)$data['id']]);
        jsonResponse(['success' => true]);

    } elseif ($action === 'reorder') {
        requireAdmin();
        $data = getInput();
        if (!is_array($data)) jsonError('Expected array');
        $stmt = $db->prepare('UPDATE teams SET draft_order=? WHERE id=?');
        $db->beginTransaction();
        foreach ($data as $item) {
            $stmt->execute([(int)$item['draft_order'], (int)$item['id']]);
        }
        $db->commit();
        jsonResponse(['success' => true]);

    } elseif ($action === 'set_pin') {
        requireAdmin();
        $data   = getInput();
        if (empty($data['id'])) jsonError('id is required');
        $rawPin = trim($data['pin'] ?? '');
        $pin    = $rawPin !== '' ? hashPin($rawPin) : null;
        $db->prepare('UPDATE teams SET pin=? WHERE id=?')->execute([$pin, (int)$data['id']]);
        jsonResponse(['success' => true]);

    } elseif ($action === 'clear_all') {
        requireAdmin();
        $draftId = contextDraftId($db);
        $db->prepare('DELETE FROM teams WHERE draft_id=?')->execute([$draftId]);
        jsonResponse(['success' => true]);

    } elseif ($action === 'bulk_create') {
        requireAdmin();
        $draftId = contextDraftId($db);
        $data    = getInput();
        $teams   = $data['teams'] ?? [];
        $clear   = !empty($data['clear_existing']);

        if (!is_array($teams) || count($teams) < 2 || count($teams) > 16) {
            jsonError('Must provide 2–16 teams');
        }
        foreach ($teams as $t) {
            if (empty($t['name']) || trim($t['name']) === '') jsonError('All team names are required');
        }

        $db->beginTransaction();
        if ($clear) {
            $db->prepare('DELETE FROM picks WHERE draft_id=?')->execute([$draftId]);
            $db->prepare('DELETE FROM teams WHERE draft_id=?')->execute([$draftId]);
            $startOrder = 1;
        } else {
            $maxStmt = $db->prepare('SELECT COALESCE(MAX(draft_order),0) FROM teams WHERE draft_id=?');
            $maxStmt->execute([$draftId]);
            $startOrder = (int)$maxStmt->fetchColumn() + 1;
        }

        $ins = $db->prepare('INSERT INTO teams (draft_id, name, draft_order, pin) VALUES (?, ?, ?, ?)');
        foreach ($teams as $i => $t) {
            $rawPin = trim($t['pin'] ?? '');
            $pin    = $rawPin !== '' ? hashPin($rawPin) : null;
            $ins->execute([$draftId, trim($t['name']), $startOrder + $i, $pin]);
        }
        $db->commit();

        $allStmt = $db->prepare('SELECT * FROM teams WHERE draft_id=? ORDER BY draft_order ASC');
        $allStmt->execute([$draftId]);
        $allTeams = array_map(
            fn($r) => array_merge(array_diff_key($r, ['pin' => 1]), ['has_pin' => !empty($r['pin'])]),
            $allStmt->fetchAll()
        );
        jsonResponse(['teams' => $allTeams]);

    } else {
        jsonError('Unknown action', 404);
    }

} catch (PDOException $e) {
    error_log('EasyDraft teams error: ' . $e->getMessage());
    jsonError('A server error occurred', 500);
}
