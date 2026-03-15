<?php
require_once __DIR__ . '/helpers.php';

$action = getAction();

try {
    $db = dbLoad();

    if ($action === 'list') {
        $players = $db['players'];

        if (isset($_GET['position']) && $_GET['position'] !== '') {
            $pos = $_GET['position'];
            $players = array_values(array_filter($players, fn($p) => $p['position'] === $pos));
        }
        if (isset($_GET['coaches_kid']) && $_GET['coaches_kid'] !== '') {
            $ck = (int)$_GET['coaches_kid'];
            $players = array_values(array_filter($players, fn($p) => (int)$p['is_coaches_kid'] === $ck));
        }
        if (isset($_GET['age']) && $_GET['age'] !== '') {
            $age = (int)$_GET['age'];
            $players = array_values(array_filter($players, fn($p) => (int)$p['age'] === $age));
        }

        usort($players, fn($a, $b) => $a['rank'] <=> $b['rank']);
        jsonResponse($players);

    } elseif ($action === 'get') {
        $id = (int)($_GET['id'] ?? 0);
        $player = current(array_filter($db['players'], fn($p) => $p['id'] === $id));
        if (!$player) jsonError('Player not found', 404);
        jsonResponse($player);

    } elseif ($action === 'create') {
        $data = getInput();
        if (empty($data['name'])) jsonError('name is required');
        if (!isset($data['rank'])) jsonError('rank is required');

        $player = [
            'id'            => nextId($db['players']),
            'name'          => $data['name'],
            'rank'          => (int)$data['rank'],
            'position'      => $data['position'] ?? null,
            'is_coaches_kid'=> (int)($data['is_coaches_kid'] ?? 0),
            'age'           => isset($data['age']) ? (int)$data['age'] : null,
            'notes'         => $data['notes'] ?? null,
            'created_at'    => nowUtc(),
        ];
        $db['players'][] = $player;
        dbSave($db);
        jsonResponse($player, 201);

    } elseif ($action === 'update') {
        $data = getInput();
        if (empty($data['id'])) jsonError('id is required');
        $id = (int)$data['id'];
        foreach ($db['players'] as &$p) {
            if ($p['id'] === $id) {
                $p['name']           = $data['name'] ?? $p['name'];
                $p['rank']           = isset($data['rank']) ? (int)$data['rank'] : $p['rank'];
                $p['position']       = $data['position'] ?? $p['position'];
                $p['is_coaches_kid'] = (int)($data['is_coaches_kid'] ?? $p['is_coaches_kid']);
                $p['age']            = isset($data['age']) ? (int)$data['age'] : $p['age'];
                $p['notes']          = $data['notes'] ?? $p['notes'];
                break;
            }
        }
        unset($p);
        dbSave($db);
        jsonResponse(['success' => true]);

    } elseif ($action === 'delete') {
        $data = getInput();
        if (empty($data['id'])) jsonError('id is required');
        $id = (int)$data['id'];
        $db['players'] = array_values(array_filter($db['players'], fn($p) => $p['id'] !== $id));
        dbSave($db);
        jsonResponse(['success' => true]);

    } elseif ($action === 'import') {
        if (empty($_FILES['csv'])) jsonError('No CSV file uploaded');

        $file   = $_FILES['csv']['tmp_name'];
        $handle = fopen($file, 'r');
        if (!$handle) jsonError('Could not read uploaded file');

        $headers = fgetcsv($handle);
        if (!$headers) { fclose($handle); jsonError('CSV file is empty'); }
        $headers = array_map(fn($h) => strtolower(trim($h)), $headers);

        if (!in_array('name', $headers, true)) {
            fclose($handle);
            jsonError("CSV missing required column: name");
        }

        $col      = array_flip($headers);
        $imported = 0;
        $errors   = [];
        $row      = 1;
        // Start ranks after any existing players
        $startRank = empty($db['players']) ? 1 : max(array_column($db['players'], 'rank')) + 1;

        while (($line = fgetcsv($handle)) !== false) {
            $row++;
            $name = trim($line[$col['name']] ?? '');
            if ($name === '') {
                $errors[] = "Row $row: missing name";
                continue;
            }
            // Use explicit rank column if present, otherwise use row order
            $rank = isset($col['rank']) && trim($line[$col['rank']]) !== ''
                ? (int)trim($line[$col['rank']])
                : $startRank + $imported;
            $ck = 0;
            if (isset($col['coaches_kid'])) {
                $v  = strtolower(trim($line[$col['coaches_kid']]));
                $ck = in_array($v, ['1','yes','true','y'], true) ? 1 : 0;
            }
            $db['players'][] = [
                'id'             => nextId($db['players']),
                'name'           => $name,
                'rank'           => $rank,
                'position'       => isset($col['position']) ? (trim($line[$col['position']]) ?: null) : null,
                'is_coaches_kid' => $ck,
                'age'            => isset($col['age']) ? ((int)trim($line[$col['age']]) ?: null) : null,
                'notes'          => isset($col['notes']) ? (trim($line[$col['notes']]) ?: null) : null,
                'created_at'     => nowUtc(),
            ];
            $imported++;
        }
        fclose($handle);
        dbSave($db);
        jsonResponse(['imported' => $imported, 'errors' => $errors]);

    } elseif ($action === 'bulk_names') {
        // Accept {names: ["Name 1", "Name 2", ...], replace: true}
        // Ranking is determined by position in the array (index 0 = rank 1)
        $data = getInput();
        if (empty($data['names']) || !is_array($data['names'])) jsonError('names array is required');

        if (!empty($data['replace'])) {
            $db['players'] = [];
        }

        $startRank = empty($db['players']) ? 1 : max(array_column($db['players'], 'rank')) + 1;
        $imported  = 0;

        foreach ($data['names'] as $i => $name) {
            $name = trim($name);
            if ($name === '') continue;
            $db['players'][] = [
                'id'             => nextId($db['players']),
                'name'           => $name,
                'rank'           => $startRank + $imported,
                'position'       => null,
                'is_coaches_kid' => 0,
                'age'            => null,
                'notes'          => null,
                'created_at'     => nowUtc(),
            ];
            $imported++;
        }
        dbSave($db);
        jsonResponse(['imported' => $imported]);

    } elseif ($action === 'clear_all') {
        $db['players'] = [];
        dbSave($db);
        jsonResponse(['success' => true]);

    } else {
        jsonError('Unknown action', 404);
    }

} catch (Exception $e) {
    jsonError('Error: ' . $e->getMessage(), 500);
}
