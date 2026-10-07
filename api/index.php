<?php
// ULD Scanner API entry point. Requires PHP 8.0+ with pdo_mysql.
//
// Works two ways, so it runs on any host:
//   https://host/api/index.php/sync     (always works)
//   https://host/api/sync               (when .htaccess rewriting is available)

declare(strict_types=1);
require __DIR__ . '/src/lib.php';
require __DIR__ . '/src/auth.php';
require __DIR__ . '/src/config.php';
require __DIR__ . '/src/sync.php';
require __DIR__ . '/src/sessions.php';

try {
    // ---- CORS: only the scanner's own web address may call this API ----
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin !== '' && in_array(rtrim($origin, '/'), array_map(fn($o) => rtrim($o, '/'), cfg('allowed_origins') ?: []), true)) {
        header("Access-Control-Allow-Origin: $origin");
        header('Vary: Origin');
        header('Access-Control-Allow-Headers: Authorization, Content-Type, X-Auth-Token');
        header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
        header('Access-Control-Max-Age: 86400');
    }
    $method = $_SERVER['REQUEST_METHOD'];
    if ($method === 'OPTIONS') { http_response_code(204); exit; }

    $path = $_SERVER['PATH_INFO'] ?? '';
    if ($path === '') {   // rewritten URL without PATH_INFO
        $uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
        $base = rtrim(dirname($_SERVER['SCRIPT_NAME']), '/');
        $path = substr($uri, strlen($base));
        $path = preg_replace('#^/index\.php#', '', $path);
    }
    $path = '/' . trim($path, '/');
    $route = "$method $path";

    if ($route === 'GET /') respond(200, ['service' => 'uld-scanner-api', 'ok' => true]);
    if ($route === 'GET /health') { db()->query('SELECT 1 FROM stations LIMIT 1'); respond(200, ['ok' => true, 'database' => 'connected']); }
    if ($route === 'POST /auth/email') authEmail();
    if ($route === 'POST /auth/logout') authLogout();

    $user = requireUser();
    if ($route === 'GET /auth/me') respond(200, ['user' => $user]);
    if ($route === 'GET /config') respond(200, buildConfig($user));
    if ($route === 'POST /sync') handleSync($user);
    if ($route === 'POST /images') uploadImage($user);
    if ($route === 'GET /sessions') listOpenSessions($user);
    if ($method === 'GET' && preg_match('#^/sessions/([0-9a-fA-F-]{8,36})$#', $path, $m)) getSession($user, $m[1]);
    if ($route === 'POST /ocr') throw new ApiException(501, 'CLOUD_OCR_NOT_CONFIGURED');

    throw new ApiException(404, 'NOT_FOUND');
} catch (ApiException $e) {
    respond($e->status, ['error' => ['code' => $e->errorCode, 'message' => $e->getMessage()]]);
} catch (Throwable $e) {
    error_log('uld api: ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine());
    $dbDown = $e instanceof PDOException;
    respond($dbDown ? 503 : 500, ['error' => ['code' => $dbDown ? 'DATABASE_UNAVAILABLE' : 'SERVER_ERROR', 'message' => 'See the server error log']]);
}
