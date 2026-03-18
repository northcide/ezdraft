<?php
/**
 * ezDraft Schema Checker — run once, then delete.
 * Access via browser: https://yourdomain.com/api/check_schema.php?key=checkme
 */
if (($_GET['key'] ?? '') !== 'checkme') { http_response_code(403); exit('Forbidden'); }

require_once __DIR__ . '/config.php';
$pdo = new PDO(
    'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
    DB_USER, DB_PASS,
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
);

// Expected schema: table => [column => definition_hint]
$expected = [
    'drafts' => [
        'id'                      => 'INT AUTO_INCREMENT PK',
        'name'                    => 'VARCHAR(255)',
        'status'                  => "ENUM('setup','active','paused','completed')",
        'total_rounds'            => 'INT',
        'timer_minutes'           => 'INT',
        'auto_pick_enabled'       => 'TINYINT(1)',
        'current_pick_num'        => 'INT',
        'timer_end'               => 'DATETIME',
        'timer_remaining_seconds' => 'INT',
        'started_at'              => 'DATETIME',
        'completed_at'            => 'DATETIME',
        'archived'                => 'TINYINT(1)',
        'coach_name'              => 'VARCHAR(255)',
        'coach_pin'               => 'VARCHAR(255)',
        'coach_mode'              => "ENUM('shared','team')",
        'coach_login_token'       => 'CHAR(64)',
        'coach_token_expires_at'  => 'DATETIME',
        'created_at'              => 'TIMESTAMP',
        'updated_at'              => 'TIMESTAMP',
    ],
    'players' => [
        'id'             => 'INT AUTO_INCREMENT PK',
        'draft_id'       => 'INT',
        'name'           => 'VARCHAR(255)',
        'rank'           => 'INT',
        'position'       => 'VARCHAR(50)',
        'is_coaches_kid' => 'TINYINT(1)',
        'age'            => 'INT',
        'is_pitcher'     => 'TINYINT(1)',
        'is_catcher'     => 'TINYINT(1)',
        'notes'          => 'TEXT',
        'created_at'     => 'TIMESTAMP',
    ],
    'teams' => [
        'id'              => 'INT AUTO_INCREMENT PK',
        'draft_id'        => 'INT',
        'name'            => 'VARCHAR(255)',
        'draft_order'     => 'INT',
        'pin'             => 'VARCHAR(255)',
        'login_token'     => 'CHAR(64)',
        'token_expires_at'=> 'DATETIME',
        'created_at'      => 'TIMESTAMP',
    ],
    'picks' => [
        'id'             => 'INT AUTO_INCREMENT PK',
        'draft_id'       => 'INT',
        'round'          => 'INT',
        'pick_num'       => 'INT',
        'team_id'        => 'INT',
        'player_id'      => 'INT',
        'is_pre_assigned'=> 'TINYINT(1)',
        'is_auto_pick'   => 'TINYINT(1)',
        'skipped'        => 'TINYINT(1)',
        'picked_at'      => 'DATETIME',
        'created_at'     => 'TIMESTAMP',
    ],
    'settings' => [
        'key'        => 'VARCHAR(100) PK',
        'value'      => 'TEXT',
        'updated_at' => 'TIMESTAMP',
    ],
];

// Fetch actual columns from DB
$actual = [];
$stmt = $pdo->query("
    SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
    ORDER BY TABLE_NAME, ORDINAL_POSITION
");
foreach ($stmt->fetchAll() as $row) {
    $actual[$row['TABLE_NAME']][$row['COLUMN_NAME']] = $row['COLUMN_TYPE'];
}

$missing = [];
$extra   = [];
foreach ($expected as $table => $cols) {
    if (!isset($actual[$table])) {
        $missing[$table] = array_keys($cols);
        continue;
    }
    foreach ($cols as $col => $hint) {
        if (!isset($actual[$table][$col])) {
            $missing[$table][] = $col;
        }
    }
    foreach (array_keys($actual[$table]) as $col) {
        if (!isset($cols[$col])) {
            $extra[$table][] = $col;
        }
    }
}

header('Content-Type: text/plain');
$ok = true;

if ($missing) {
    $ok = false;
    echo "=== MISSING COLUMNS (need ALTER TABLE) ===\n\n";
    foreach ($missing as $table => $cols) {
        foreach ($cols as $col) {
            echo "  Table '$table' is missing column '$col'\n";
        }
    }
    echo "\n--- Suggested ALTER statements ---\n";
    $alters = [
        'drafts' => [
            'archived'               => "ADD COLUMN archived TINYINT(1) NOT NULL DEFAULT 0",
            'coach_login_token'      => "ADD COLUMN coach_login_token CHAR(64) DEFAULT NULL",
            'coach_token_expires_at' => "ADD COLUMN coach_token_expires_at DATETIME DEFAULT NULL",
        ],
        'players' => [
            'age'        => "ADD COLUMN age INT DEFAULT NULL",
            'is_pitcher' => "ADD COLUMN is_pitcher TINYINT(1) NOT NULL DEFAULT 0",
            'is_catcher' => "ADD COLUMN is_catcher TINYINT(1) NOT NULL DEFAULT 0",
            'notes'      => "ADD COLUMN notes TEXT DEFAULT NULL",
        ],
        'teams' => [
            'pin'              => "ADD COLUMN pin VARCHAR(255) NULL",
            'login_token'      => "ADD COLUMN login_token CHAR(64) DEFAULT NULL",
            'token_expires_at' => "ADD COLUMN token_expires_at DATETIME DEFAULT NULL",
        ],
        'picks' => [
            'is_pre_assigned' => "ADD COLUMN is_pre_assigned TINYINT(1) NOT NULL DEFAULT 0",
            'is_auto_pick'    => "ADD COLUMN is_auto_pick TINYINT(1) NOT NULL DEFAULT 0",
            'skipped'         => "ADD COLUMN skipped TINYINT(1) NOT NULL DEFAULT 0",
            'picked_at'       => "ADD COLUMN picked_at DATETIME DEFAULT NULL",
        ],
    ];
    foreach ($missing as $table => $cols) {
        foreach ($cols as $col) {
            $def = $alters[$table][$col] ?? "ADD COLUMN $col -- (define manually)";
            echo "ALTER TABLE `$table` $def;\n";
        }
    }
    echo "\n";
}

if ($extra) {
    echo "=== EXTRA COLUMNS (in DB but not in schema — usually fine) ===\n";
    foreach ($extra as $table => $cols) {
        echo "  Table '$table': " . implode(', ', $cols) . "\n";
    }
    echo "\n";
}

if ($ok) {
    echo "=== ALL GOOD — every expected column is present ===\n";
}

echo "\n=== ACTUAL TABLE STRUCTURES ===\n";
foreach ($actual as $table => $cols) {
    echo "\n[$table]\n";
    foreach ($cols as $col => $type) {
        $flag = isset($expected[$table]) && !isset($expected[$table][$col]) ? ' (extra)' : '';
        $miss = isset($expected[$table]) && !isset($actual[$table][$col]) ? ' *** MISSING ***' : '';
        echo "  $col: $type$flag\n";
    }
}
