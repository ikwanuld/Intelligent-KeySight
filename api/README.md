# ULD Scanner backend (PHP + MySQL)

Receives scans from the scanner app and records them in MySQL. Needs
**PHP 8.0 or newer** with `pdo_mysql`, and **MySQL 8 or MariaDB 10.4+**. No
Composer, no framework, no command line required.

## Set up (about 15 minutes)

1. **Create the database.** In your hosting panel create a MySQL database and
   a database user with full rights on it. Note the database name, user and
   password.
2. **Create the tables.** Open phpMyAdmin, select the new database, choose
   *Import*, and upload `install.sql`. You should end up with 20 tables.
3. **Upload this `api` folder** to your web space, e.g. so that it is reachable
   at `https://yourhost.com/api/`.
4. **Configure.** Copy `config.sample.php` to `config.php` (same folder) and fill in:
   - `db`: the name, user and password from step 1
   - `allowed_origins`: where the scanner page lives, e.g.
     `https://yourname.github.io` (no trailing slash, no path)
   - `bootstrap_admins`: your own work e-mail
   - `company_domains`: e.g. `['yourcompany.com']`
   - `cron_key`: any long random text
5. **Check it.** Open `https://yourhost.com/api/index.php/health` in a browser.
   You should see `{"ok":true,"database":"connected"}`.
   - `NOT_CONFIGURED`: `config.php` is missing.
   - `DATABASE_UNAVAILABLE`: the name, user or password in `config.php` is wrong.
6. **Point the scanner at it.** In the scanner's `js/config.js` set
   ```js
   export const API_BASE = 'https://yourhost.com/api/index.php';
   ```
   then run `node tools/update-sw.mjs` and push to GitHub as before.
7. **Sign in** on the phone with the e-mail from `bootstrap_admins`. The header
   chip should go from "Sync pending" to "Synced" after the first scan, and the
   rows appear in `scan_sessions` and `scan_records`.
8. **Daily housekeeping (optional but recommended).** In the hosting panel add
   a cron job once a day: `php /path/to/api/cron.php`, or have any scheduler
   open `https://yourhost.com/api/cron.php?key=<cron_key>`.

The scanner page must be HTTPS, so the API must be HTTPS too.

## Adding staff

There is no admin screen yet, so staff are added in phpMyAdmin (SQL tab):

```sql
INSERT INTO users (user_id, email, name, role, default_station_id)
VALUES ('u-ali', 'ali@yourcompany.com', 'Ali', 'STAFF', 'stn-kul');
INSERT INTO user_stations (user_id, station_id) VALUES ('u-ali', 'stn-kul');
```

- More stations for one person: add more `user_stations` rows.
- Remove access: `UPDATE users SET active = 0 WHERE email = '...';` (takes
  effect on their next request).
- Stations and zones: edit the `stations` and `zones` tables. Never delete a
  row that has been used; set `active = 0` instead. The seeded KUL / PEN / JHB
  and their zones are placeholders.

## Sign-in is pilot-grade

Staff type a work e-mail and the server checks domain, whitelist and station
access. **There is no password and the address is not verified**, so anyone
who knows a whitelisted address could sign in as that person. Fine for a
supervised pilot; replace with Google / Microsoft sign-in before wider use.
The tables do not change when that happens.

## Coming from an earlier version (Pallets mode, scanner 0.4)

If the database was created before scanner 0.4, import `upgrade-0.4.sql` once
(phpMyAdmin > *Import*), and upload the new `src/config.php`. It makes pallet
types countable, adds the owner codes R9 / C6 / TG / EK / TRA and the two
rules for pallets with a 3-letter owner code ("PAJ 0606 TRA"). No scan data is
touched. Without it the scanner still reads pallets, but those with a
3-letter owner code are refused as invalid.

## Where the data is

| Table | What |
|---|---|
| `scan_sessions` | one row per session: station, zone, day, start/end, status |
| `scan_records` | one row per ULD: final number, raw OCR, suggestion, flags, confidence, timings, history |
| `ocr_observations` | what the OCR read frame by frame, per scan |
| `session_events` | started / paused / resumed / takeover / completed |
| `device_analytics` | phone model, OS, browser, camera per session |
| `images` + `storage/images/` | crops for problem scans only, deleted after the retention period |
| `sync_conflicts` | both versions when two devices changed the same record |
| `sync_ops` | makes retries safe (each change is applied once) |

Containers and pallets per day, station and zone:

```sql
SELECT s.day, s.station_code, s.zone_name,
       SUM(r.state = 'CONFIRMED' AND r.operational = 1 AND r.category = 'CONTAINER') AS containers,
       SUM(r.state = 'CONFIRMED' AND r.operational = 1 AND r.category = 'PALLET') AS pallets,
       SUM(r.state = 'AUTO_SAVED' OR (r.state = 'CONFIRMED' AND r.operational = 0)) AS other_ulds
FROM scan_sessions s JOIN scan_records r USING (session_id)
GROUP BY s.day, s.station_code, s.zone_name ORDER BY s.day DESC;
```

All times are stored in UTC exactly as the phone recorded them (Malaysia is
UTC+8); `received_at` is when the server got the row.

## Keep private

`config.php` holds the database password: do not put it in a public GitHub
repository. The scanner repo only needs the files outside `api/`. The
`.htaccess` files block direct access to `config.php`, `install.sql`, `src/`
and `storage/` on Apache/LiteSpeed; on nginx add equivalent rules.
