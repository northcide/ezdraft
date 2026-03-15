<?php
// ── CORS + JSON headers ───────────────────────────────────────────────────────
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') exit(0);

// ── Session ───────────────────────────────────────────────────────────────────
if (session_status() === PHP_SESSION_NONE) {
    session_name('easydraft_session');
    session_start();
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

// ── Auth helpers ──────────────────────────────────────────────────────────────
function currentRole(): string {
    return $_SESSION['role'] ?? '';
}

function requireAuth(): void {
    if (empty($_SESSION['role'])) {
        jsonError('Not authenticated', 401);
    }
}

function requireAdmin(): void {
    if (($_SESSION['role'] ?? '') !== 'admin') {
        jsonError('Admin access required', 403);
    }
}

// ── Draft context ─────────────────────────────────────────────────────────────
function contextDraftId(PDO $db): int {
    $role = currentRole();

    if ($role === 'admin' && !empty($_SESSION['selected_draft_id'])) {
        return (int)$_SESSION['selected_draft_id'];
    }

    if ($role === 'coach' && !empty($_SESSION['selected_draft_id'])) {
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
        if ($role === 'coach') {
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
