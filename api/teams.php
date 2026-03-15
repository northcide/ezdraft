<?php
require_once __DIR__ . '/helpers.php';

$action = getAction();

try {
    $db = dbLoad();

    if ($action === 'list') {
        $teams = $db['teams'];
        usort($teams, fn($a, $b) => $a['draft_order'] <=> $b['draft_order']);
        jsonResponse($teams);

    } elseif ($action === 'create') {
        $data = getInput();
        if (empty($data['name'])) jsonError('name is required');

        $maxOrder = empty($db['teams']) ? 0 : max(array_column($db['teams'], 'draft_order'));
        $team = [
            'id'          => nextId($db['teams']),
            'name'        => $data['name'],
            'draft_order' => isset($data['draft_order']) ? (int)$data['draft_order'] : $maxOrder + 1,
            'created_at'  => nowUtc(),
        ];
        $db['teams'][] = $team;
        dbSave($db);
        jsonResponse($team, 201);

    } elseif ($action === 'update') {
        $data = getInput();
        if (empty($data['id'])) jsonError('id is required');
        $id = (int)$data['id'];
        foreach ($db['teams'] as &$t) {
            if ($t['id'] === $id) {
                $t['name']        = $data['name'] ?? $t['name'];
                $t['draft_order'] = isset($data['draft_order']) ? (int)$data['draft_order'] : $t['draft_order'];
                break;
            }
        }
        unset($t);
        dbSave($db);
        jsonResponse(['success' => true]);

    } elseif ($action === 'delete') {
        $data = getInput();
        if (empty($data['id'])) jsonError('id is required');
        $id = (int)$data['id'];
        $db['teams'] = array_values(array_filter($db['teams'], fn($t) => $t['id'] !== $id));
        dbSave($db);
        jsonResponse(['success' => true]);

    } elseif ($action === 'reorder') {
        $data = getInput();
        if (!is_array($data)) jsonError('Expected array');
        $orderMap = [];
        foreach ($data as $item) {
            $orderMap[(int)$item['id']] = (int)$item['draft_order'];
        }
        foreach ($db['teams'] as &$t) {
            if (isset($orderMap[$t['id']])) {
                $t['draft_order'] = $orderMap[$t['id']];
            }
        }
        unset($t);
        dbSave($db);
        jsonResponse(['success' => true]);

    } elseif ($action === 'clear_all') {
        $db['teams'] = [];
        dbSave($db);
        jsonResponse(['success' => true]);

    } else {
        jsonError('Unknown action', 404);
    }

} catch (Exception $e) {
    jsonError('Error: ' . $e->getMessage(), 500);
}
