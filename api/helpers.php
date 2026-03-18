<?php
// ── CORS + JSON headers ───────────────────────────────────────────────────────
header('Content-Type: application/json');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: SAMEORIGIN');
header('X-XSS-Protection: 1; mode=block');

// Restrict CORS to specific allowed origins only
$allowedOrigins = ['https://draft.jirc.com'];
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, $allowedOrigins, true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, X-CSRF-Token');
}
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') exit(0);

// ── Session ───────────────────────────────────────────────────────────────────
if (session_status() === PHP_SESSION_NONE) {
    session_name('easydraft_session');
    $lifetime = 8 * 60 * 60; // 8 hours
    ini_set('session.gc_maxlifetime', $lifetime);
    session_set_cookie_params([
        'lifetime' => $lifetime,
        'path'     => '/',
        'secure'   => isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
    if (empty($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }
}

// ── Database ──────────────────────────────────────────────────────────────────
if (!file_exists(__DIR__ . '/config.php')) {
    http_response_code(503);
    echo json_encode(['error' => 'Database not configured. Run setup.php first.']);
    exit;
}
require_once __DIR__ . '/config.php';

function getDB(): PDO {
    static $pdo = null;
    if ($pdo === null) {
        $pdo = new PDO(
            'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
            DB_USER, DB_PASS,
            [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
            ]
        );
    }
    return $pdo;
}

// ── CSRF ──────────────────────────────────────────────────────────────────────
function validateCsrf(): void {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') return;
    $token = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    if (empty($_SESSION['csrf_token']) || !hash_equals($_SESSION['csrf_token'], $token)) {
        jsonError('Invalid or missing CSRF token', 403);
    }
}

// ── Rate limiting (file-based, per IP) ────────────────────────────────────────
function _rlFile(string $ip): string {
    return sys_get_temp_dir() . '/easydraft_rl_' . md5($ip) . '.json';
}

function checkRateLimit(string $ip): void {
    $file = _rlFile($ip);
    $data = file_exists($file) ? json_decode(file_get_contents($file), true) : null;
    if (!$data || time() > ($data['reset'] ?? 0)) return;
    if (($data['count'] ?? 0) >= 10) {
        jsonError('Too many login attempts. Please try again later.', 429);
    }
}

function recordFailedLogin(string $ip): void {
    $file = _rlFile($ip);
    $data = file_exists($file) ? json_decode(file_get_contents($file), true) : null;
    if (!$data || time() > ($data['reset'] ?? 0)) {
        $data = ['count' => 0, 'reset' => time() + 300];
    }
    $data['count']++;
    file_put_contents($file, json_encode($data), LOCK_EX);
}

function clearRateLimit(string $ip): void {
    $file = _rlFile($ip);
    if (file_exists($file)) unlink($file);
}

// ── PIN helpers ───────────────────────────────────────────────────────────────
function verifyPin(string $input, string $stored): bool {
    if (str_starts_with($stored, '$2y$') || str_starts_with($stored, '$2a$')) {
        return password_verify($input, $stored);
    }
    // Legacy plaintext — constant-time compare
    return hash_equals($stored, $input);
}

function hashPin(string $pin): string {
    return password_hash($pin, PASSWORD_DEFAULT);
}

function rehashPinIfNeeded(PDO $db, string $pin, string $stored, string $table, string $col, string $whereCol, mixed $whereVal): void {
    if (!str_starts_with($stored, '$2y$') && !str_starts_with($stored, '$2a$')) {
        $db->prepare("UPDATE `$table` SET `$col`=? WHERE `$whereCol`=?")
           ->execute([hashPin($pin), $whereVal]);
    }
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
function currentRole(): string {
    return $_SESSION['role'] ?? '';
}

function requireAuth(): void {
    if (empty($_SESSION['role'])) {
        jsonError('Not authenticated', 401);
    }
    validateCsrf();
}

function requireAdmin(): void {
    if (($_SESSION['role'] ?? '') !== 'admin') {
        jsonError('Admin access required', 403);
    }
    validateCsrf();
}

// ── Draft context ─────────────────────────────────────────────────────────────
function contextDraftId(PDO $db): int {
    $role = currentRole();

    if ($role === 'admin' && !empty($_SESSION['selected_draft_id'])) {
        return (int)$_SESSION['selected_draft_id'];
    }

    if (in_array($role, ['coach', 'team']) && !empty($_SESSION['selected_draft_id'])) {
        $accessible = array_map('intval', $_SESSION['accessible_draft_ids'] ?? []);
        $sel = (int)$_SESSION['selected_draft_id'];
        if (in_array($sel, $accessible, true)) {
            return $sel;
        }
    }

    // Fallback: live draft
    $stmt = $db->query("SELECT id FROM drafts WHERE status IN ('active','paused') ORDER BY updated_at DESC LIMIT 1");
    $row = $stmt->fetch();
    if ($row) {
        if (in_array($role, ['coach', 'team'])) {
            $accessible = array_map('intval', $_SESSION['accessible_draft_ids'] ?? []);
            if (!in_array((int)$row['id'], $accessible, true)) {
                jsonError('No accessible draft is currently live', 403);
            }
        }
        return (int)$row['id'];
    }

    jsonError('No draft selected or active. Please select a draft.', 400);
}

// ── Response helpers ──────────────────────────────────────────────────────────
function jsonResponse(mixed $data, int $status = 200): void {
    http_response_code($status);
    echo json_encode($data);
    exit;
}

function jsonError(string $message, int $status = 400): void {
    jsonResponse(['error' => $message], $status);
}

function getInput(): array {
    $raw = file_get_contents('php://input');
    return json_decode($raw, true) ?? [];
}

function getAction(): string {
    return $_GET['action'] ?? $_POST['action'] ?? '';
}

function nowUtc(): string {
    return (new DateTime('now', new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s\Z');
}
