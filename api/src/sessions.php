<?php
// Sessions for resume on another device, and evidence image upload.

function withRev(array $row): array
{
    $d = json_decode($row['data'], true) ?: [];
    $d['server_rev'] = (int)($row['server_rev'] ?? 1);
    return $d;
}

function listOpenSessions(array $user)
{
    $station = (string)($_GET['station_id'] ?? '');
    $day = (string)($_GET['day'] ?? '');
    if (!in_array($station, $user['authorized_station_ids'], true)) throw new ApiException(403, 'STATION_NOT_AUTHORIZED');
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $day)) throw new ApiException(400, 'BAD_REQUEST', 'day must be YYYY-MM-DD');
    $rows = q("SELECT s.data, s.server_rev, u.name AS created_by_name FROM scan_sessions s LEFT JOIN users u ON u.user_id = s.created_by
               WHERE s.station_id = ? AND s.day = ? AND s.status IN ('DRAFT','IN_PROGRESS') ORDER BY s.started_at DESC", [$station, $day])->fetchAll();
    respond(200, ['sessions' => array_map(fn($r) => withRev($r) + ['created_by_name' => $r['created_by_name']], $rows)]);
}

function getSession(array $user, string $id)
{
    $s = q('SELECT data, server_rev, station_id FROM scan_sessions WHERE session_id = ?', [$id])->fetch();
    if (!$s) throw new ApiException(404, 'NOT_FOUND');
    if (!in_array($s['station_id'], $user['authorized_station_ids'], true)) throw new ApiException(403, 'STATION_NOT_AUTHORIZED');
    respond(200, [
        'session' => withRev($s),
        'scans' => array_map('withRev', q('SELECT data, server_rev FROM scan_records WHERE session_id = ? ORDER BY created_at', [$id])->fetchAll()),
        'events' => array_map('withRev', q('SELECT data, 1 AS server_rev FROM session_events WHERE session_id = ? ORDER BY at', [$id])->fetchAll()),
    ]);
}

/** POST /images: one small JPEG crop of a ULD number, for problem scans only. */
function uploadImage(array $user)
{
    $ref = (string)($_POST['image_reference'] ?? '');
    $scanId = (string)($_POST['scan_id'] ?? '');
    $sessionId = (string)($_POST['session_id'] ?? '');
    if (!preg_match('/^[0-9a-fA-F-]{8,36}$/', $ref)) throw new ApiException(400, 'BAD_REQUEST', 'image_reference');
    $station = sessionStation($sessionId);
    if ($station === null) throw new ApiException(409, 'UNKNOWN_SESSION');   // device retries after its data sync
    if (!in_array($station, $user['authorized_station_ids'], true)) throw new ApiException(403, 'STATION_NOT_AUTHORIZED');
    if (q('SELECT 1 FROM images WHERE image_reference = ?', [$ref])->fetch()) respond(200, ['image_reference' => $ref]); // already stored

    $f = $_FILES['file'] ?? null;
    if (!$f || $f['error'] !== UPLOAD_ERR_OK) throw new ApiException(400, 'BAD_REQUEST', 'file missing');
    if ($f['size'] > 400 * 1024) throw new ApiException(413, 'IMAGE_TOO_LARGE', 'Only small crops are accepted, never full frames');
    $info = @getimagesize($f['tmp_name']);
    if (!$info || $info[2] !== IMAGETYPE_JPEG) throw new ApiException(415, 'NOT_A_JPEG');

    $captured = dt($_POST['captured_at'] ?? null) ?? gmdate('Y-m-d H:i:s');
    $days = (int)(json_decode(q("SELECT setting_value FROM app_settings WHERE setting_key = 'images'")->fetchColumn() ?: '{}', true)['retentionDays'] ?? 30);
    $key = substr($captured, 0, 7) . '/' . $ref . '.jpg';             // e.g. 2026-10/<uuid>.jpg
    $dir = __DIR__ . '/../storage/images/' . dirname($key);
    if (!is_dir($dir) && !mkdir($dir, 0750, true)) throw new ApiException(500, 'STORAGE_UNAVAILABLE');
    if (!move_uploaded_file($f['tmp_name'], __DIR__ . '/../storage/images/' . $key)) throw new ApiException(500, 'STORAGE_UNAVAILABLE');
    q('INSERT INTO images (image_reference, scan_id, session_id, storage_key, bytes, captured_at, expires_at) VALUES (?,?,?,?,?,?, DATE_ADD(?, INTERVAL ? DAY))',
        [$ref, nstr($scanId, 36), $sessionId, $key, (int)$f['size'], $captured, $captured, max(1, $days)]);
    respond(200, ['image_reference' => $ref]);
}
