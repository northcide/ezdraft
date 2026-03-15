<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit(0);
}

// ── JSON File Storage ─────────────────────────────────────────────────────────

define('DB_FILE', __DIR__ . '/../data/db.json');

function dbLoad(): array {
    if (!file_exists(DB_FILE)) {
        return ['players' => [], 'teams' => [], 'draft' => null, 'picks' => []];
    }
    $data = json_decode(file_get_contents(DB_FILE), true);
    return $data ?? ['players' => [], 'teams' => [], 'draft' => null, 'picks' => []];
}

function dbSave(array $data): void {
    $dir = dirname(DB_FILE);
    if (!is_dir($dir)) {
        if (!mkdir($dir, 0755, true) && !is_dir($dir)) {
            throw new RuntimeException("Cannot create data directory: $dir");
        }
    }
    if (!is_writable($dir)) {
        throw new RuntimeException("Data directory is not writable: $dir — run: sudo chown www-data:www-data $dir");
    }
    $result = file_put_contents(DB_FILE, json_encode($data, JSON_PRETTY_PRINT), LOCK_EX);
    if ($result === false) {
        throw new RuntimeException("Failed to write data file: " . DB_FILE);
    }
}

function nextId(array $rows): int {
    if (empty($rows)) return 1;
    return max(array_column($rows, 'id')) + 1;
}

function nowUtc(): string {
    return (new DateTime('now', new DateTimeZone('UTC')))->format('Y-m-d H:i:s');
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

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
