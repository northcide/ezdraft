<?php
/**
 * ezDraft Full Diagnostics — run once, then delete.
 * Access: https://yourdomain.com/api/diag.php?key=checkme
 */
if (($_GET['key'] ?? '') !== 'checkme') { http_response_code(403); exit('Forbidden'); }

header('Content-Type: text/plain');

$pass = 0; $warn = 0; $fail = 0;

function ok(string $msg)   { global $pass; $pass++; echo "  [OK]   $msg\n"; }
function warn(string $msg) { global $warn; $warn++; echo "  [WARN] $msg\n"; }
function fail(string $msg) { global $fail; $fail++; echo "  [FAIL] $msg\n"; }

// ── 1. PHP environment ────────────────────────────────────────────────────────
echo "=== PHP ENVIRONMENT ===\n";
$ver = PHP_VERSION;
version_compare($ver, '8.0', '>=') ? ok("PHP $ver") : fail("PHP $ver — need 8.0+");
extension_loaded('pdo')       ? ok("PDO loaded")       : fail("PDO not loaded");
extension_loaded('pdo_mysql') ? ok("pdo_mysql loaded") : fail("pdo_mysql not loaded");
extension_loaded('mbstring')  ? ok("mbstring loaded")  : warn("mbstring not loaded (may affect UTF-8)");
extension_loaded('openssl')   ? ok("openssl loaded")   : warn("openssl not loaded (needed for random_bytes)");
function_exists('random_bytes') ? ok("random_bytes() available") : fail("random_bytes() not available");

$sessionDir = session_save_path() ?: sys_get_temp_dir();
is_writable($sessionDir) ? ok("Session dir writable: $sessionDir") : fail("Session dir not writable: $sessionDir");
is_writable(sys_get_temp_dir()) ? ok("Temp dir writable (rate-limit files): " . sys_get_temp_dir())
                                : warn("Temp dir not writable: " . sys_get_temp_dir());

// ── 2. Config & DB connection ─────────────────────────────────────────────────
echo "\n=== DATABASE CONNECTION ===\n";
if (!file_exists(__DIR__ . '/config.php')) { fail("config.php missing — run setup.php"); exit; }
require_once __DIR__ . '/config.php';
ok("config.php found");
foreach (['DB_HOST','DB_NAME','DB_USER','DB_PASS'] as $c) {
    defined($c) ? ok("$c defined") : fail("$c not defined in config.php");
}

try {
    $pdo = new PDO(
        'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
        DB_USER, DB_PASS,
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
    );
    ok("DB connection successful");
    $row = $pdo->query("SELECT VERSION() AS v")->fetch();
    ok("MySQL version: " . $row['v']);
    $charset = $pdo->query("SELECT @@character_set_database AS c")->fetch()['c'];
    $charset === 'utf8mb4' ? ok("DB charset: utf8mb4") : warn("DB charset: $charset (expected utf8mb4)");
} catch (PDOException $e) {
    fail("DB connection failed: " . $e->getMessage());
    exit;
}

// ── 3. Schema columns ─────────────────────────────────────────────────────────
echo "\n=== SCHEMA COLUMNS ===\n";
$expected = [
    'drafts' => [
        'id','name','status','total_rounds','timer_minutes','auto_pick_enabled',
        'current_pick_num','timer_end','timer_remaining_seconds','started_at',
        'completed_at','archived','coach_name','coach_pin','coach_mode',
        'coach_login_token','coach_token_expires_at','draft_type','created_at','updated_at',
    ],
    'players' => [
        'id','draft_id','name','rank','position','is_coaches_kid',
        'age','is_pitcher','is_catcher','notes','created_at',
    ],
    'teams' => [
        'id','draft_id','name','draft_order','pin',
        'login_token','token_expires_at','created_at',
    ],
    'picks' => [
        'id','draft_id','round','pick_num','team_id','player_id',
        'is_pre_assigned','is_auto_pick','skipped','picked_at','created_at',
    ],
    'settings' => ['key','value','updated_at'],
];

$actual = [];
foreach ($pdo->query("SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION")->fetchAll() as $r) {
    $actual[$r['TABLE_NAME']][] = $r['COLUMN_NAME'];
}

$anyMissing = false;
foreach ($expected as $table => $cols) {
    if (!isset($actual[$table])) {
        fail("Table '$table' does not exist");
        $anyMissing = true;
        continue;
    }
    $existing = $actual[$table];
    foreach ($cols as $col) {
        if (!in_array($col, $existing)) {
            fail("$table.$col missing");
            $anyMissing = true;
        } else {
            ok("$table.$col");
        }
    }
}
if (!$anyMissing) ok("All expected columns present");

// ── 4. Indexes ────────────────────────────────────────────────────────────────
echo "\n=== INDEXES ===\n";
$expectedIndexes = [
    'drafts'  => ['PRIMARY','idx_coach_token'],
    'players' => ['PRIMARY','idx_draft_rank'],
    'teams'   => ['PRIMARY','idx_draft_order','idx_team_token'],
    'picks'   => ['PRIMARY','unique_draft_pick','unique_draft_player','idx_draft_id','idx_player_id'],
];
$actualIndexes = [];
foreach ($pdo->query("SELECT TABLE_NAME, INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() GROUP BY TABLE_NAME, INDEX_NAME")->fetchAll() as $r) {
    $actualIndexes[$r['TABLE_NAME']][] = $r['INDEX_NAME'];
}
foreach ($expectedIndexes as $table => $idxs) {
    foreach ($idxs as $idx) {
        if (in_array($idx, $actualIndexes[$table] ?? [])) {
            ok("$table: index '$idx'");
        } else {
            warn("$table: index '$idx' missing (non-critical but recommended)");
        }
    }
}

// ── 5. Settings table ─────────────────────────────────────────────────────────
echo "\n=== SETTINGS ===\n";
$settings = $pdo->query("SELECT `key`, value FROM settings")->fetchAll(PDO::FETCH_KEY_PAIR);
isset($settings['admin_pin']) && $settings['admin_pin']
    ? ok("admin_pin set (" . (str_starts_with($settings['admin_pin'], '$2y$') ? 'bcrypt' : 'plaintext — consider rehashing') . ")")
    : fail("admin_pin missing from settings table");
isset($settings['league_name'])
    ? ok("league_name: " . $settings['league_name'])
    : warn("league_name not set");

// ── 6. Data integrity ─────────────────────────────────────────────────────────
echo "\n=== DATA INTEGRITY ===\n";

// Orphaned picks (team or draft missing)
$r = $pdo->query("SELECT COUNT(*) FROM picks p LEFT JOIN drafts d ON p.draft_id=d.id WHERE d.id IS NULL")->fetchColumn();
(int)$r === 0 ? ok("No orphaned picks (missing draft)") : fail("$r picks reference non-existent drafts");

$r = $pdo->query("SELECT COUNT(*) FROM picks p LEFT JOIN teams t ON p.team_id=t.id WHERE t.id IS NULL")->fetchColumn();
(int)$r === 0 ? ok("No orphaned picks (missing team)") : fail("$r picks reference non-existent teams");

// Players in picks that don't exist
$r = $pdo->query("SELECT COUNT(*) FROM picks p LEFT JOIN players pl ON p.player_id=pl.id WHERE p.player_id IS NOT NULL AND pl.id IS NULL")->fetchColumn();
(int)$r === 0 ? ok("No orphaned picks (missing player)") : warn("$r picks reference non-existent players");

// Duplicate pick_num per draft
$r = $pdo->query("SELECT COUNT(*) FROM (SELECT draft_id, pick_num, COUNT(*) c FROM picks GROUP BY draft_id, pick_num HAVING c > 1) x")->fetchColumn();
(int)$r === 0 ? ok("No duplicate pick_num within any draft") : fail("$r duplicate pick_num entries found");

// Duplicate player_id per draft (excluding NULLs)
$r = $pdo->query("SELECT COUNT(*) FROM (SELECT draft_id, player_id, COUNT(*) c FROM picks WHERE player_id IS NOT NULL GROUP BY draft_id, player_id HAVING c > 1) x")->fetchColumn();
(int)$r === 0 ? ok("No duplicate player picks within any draft") : fail("$r players picked more than once in the same draft");

// Teams with no draft_order set
$r = $pdo->query("SELECT COUNT(*) FROM teams WHERE draft_order IS NULL OR draft_order < 1")->fetchColumn();
(int)$r === 0 ? ok("All teams have valid draft_order") : warn("$r teams missing draft_order");

// Active drafts
$drafts = $pdo->query("SELECT id, name, status, current_pick_num, total_rounds FROM drafts WHERE archived=0 ORDER BY id")->fetchAll();
$activeDrafts = array_filter($drafts, fn($d) => $d['status'] === 'active');
count($activeDrafts) <= 1 ? ok(count($activeDrafts) . " active draft(s)") : warn(count($activeDrafts) . " active drafts simultaneously (unusual)");

foreach ($activeDrafts as $d) {
    $pickCount = (int)$pdo->prepare("SELECT COUNT(*) FROM picks WHERE draft_id=?")->execute([$d['id']]) ?
        $pdo->query("SELECT COUNT(*) FROM picks WHERE draft_id=" . (int)$d['id'])->fetchColumn() : 0;
    $stmt = $pdo->prepare("SELECT COUNT(*) FROM picks WHERE draft_id=?");
    $stmt->execute([$d['id']]);
    $pickCount = (int)$stmt->fetchColumn();
    $pickCount > 0 ? ok("Draft '{$d['name']}' has $pickCount pick slots")
                   : warn("Active draft '{$d['name']}' has no pick slots — run setup");
    if ($d['current_pick_num'] > $pickCount && $pickCount > 0) {
        warn("Draft '{$d['name']}' current_pick_num ({$d['current_pick_num']}) exceeds pick count ($pickCount)");
    }
}

// ── 7. Summary ────────────────────────────────────────────────────────────────
echo "\n=== SUMMARY ===\n";
echo "  PASS: $pass\n";
echo "  WARN: $warn\n";
echo "  FAIL: $fail\n";
if ($fail === 0 && $warn === 0) echo "\nAll checks passed. Delete this file.\n";
elseif ($fail === 0) echo "\nNo failures, but review warnings above. Delete this file when done.\n";
else echo "\nFix failures before using in production. Delete this file when done.\n";
