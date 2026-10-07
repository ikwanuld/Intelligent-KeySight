<?php
// POST /sync: the only way scan data enters the database.
//
// Rules (see docs/API.md):
//   1. Idempotent: an op_id seen before returns its earlier outcome.
//   2. Unknown record -> insert, server_rev = 1.
//   3. Events are append-only.
//   4. base_rev must equal the current server_rev to update.
//   5. Otherwise it is a CONFLICT: nothing is overwritten, both versions are
//      kept in sync_conflicts for admin review.
//   6. Records that can never be accepted are REJECTED with a reason.
// Device timestamps are stored exactly as sent; received_at is the server clock.

const SESSION_STATUS = ['DRAFT', 'IN_PROGRESS', 'COMPLETED', 'AUTO_COMPLETED'];
const SCAN_STATE = ['PENDING', 'CONFIRMED', 'REJECTED', 'AUTO_SAVED'];

function sessionColumns(array $d): array
{
    return [
        'session_reference' => nstr($d['session_reference'] ?? '', 40),
        'created_by' => nstr($d['created_by'] ?? '', 64),
        'resumed_by' => nstr($d['resumed_by'] ?? null, 64),
        'station_id' => $d['station_id'] ?? '', 'station_code' => nstr($d['station_code'] ?? '', 8),
        'zone_id' => $d['zone_id'] ?? '', 'zone_name' => nstr($d['zone_name'] ?? '', 100),
        'day' => preg_match('/^\d{4}-\d{2}-\d{2}$/', $d['day'] ?? '') ? $d['day'] : gmdate('Y-m-d'),
        'started_at' => dt($d['started_at'] ?? null) ?? gmdate('Y-m-d H:i:s'),
        'completed_at' => dt($d['completed_at'] ?? null),
        'completed_by' => nstr($d['completed_by'] ?? null, 64),
        'last_activity_at' => dt($d['last_activity_at'] ?? null) ?? gmdate('Y-m-d H:i:s'),
        'status' => enum($d['status'] ?? null, SESSION_STATUS, 'IN_PROGRESS'),
        'completion_type' => enum($d['completion_type'] ?? null, ['MANUAL', 'AUTO']),
        'device_id' => nstr($d['device_id'] ?? '', 36),
        'duplicates_count' => (int)($d['counters']['duplicates'] ?? 0),
        'multi_scans_count' => (int)($d['counters']['multi_scans'] ?? 0),
        'config_version' => nint($d['config_version'] ?? null),
        'rev' => (int)($d['rev'] ?? 1),
        'data' => jenc($d),
    ];
}

function scanColumns(array $d): array
{
    $c = $d['confidence'] ?? [];
    $e = $d['env'] ?? [];
    $t = $d['timing'] ?? [];
    $pct = fn($v) => $v === null ? null : max(0, min(100, (int)round($v)));
    return [
        'session_id' => $d['session_id'] ?? '',
        'state' => enum($d['state'] ?? null, SCAN_STATE, 'PENDING'),
        'uld_number' => nstr($d['uld_number'] ?? null, 16),
        'value' => nstr($d['value'] ?? '', 16),
        'raw_ocr' => nstr($d['raw_ocr'] ?? null, 16),
        'manual_input' => nstr($d['manual_input'] ?? null, 16),
        'suggested_correction' => nstr($d['suggested_correction'] ?? null, 16),
        'correction_accepted' => isset($d['correction_accepted']) ? b($d['correction_accepted']) : null,
        'final_value' => nstr($d['final_value'] ?? null, 16),
        'category' => enum($d['category'] ?? null, ['CONTAINER', 'PALLET', 'OTHER']),
        'prefix' => nstr($d['prefix'] ?? null, 3),
        'operational' => b($d['operational'] ?? false),
        'validation_status' => enum($d['validation_status'] ?? null, ['VALID', 'NEEDS_REVIEW', 'INVALID'], 'INVALID'),
        'review_reasons' => jenc($d['review_reasons'] ?? null),
        'confidence_status' => enum($d['confidence_status'] ?? null, ['HIGH', 'REVIEW', 'UNCERTAIN']),
        'rule_id' => nstr($d['rule_id'] ?? null, 36), 'rule_version' => nint($d['rule_version'] ?? null),
        'manually_added' => b($d['manually_added'] ?? false), 'manually_corrected' => b($d['manually_corrected'] ?? false),
        'confirmed' => b($d['confirmed'] ?? false), 'review_acknowledged' => b($d['review_acknowledged'] ?? false),
        'confirmed_by' => nstr($d['confirmed_by'] ?? null, 64), 'confirmed_at' => dt($d['confirmed_at'] ?? null),
        'image_reference' => nstr($d['image_reference'] ?? null, 36),
        'source' => enum($d['source'] ?? null, ['SINGLE', 'MULTI', 'MANUAL'], 'SINGLE'),
        'engine' => nstr($d['engine'] ?? null, 32), 'cloud_fallback' => b($d['cloud_fallback'] ?? false),
        'overall_confidence' => $pct($c['overall'] ?? null), 'min_confidence' => $pct($c['min'] ?? null),
        'character_confidence' => jenc($c['characters'] ?? null),
        'detection_confidence' => $pct($c['detection'] ?? null), 'image_quality' => $pct($c['image_quality'] ?? null),
        'lighting' => enum($e['lighting'] ?? null, ['VERY_LOW_LIGHT', 'LOW_LIGHT', 'GOOD', 'BRIGHT', 'GLARE']),
        'env' => jenc($d['env'] ?? null),
        'first_seen_at' => dt($t['first_seen_at'] ?? null), 'shown_at' => dt($t['shown_at'] ?? null),
        'ocr_ms' => nint($t['ocr_ms'] ?? null), 'frames' => nint($t['frames'] ?? null),
        'flags' => jenc($d['flags'] ?? null),
        'history' => jenc($d['history'] ?? []),
        'created_by' => nstr($d['created_by'] ?? '', 64),
        'created_at' => dt($d['created_at'] ?? null) ?? gmdate('Y-m-d H:i:s'),
        'updated_at' => dt($d['updated_at'] ?? null) ?? gmdate('Y-m-d H:i:s'),
        'rev' => (int)($d['rev'] ?? 1),
        'data' => jenc($d),
    ];
}

function insertRow(string $table, array $cols): void
{
    $names = array_keys($cols);
    q("INSERT INTO $table (" . implode(',', $names) . ') VALUES (' . implode(',', array_fill(0, count($names), '?')) . ')', array_values($cols));
}
function updateRow(string $table, string $pk, string $id, array $cols): void
{
    $set = implode(',', array_map(fn($n) => "$n = ?", array_keys($cols)));
    q("UPDATE $table SET $set, server_rev = server_rev + 1 WHERE $pk = ?", [...array_values($cols), $id]);
}

class Reject extends Exception {}

/** Insert / update / conflict for a session or scan row. */
function applyRecord(string $entity, string $table, string $pk, string $id, array $cols, $baseRev, array $user, string $deviceId): array
{
    $cur = q("SELECT server_rev, data FROM $table WHERE $pk = ? FOR UPDATE", [$id])->fetch();
    if (!$cur) {
        insertRow($table, [$pk => $id] + $cols);
        return ['status' => 'applied', 'server_rev' => 1];
    }
    if ($baseRev !== null && (int)$baseRev === (int)$cur['server_rev']) {
        updateRow($table, $pk, $id, $cols);
        return ['status' => 'applied', 'server_rev' => (int)$cur['server_rev'] + 1];
    }
    // Changed elsewhere since this device last saw it: keep both versions.
    q('INSERT INTO sync_conflicts (entity, entity_id, device_id, user_id, base_rev, server_rev, incoming_data, current_data) VALUES (?,?,?,?,?,?,?,?)',
        [$entity, $id, $deviceId, $user['user_id'], $baseRev, (int)$cur['server_rev'], $cols['data'], $cur['data']]);
    return ['status' => 'conflict', 'server_rev' => (int)$cur['server_rev'], 'server_data' => json_decode($cur['data'], true)];
}

function applySession(string $id, array $d, $baseRev, array $user, string $deviceId): array
{
    $cols = sessionColumns($d);
    if (!in_array($cols['station_id'], $user['authorized_station_ids'], true)) throw new Reject('station not authorized for this user');
    if (!q('SELECT 1 FROM zones WHERE zone_id = ? AND station_id = ?', [$cols['zone_id'], $cols['station_id']])->fetch()) throw new Reject('unknown zone for this station');
    $r = applyRecord('session', 'scan_sessions', 'session_id', $id, $cols, $baseRev, $user, $deviceId);
    if ($r['status'] === 'applied' && is_array($d['device'] ?? null)) {
        $v = $d['device'];
        q('REPLACE INTO device_analytics (session_id, device_id, device_model, os, os_version, browser, browser_version, camera_resolution, screen_resolution, performance_class, avg_ocr_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)', [$id, $cols['device_id'], nstr($v['device_model'] ?? null, 80), nstr($v['os'] ?? null, 20), nstr($v['os_version'] ?? null, 20),
            nstr($v['browser'] ?? null, 30), nstr($v['browser_version'] ?? null, 30), nstr($v['camera_resolution'] ?? null, 16), nstr($v['screen_resolution'] ?? null, 16),
            enum($v['performance_class'] ?? null, ['STANDARD', 'LIMITED']), nint($v['avg_ocr_ms'] ?? null)]);
    }
    return $r;
}

function sessionStation(string $sessionId): ?string
{
    $s = q('SELECT station_id FROM scan_sessions WHERE session_id = ?', [$sessionId])->fetchColumn();
    return $s === false ? null : $s;
}

function applyScan(string $id, array $d, $baseRev, array $user, string $deviceId): array
{
    $cols = scanColumns($d);
    $station = sessionStation($cols['session_id']);
    if ($station === null) throw new Reject('unknown session');
    if (!in_array($station, $user['authorized_station_ids'], true)) throw new Reject('station not authorized for this user');
    if ($cols['value'] === '') throw new Reject('empty ULD number');
    // An invalid ULD can never be a confirmed record, whatever the device says.
    if (in_array($cols['state'], ['CONFIRMED', 'AUTO_SAVED'], true)) {
        if (!uldFormatValid($cols['final_value'] ?? $cols['value'], $cols['rule_id'], $cols['rule_version'], $cols['created_at'])) {
            throw new Reject('ULD number does not match the validation rule');
        }
    }
    $r = applyRecord('scan', 'scan_records', 'scan_id', $id, $cols, $baseRev, $user, $deviceId);
    if ($r['status'] === 'applied') {
        q('DELETE FROM ocr_observations WHERE scan_id = ?', [$id]);
        foreach (array_slice($d['ocr_observations'] ?? [], 0, 10) as $o) {
            q('INSERT INTO ocr_observations (scan_id, raw_text, frames, overall_confidence, character_confidence, source) VALUES (?,?,?,?,?,?)',
                [$id, nstr($o['raw_text'] ?? '', 24), (int)($o['frames'] ?? 1), nint($o['overall_confidence'] ?? null),
                 jenc($o['character_confidence'] ?? null), nstr($o['source'] ?? 'local', 16)]);
        }
    }
    return $r;
}

function applyEvent(string $id, array $d, array $user): array
{
    if (q('SELECT 1 FROM session_events WHERE event_id = ?', [$id])->fetch()) return ['status' => 'duplicate', 'server_rev' => 1];
    $sid = $d['session_id'] ?? '';
    $station = sessionStation($sid);
    if ($station === null) throw new Reject('unknown session');
    if (!in_array($station, $user['authorized_station_ids'], true)) throw new Reject('station not authorized for this user');
    q('INSERT INTO session_events (event_id, session_id, type, user_id, at, detail, data) VALUES (?,?,?,?,?,?,?)',
        [$id, $sid, nstr($d['type'] ?? '', 40), nstr($d['user_id'] ?? $user['user_id'], 64), dt($d['at'] ?? null) ?? gmdate('Y-m-d H:i:s'),
         jenc($d['detail'] ?? null), jenc($d)]);
    return ['status' => 'applied', 'server_rev' => 1];
}

function handleSync(array $user)
{
    $in = body();
    $deviceId = nstr($in['device_id'] ?? '', 36);
    $ops = $in['ops'] ?? null;
    if (!is_array($ops)) throw new ApiException(400, 'BAD_REQUEST', 'ops must be a list');
    if (count($ops) > 200) throw new ApiException(413, 'TOO_MANY_OPS');
    $uuid = '/^[0-9a-fA-F-]{8,36}$/';
    $results = [];

    foreach ($ops as $op) {
        $opId = (string)($op['op_id'] ?? '');
        $entity = $op['entity'] ?? '';
        $id = (string)($op['entity_id'] ?? '');
        $data = $op['data'] ?? null;
        if ($opId === '' || strlen($opId) > 100 || !preg_match($uuid, $id) || !is_array($data) || !in_array($entity, ['session', 'scan', 'event'], true)) {
            $results[] = ['op_id' => $opId, 'status' => 'rejected', 'reason' => 'malformed op'];
            continue;
        }
        $pdo = db();
        $pdo->beginTransaction();
        try {
            $seen = q('SELECT status, server_rev FROM sync_ops WHERE op_id = ? FOR UPDATE', [$opId])->fetch();
            if ($seen) {
                $pdo->commit();
                $results[] = ['op_id' => $opId, 'status' => $seen['status'] === 'applied' ? 'duplicate' : $seen['status'],
                    'server_rev' => $seen['server_rev'] !== null ? (int)$seen['server_rev'] : null];
                continue;
            }
            try {
                $r = match ($entity) {
                    'session' => applySession($id, $data, $op['base_rev'] ?? null, $user, $deviceId),
                    'scan' => applyScan($id, $data, $op['base_rev'] ?? null, $user, $deviceId),
                    'event' => applyEvent($id, $data, $user),
                };
            } catch (Reject $e) {
                $r = ['status' => 'rejected', 'reason' => $e->getMessage()];
            }
            q('INSERT INTO sync_ops (op_id, device_id, user_id, status, server_rev) VALUES (?,?,?,?,?)',
                [$opId, $deviceId, $user['user_id'], $r['status'] === 'duplicate' ? 'applied' : $r['status'], $r['server_rev'] ?? null]);
            $pdo->commit();
            $results[] = ['op_id' => $opId] + $r;
        } catch (Throwable $e) {
            // Unexpected failure for this op only: undo it and leave it
            // unacknowledged so the device retries later. Other ops carry on.
            if ($pdo->inTransaction()) $pdo->rollBack();
            error_log('uld sync op failed: ' . $opId . ' ' . $e->getMessage());
        }
    }
    respond(200, ['results' => $results]);
}
