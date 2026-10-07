<?php
// Sign-in.
//
// PILOT MODE: the staff member types a work e-mail and the server checks
//   company domain -> admin whitelist (users table) -> station access.
// There is no password and the address is not verified, so anyone who knows a
// whitelisted address could sign in as that person. This is acceptable for a
// supervised pilot only. Google / Microsoft sign-in replaces this endpoint
// later; the users, stations and tokens tables stay exactly as they are.

function authEmail()
{
    $in = body();
    $email = strtolower(trim((string)($in['email'] ?? '')));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) throw new ApiException(400, 'BAD_EMAIL');

    $domains = array_map('strtolower', cfg('company_domains') ?: []);
    $domain = substr(strrchr($email, '@'), 1);
    if ($domains && !in_array($domain, $domains, true)) throw new ApiException(403, 'DOMAIN_NOT_ALLOWED');

    $u = q('SELECT * FROM users WHERE email = ?', [$email])->fetch();

    // First sign-in of a bootstrap admin: create the account with every station.
    if (!$u && in_array($email, array_map('strtolower', cfg('bootstrap_admins') ?: []), true)) {
        $id = 'u-' . bin2hex(random_bytes(8));
        $first = q('SELECT station_id FROM stations WHERE active = 1 ORDER BY station_code LIMIT 1')->fetchColumn() ?: null;
        q("INSERT INTO users (user_id, email, name, role, rule_manager, default_station_id) VALUES (?, ?, ?, 'ADMIN', 1, ?)",
            [$id, $email, ucwords(str_replace(['.', '_'], ' ', strstr($email, '@', true))), $first]);
        q('INSERT INTO user_stations (user_id, station_id) SELECT ?, station_id FROM stations WHERE active = 1', [$id]);
        audit($id, 'USER_BOOTSTRAPPED', 'user', $id, null, ['email' => $email, 'role' => 'ADMIN']);
        $u = q('SELECT * FROM users WHERE user_id = ?', [$id])->fetch();
    }

    if (!$u || !$u['active']) throw new ApiException(403, 'NOT_WHITELISTED');
    $payload = userPayload($u);
    if (!$payload['authorized_station_ids']) throw new ApiException(403, 'NO_STATION');

    respond(200, ['token' => issueToken($u['user_id'], $in['device_id'] ?? null), 'user' => $payload]);
}

function authLogout()
{
    $t = bearerToken();
    if ($t) q('UPDATE auth_tokens SET revoked_at = UTC_TIMESTAMP(3) WHERE token_hash = ?', [hash('sha256', $t)]);
    respond(200, ['ok' => true]);
}
