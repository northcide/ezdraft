<?php
require_once __DIR__ . '/helpers.php';
requireAuth();

$action = getAction();

try {
    $db = getDB();

    if ($action === 'list') {
        $draftId = contextDraftId($db);
        $stmt    = $db->prepare('SELECT * FROM players WHERE draft_id=? ORDER BY `rank` ASC');
        $stmt->execute([$draftId]);
        jsonResponse($stmt->fetchAll());

    } elseif ($action === 'create') {
        requireAdmin();
        $draftId = contextDraftId($db);
        $data    = getInput();
        if (empty($data['name'])) jsonError('name is required');
        $stmt = $db->prepare(
            'INSERT INTO players (draft_id, name, `rank`, position, is_coaches_kid, age, is_pitcher, is_catcher, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            $draftId,
            $data['name'],
            (int)($data['rank'] ?? 1),
            $data['position'] ?? null,
            (int)($data['is_coaches_kid'] ?? 0),
            isset($data['age']) ? (int)$data['age'] : null,
            (int)($data['is_pitcher'] ?? 0),
            (int)($data['is_catcher'] ?? 0),
            $data['notes'] ?? null,
        ]);
        $id   = $db->lastInsertId();
        $stmt = $db->prepare('SELECT * FROM players WHERE id = ?');
        $stmt->execute([$id]);
        jsonResponse($stmt->fetch(), 201);

    } elseif ($action === 'update') {
        requireAdmin();
        $data = getInput();
        if (empty($data['id'])) jsonError('id is required');
        $db->prepare(
            'UPDATE players SET name=?, `rank`=?, position=?, is_coaches_kid=?, age=?, is_pitcher=?, is_catcher=?, notes=? WHERE id=?'
        )->execute([
            $data['name'],
            (int)$data['rank'],
            $data['position'] ?? null,
            (int)($data['is_coaches_kid'] ?? 0),
            isset($data['age']) ? (int)$data['age'] : null,
            (int)($data['is_pitcher'] ?? 0),
            (int)($data['is_catcher'] ?? 0),
            $data['notes'] ?? null,
            (int)$data['id'],
        ]);
        jsonResponse(['success' => true]);

    } elseif ($action === 'delete') {
        requireAdmin();
        $data = getInput();
        if (empty($data['id'])) jsonError('id is required');
        $db->prepare('DELETE FROM players WHERE id=?')->execute([(int)$data['id']]);
        jsonResponse(['success' => true]);

    } elseif ($action === 'reorder') {
        requireAdmin();
        $ids = getInput();
        if (!is_array($ids)) jsonError('Expected array of ids');
        $stmt = $db->prepare('UPDATE players SET `rank`=? WHERE id=?');
        $db->beginTransaction();
        foreach ($ids as $pos => $id) {
            $stmt->execute([$pos + 1, (int)$id]);
        }
        $db->commit();
        jsonResponse(['success' => true]);

    } elseif ($action === 'bulk_names') {
        requireAdmin();
        $draftId  = contextDraftId($db);
        $data     = getInput();
        $names    = $data['names'] ?? [];
        $replace  = !empty($data['replace']);
        if (!is_array($names)) jsonError('names must be an array');

        $db->beginTransaction();
        if ($replace) $db->prepare('DELETE FROM players WHERE draft_id=?')->execute([$draftId]);

        $maxStmt = $db->prepare('SELECT COALESCE(MAX(`rank`),0) FROM players WHERE draft_id=?');
        $maxStmt->execute([$draftId]);
        $maxRank = (int)$maxStmt->fetchColumn();

        $stmt = $db->prepare('INSERT INTO players (draft_id, name, `rank`, age, is_pitcher, is_catcher) VALUES (?, ?, ?, ?, ?, ?)');
        $imported = 0;
        foreach ($names as $entry) {
            $entry = trim($entry);
            if ($entry === '') continue;
            $parts     = array_map('trim', explode(',', $entry));
            $name      = array_shift($parts);
            if ($name === '') continue;
            $age       = null;
            $isPitcher = 0;
            $isCatcher = 0;
            foreach ($parts as $part) {
                $up = strtoupper($part);
                if ($up === 'P')           $isPitcher = 1;
                elseif ($up === 'C')       $isCatcher = 1;
                elseif (is_numeric($part)) $age = (int)$part;
            }
            $stmt->execute([$draftId, $name, $maxRank + $imported + 1, $age, $isPitcher, $isCatcher]);
            $imported++;
        }
        $db->commit();
        jsonResponse(['imported' => $imported]);

    } elseif ($action === 'import') {
        requireAdmin();
        $draftId = contextDraftId($db);
        if (empty($_FILES['csv'])) jsonError('No CSV file uploaded');

        $handle = fopen($_FILES['csv']['tmp_name'], 'r');
        if (!$handle) jsonError('Could not read file');

        $headers = array_map(fn($h) => strtolower(trim($h)), fgetcsv($handle) ?: []);
        if (!in_array('name', $headers, true)) {
            fclose($handle); jsonError('CSV missing required column: name');
        }
        $col = array_flip($headers);

        $db->beginTransaction();
        $maxStmt = $db->prepare('SELECT COALESCE(MAX(`rank`),0) FROM players WHERE draft_id=?');
        $maxStmt->execute([$draftId]);
        $maxRank  = (int)$maxStmt->fetchColumn();
        $stmt     = $db->prepare(
            'INSERT INTO players (draft_id, name, `rank`, position, is_coaches_kid, age, notes, is_pitcher, is_catcher) VALUES (?,?,?,?,?,?,?,?,?)'
        );
        $imported = 0; $errors = []; $row = 1;

        while (($line = fgetcsv($handle)) !== false) {
            $row++;
            $name = trim($line[$col['name']] ?? '');
            if ($name === '') { $errors[] = "Row $row: missing name"; continue; }

            $rank = isset($col['rank']) && trim($line[$col['rank']]) !== ''
                ? (int)trim($line[$col['rank']])
                : $maxRank + $imported + 1;

            $ck = 0;
            if (isset($col['coaches_kid'])) {
                $v  = strtolower(trim($line[$col['coaches_kid']]));
                $ck = in_array($v, ['1','yes','true','y'], true) ? 1 : 0;
            }
            $isPitcher = 0;
            if (isset($col['pitcher'])) {
                $v = strtolower(trim($line[$col['pitcher']]));
                $isPitcher = in_array($v, ['1','yes','true','y','p'], true) ? 1 : 0;
            }
            $isCatcher = 0;
            if (isset($col['catcher'])) {
                $v = strtolower(trim($line[$col['catcher']]));
                $isCatcher = in_array($v, ['1','yes','true','y','c'], true) ? 1 : 0;
            }
            $stmt->execute([
                $draftId, $name, $rank,
                isset($col['position']) ? (trim($line[$col['position']]) ?: null) : null,
                $ck,
                isset($col['age']) ? ((int)trim($line[$col['age']]) ?: null) : null,
                isset($col['notes']) ? (trim($line[$col['notes']]) ?: null) : null,
                $isPitcher,
                $isCatcher,
            ]);
            $imported++;
        }
        $db->commit();
        fclose($handle);
        jsonResponse(['imported' => $imported, 'errors' => $errors]);

    } elseif ($action === 'clear_all') {
        requireAdmin();
        $draftId = contextDraftId($db);
        $db->prepare('DELETE FROM players WHERE draft_id=?')->execute([$draftId]);
        jsonResponse(['success' => true]);

    } else {
        jsonError('Unknown action', 404);
    }

} catch (PDOException $e) {
    error_log('EasyDraft players error: ' . $e->getMessage());
    jsonError('A server error occurred', 500);
}
