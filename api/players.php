<?php
require_once __DIR__ . '/helpers.php';

$action = getAction();
$method = $_SERVER['REQUEST_METHOD'];

try {
    $db = getDB();

    if ($method === 'GET' && $action === 'list') {
        $where = [];
        $params = [];

        if (isset($_GET['position']) && $_GET['position'] !== '') {
            $where[] = 'position = ?';
            $params[] = $_GET['position'];
        }
        if (isset($_GET['coaches_kid']) && $_GET['coaches_kid'] !== '') {
            $where[] = 'is_coaches_kid = ?';
            $params[] = (int)$_GET['coaches_kid'];
        }
        if (isset($_GET['age']) && $_GET['age'] !== '') {
            $where[] = 'age = ?';
            $params[] = (int)$_GET['age'];
        }

        $sql = 'SELECT p.*, ' .
            '(SELECT pk.pick_num FROM picks pk WHERE pk.player_id = p.id LIMIT 1) AS pick_num, ' .
            '(SELECT t.name FROM picks pk JOIN teams t ON pk.team_id = t.id WHERE pk.player_id = p.id LIMIT 1) AS drafted_by ' .
            'FROM players p';

        if ($where) {
            $sql .= ' WHERE ' . implode(' AND ', $where);
        }

        $sql .= ' ORDER BY p.`rank` ASC';

        $stmt = $db->prepare($sql);
        $stmt->execute($params);
        jsonResponse($stmt->fetchAll());

    } elseif ($method === 'GET' && $action === 'get') {
        $id = (int)($_GET['id'] ?? 0);
        if (!$id) jsonError('Missing id');
        $stmt = $db->prepare('SELECT * FROM players WHERE id = ?');
        $stmt->execute([$id]);
        $player = $stmt->fetch();
        if (!$player) jsonError('Player not found', 404);
        jsonResponse($player);

    } elseif ($method === 'POST' && $action === 'create') {
        $data = getInput();
        if (empty($data['name'])) jsonError('name is required');
        if (!isset($data['rank'])) jsonError('rank is required');

        $stmt = $db->prepare(
            'INSERT INTO players (name, `rank`, position, is_coaches_kid, age, notes) VALUES (?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            $data['name'],
            (int)$data['rank'],
            $data['position'] ?? null,
            (int)($data['is_coaches_kid'] ?? 0),
            isset($data['age']) ? (int)$data['age'] : null,
            $data['notes'] ?? null,
        ]);
        $id = $db->lastInsertId();
        $stmt = $db->prepare('SELECT * FROM players WHERE id = ?');
        $stmt->execute([$id]);
        jsonResponse($stmt->fetch(), 201);

    } elseif ($method === 'POST' && $action === 'update') {
        $data = getInput();
        if (empty($data['id'])) jsonError('id is required');

        $stmt = $db->prepare(
            'UPDATE players SET name=?, `rank`=?, position=?, is_coaches_kid=?, age=?, notes=? WHERE id=?'
        );
        $stmt->execute([
            $data['name'],
            (int)$data['rank'],
            $data['position'] ?? null,
            (int)($data['is_coaches_kid'] ?? 0),
            isset($data['age']) ? (int)$data['age'] : null,
            $data['notes'] ?? null,
            (int)$data['id'],
        ]);
        jsonResponse(['success' => true]);

    } elseif ($method === 'POST' && $action === 'delete') {
        $data = getInput();
        if (empty($data['id'])) jsonError('id is required');
        $stmt = $db->prepare('DELETE FROM players WHERE id = ?');
        $stmt->execute([(int)$data['id']]);
        jsonResponse(['success' => true]);

    } elseif ($method === 'POST' && $action === 'import') {
        // CSV import via multipart form upload
        if (empty($_FILES['csv'])) jsonError('No CSV file uploaded');

        $file = $_FILES['csv']['tmp_name'];
        $handle = fopen($file, 'r');
        if (!$handle) jsonError('Could not read uploaded file');

        // Read header row
        $headers = fgetcsv($handle);
        if (!$headers) jsonError('CSV file is empty');

        // Normalize header names
        $headers = array_map(fn($h) => strtolower(trim($h)), $headers);

        $required = ['name', 'rank'];
        foreach ($required as $r) {
            if (!in_array($r, $headers, true)) {
                fclose($handle);
                jsonError("CSV missing required column: $r");
            }
        }

        $colIndex = array_flip($headers);
        $imported = 0;
        $errors = [];
        $row = 1;

        $db->beginTransaction();
        try {
            $stmt = $db->prepare(
                'INSERT INTO players (name, `rank`, position, is_coaches_kid, age, notes) VALUES (?, ?, ?, ?, ?, ?)'
            );
            while (($line = fgetcsv($handle)) !== false) {
                $row++;
                $name = trim($line[$colIndex['name']] ?? '');
                $rank = trim($line[$colIndex['rank']] ?? '');

                if ($name === '' || $rank === '') {
                    $errors[] = "Row $row: missing name or rank";
                    continue;
                }

                $position = isset($colIndex['position']) ? trim($line[$colIndex['position']]) : null;
                $coachesKid = 0;
                if (isset($colIndex['coaches_kid'])) {
                    $ck = strtolower(trim($line[$colIndex['coaches_kid']]));
                    $coachesKid = in_array($ck, ['1', 'yes', 'true', 'y'], true) ? 1 : 0;
                }
                $age = isset($colIndex['age']) ? (int)trim($line[$colIndex['age']]) : null;
                $notes = isset($colIndex['notes']) ? trim($line[$colIndex['notes']]) : null;

                $stmt->execute([
                    $name,
                    (int)$rank,
                    $position ?: null,
                    $coachesKid,
                    $age ?: null,
                    $notes ?: null,
                ]);
                $imported++;
            }
            $db->commit();
        } catch (Exception $e) {
            $db->rollBack();
            fclose($handle);
            jsonError('Import failed: ' . $e->getMessage());
        }
        fclose($handle);

        jsonResponse(['imported' => $imported, 'errors' => $errors]);

    } elseif ($method === 'POST' && $action === 'clear_all') {
        // Clear all players (use before re-import)
        $db->exec('DELETE FROM players');
        jsonResponse(['success' => true]);

    } else {
        jsonError('Unknown action', 404);
    }

} catch (PDOException $e) {
    jsonError('Database error: ' . $e->getMessage(), 500);
}
