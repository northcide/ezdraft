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
        jsonResponse($stmt->fetchAll());

    } elseif ($action === 'create') {
        requireAdmin();
        $draftId  = contextDraftId($db);
        $data     = getInput();
        if (empty($data['name'])) jsonError('name is required');
        $maxStmt  = $db->prepare('SELECT COALESCE(MAX(draft_order),0) FROM teams WHERE draft_id=?');
        $maxStmt->execute([$draftId]);
        $maxOrder = (int)$maxStmt->fetchColumn();
        $stmt     = $db->prepare('INSERT INTO teams (draft_id, name, draft_order) VALUES (?, ?, ?)');
        $stmt->execute([$draftId, $data['name'], $maxOrder + 1]);
        $id   = $db->lastInsertId();
        $stmt = $db->prepare('SELECT * FROM teams WHERE id=?');
        $stmt->execute([$id]);
        jsonResponse($stmt->fetch(), 201);

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

    } elseif ($action === 'clear_all') {
        requireAdmin();
        $draftId = contextDraftId($db);
        $db->prepare('DELETE FROM teams WHERE draft_id=?')->execute([$draftId]);
        jsonResponse(['success' => true]);

    } else {
        jsonError('Unknown action', 404);
    }

} catch (PDOException $e) {
    jsonError('Database error: ' . $e->getMessage(), 500);
}
