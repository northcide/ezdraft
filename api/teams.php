<?php
require_once __DIR__ . '/helpers.php';
requireAuth();

$action = getAction();

try {
    $db = getDB();

    if ($action === 'list') {
        jsonResponse($db->query('SELECT * FROM teams ORDER BY draft_order ASC')->fetchAll());

    } elseif ($action === 'create') {
        requireAdmin();
        $data = getInput();
        if (empty($data['name'])) jsonError('name is required');
        $maxOrder = (int)$db->query('SELECT COALESCE(MAX(draft_order),0) FROM teams')->fetchColumn();
        $stmt     = $db->prepare('INSERT INTO teams (name, draft_order) VALUES (?, ?)');
        $stmt->execute([$data['name'], $maxOrder + 1]);
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
        $db->exec('DELETE FROM teams');
        jsonResponse(['success' => true]);

    } else {
        jsonError('Unknown action', 404);
    }

} catch (PDOException $e) {
    jsonError('Database error: ' . $e->getMessage(), 500);
}
