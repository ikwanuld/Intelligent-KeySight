<?php
// Housekeeping. Run once a day, either
//   from a cron job:   php /path/to/api/cron.php
//   or by URL:         https://host/api/cron.php?key=<cron_key from config.php>
//
// 1. Day-end rule: sessions still open two or more calendar days back (UTC)
//    are closed as AUTO_COMPLETED. Devices do this themselves on next launch; this
//    covers phones that never come back. Scan data is not touched.
// 2. Image retention: crops past their expiry are deleted (file and row).
//    Scan records and analytics stay.

declare(strict_types=1);
require __DIR__ . '/src/lib.php';

if (PHP_SAPI !== 'cli') {
    $key = (string)cfg('cron_key');
    if ($key === '' || str_starts_with($key, 'CHANGE_ME') || !hash_equals($key, (string)($_GET['key'] ?? ''))) {
        http_response_code(403); exit('forbidden');
    }
    header('Content-Type: text/plain');
}

$closed = 0;
$rows = q("SELECT session_id, day, data FROM scan_sessions WHERE status IN ('DRAFT','IN_PROGRESS') AND day < DATE_SUB(UTC_DATE(), INTERVAL 1 DAY)")->fetchAll();
foreach ($rows as $r) {
    $end = $r['day'] . ' 23:59:59.999';
    $data = json_decode($r['data'], true) ?: [];
    $data['status'] = 'AUTO_COMPLETED'; $data['completion_type'] = 'AUTO'; $data['completed_at'] = iso($end);
    q("UPDATE scan_sessions SET status = 'AUTO_COMPLETED', completion_type = 'AUTO', completed_at = ?, data = ?, server_rev = server_rev + 1 WHERE session_id = ?",
        [$end, jenc($data), $r['session_id']]);
    q('INSERT INTO session_events (event_id, session_id, type, user_id, at, detail, data) VALUES (?,?,?,?,?,?,?)',
        [bin2hex(random_bytes(16)), $r['session_id'], 'SESSION_AUTO_COMPLETED', 'system', $end, jenc(['by' => 'server']), jenc(['type' => 'SESSION_AUTO_COMPLETED', 'by' => 'server'])]);
    $closed++;
}

$purged = 0;
foreach (q('SELECT image_reference, storage_key FROM images WHERE expires_at < UTC_TIMESTAMP() LIMIT 2000')->fetchAll() as $img) {
    $file = __DIR__ . '/storage/images/' . $img['storage_key'];
    if (is_file($file)) @unlink($file);
    q('DELETE FROM images WHERE image_reference = ?', [$img['image_reference']]);
    q('UPDATE scan_records SET image_reference = NULL WHERE image_reference = ?', [$img['image_reference']]);
    $purged++;
}
q('DELETE FROM auth_tokens WHERE expires_at < UTC_TIMESTAMP() OR revoked_at IS NOT NULL');
echo "sessions auto-completed: $closed\nimages purged: $purged\n";
