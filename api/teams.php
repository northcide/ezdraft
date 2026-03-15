<?php
require_once __DIR__ . '/helpers.php';

$action = getAction();
$method = $_SERVER['REQUEST_METHOD'];

try {
    $db = getDB();

    if ($method === 'GET' && $action === 'list') {
        $stmt = $db->query('SELECT * FROM teams ORDER BY draft_order ASC');
        jsonResponse($stmt->fetchAll());

    } elseif ($method === 'POST' && $action === 'create') {
        $data = getInput();
        if (empty($data['name'])) jsonError('name is required');

        // Auto-assign draft_order if not provided
        if (!isset($data['draft_order'])) {
            $stmt = $db->query('SELECT COALESCE(MAX(draft_order), 0) + 1 AS next FROM teams');
            $data['draft_order'] = (int)$stmt->fetchColumn();
        }

        $stmt = $db->prepare('INSERT INTO teams (name, draft_order) VALUES (?, ?)');
        $stmt->execute([$data['name'], (int)$data['draft_order']]);
        $id = $db->lastInsertId();
        $stmt = $db->prepare('SELECT * FROM teams WHERE id = ?');
        $stmt->execute([$id]);
        jsonResponse($stmt->fetch(), 201);

    } elseif ($method === 'POST' && $action === 'update') {
        $data = getInput();
        if (empty($data['id'])) jsonError('id is required');
        $stmt = $db->prepare('UPDATE teams SET name=?, draft_order=? WHERE id=?');
        $stmt->execute([$data['name'], (int)$data['draft_order'], (int)$data['id']]);
        jsonResponse(['success' => true]);

    } elseif ($method === 'POST' && $action === 'delete') {
        $data = getInput();
        if (empty($data['id'])) jsonError('id is required');
        $stmt = $db->prepare('DELETE FROM teams WHERE id = ?');
        $stmt->execute([(int)$data['id']]);
        jsonResponse(['success' => true]);

    } elseif ($method === 'POST' && $action === 'reorder') {
        // [{id, draft_order}, ...]
        $data = getInput();
        if (!is_array($data)) jsonError('Expected array');
        $stmt = $db->prepare('UPDATE teams SET draft_order=? WHERE id=?');
        $db->beginTransaction();
        foreach ($data as $item) {
            $stmt->execute([(int)$item['draft_order'], (int)$item['id']]);
        }
        $db->commit();
        jsonResponse(['success' => true]);

    } elseif ($method === 'POST' && $action === 'clear_all') {
        $db->exec('DELETE FROM teams');
        jsonResponse(['success' => true]);

    } else {
        jsonError('Unknown action', 404);
    }

} catch (PDOException $e) {
    jsonError('Database error: ' . $e->getMessage(), 500);
}
