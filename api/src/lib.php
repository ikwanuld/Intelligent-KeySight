<?php
// Shared helpers: database, JSON responses, time, authentication.

class ApiException extends Exception
{
    public function __construct(public int $status, public string $errorCode, string $message = '')
    {
        parent::__construct($message ?: $errorCode);
    }
}

function cfg(?string $key = null)
{
    static $c = null;
    if ($c === null) {
        $file = getenv('ULD_CONFIG') ?: __DIR__ . '/../config.php';   // ULD_CONFIG is for automated tests
        if (!is_file($file)) throw new ApiException(500, 'NOT_CONFIGURED', 'Copy config.sample.php to config.php');
        $c = require $file;
    }
    return $key === null ? $c : ($c[$key] ?? null);
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo === null) {
        $d = cfg('db');
        $dsn = sprintf('mysql:host=%s;%sdbname=%s;charset=utf8mb4', $d['host'], isset($d['port']) ? "port={$d['port']};" : '', $d['name']);
        $pdo = new PDO($dsn, $d['user'], $d['pass'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
        $pdo->exec("SET time_zone = '+00:00'");   // everything is stored in UTC
    }
    return $pdo;
}

function q(string $sql, array $params = []): PDOStatement
{
    $st = db()->prepare($sql);
    $st->execute($params);
    return $st;
}

function respond(int $status, $body)
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function body(): array
{
    $raw = file_get_contents('php://input');
    $j = json_decode($raw ?: '{}', true);
    if (!is_array($j)) throw new ApiException(400, 'BAD_JSON', 'Request body is not valid JSON');
    return $j;
}

/** ISO 8601 from the device -> UTC 'Y-m-d H:i:s.v' for DATETIME(3). The instant is never changed. */
function dt($iso): ?string
{
    if ($iso === null || $iso === '') return null;
    try {
        $d = new DateTimeImmutable((string)$iso);
    } catch (Exception $e) {
        return null;
    }
    return $d->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s.v');
}

/** UTC DATETIME from the database -> ISO 8601 for the app. */
function iso(?string $dbTime): ?string
{
    if ($dbTime === null) return null;
    return (new DateTimeImmutable($dbTime, new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z');
}

function jenc($v): ?string
{
    return $v === null ? null : json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}
function b($v): int { return $v ? 1 : 0; }
function nint($v): ?int { return $v === null || $v === '' ? null : (int)$v; }
function nstr($v, int $max): ?string { return $v === null ? null : mb_substr((string)$v, 0, $max); }
function enum($v, array $allowed, $default = null) { return in_array($v, $allowed, true) ? $v : $default; }

// ------------------------------------------------------------------ auth --

function bearerToken(): ?string
{
    $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if (!$h && function_exists('getallheaders')) {
        foreach (getallheaders() as $k => $v) if (strcasecmp($k, 'Authorization') === 0) $h = $v;
    }
    if (preg_match('/^Bearer\s+(\S+)$/i', $h, $m)) return $m[1];
    // Fallback for hosts that strip the Authorization header entirely.
    return $_SERVER['HTTP_X_AUTH_TOKEN'] ?? null;
}

function userPayload(array $u): array
{
    $stations = q('SELECT us.station_id FROM user_stations us JOIN stations s ON s.station_id = us.station_id
                   WHERE us.user_id = ? AND s.active = 1 ORDER BY s.station_code', [$u['user_id']])->fetchAll(PDO::FETCH_COLUMN);
    $default = in_array($u['default_station_id'], $stations, true) ? $u['default_station_id'] : ($stations[0] ?? null);
    return [
        'user_id' => $u['user_id'], 'email' => $u['email'], 'name' => $u['name'], 'role' => $u['role'],
        'rule_manager' => (bool)$u['rule_manager'], 'default_station_id' => $default,
        'authorized_station_ids' => $stations,
    ];
}

/** The signed-in user, or a 401. Access is re-checked on every request. */
function requireUser(): array
{
    $t = bearerToken();
    if (!$t) throw new ApiException(401, 'UNAUTHENTICATED');
    $row = q('SELECT u.* FROM auth_tokens t JOIN users u ON u.user_id = t.user_id
              WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > UTC_TIMESTAMP(3)', [hash('sha256', $t)])->fetch();
    if (!$row) throw new ApiException(401, 'UNAUTHENTICATED');
    if (!$row['active']) throw new ApiException(403, 'NOT_WHITELISTED');
    $u = userPayload($row);
    if (!$u['authorized_station_ids']) throw new ApiException(403, 'NO_STATION');
    return $u;
}

function issueToken(string $userId, ?string $deviceId): string
{
    $token = bin2hex(random_bytes(32));
    q('INSERT INTO auth_tokens (token_hash, user_id, device_id, expires_at) VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? DAY))',
        [hash('sha256', $token), $userId, nstr($deviceId, 36), (int)(cfg('token_days') ?: 30)]);
    return $token;
}

function audit(string $userId, string $action, string $entity, string $entityId, $old = null, $new = null): void
{
    q('INSERT INTO audit_log (user_id, action, entity, entity_id, old_value, new_value) VALUES (?,?,?,?,?,?)',
        [$userId, $action, $entity, $entityId, jenc($old), jenc($new)]);
}
