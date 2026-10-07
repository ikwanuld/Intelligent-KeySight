# ULD Scanner backend API (v0.1 contract)

The PWA talks to the backend only through these endpoints. A future native
Android/iOS app uses the same ones. The PHP + MySQL implementation is in `api/` (setup: `api/README.md`).
`tests/mock-api.mjs` is an in-memory version of the same contract used by the
browser tests.

- Base URL: set `API_BASE` in `js/config.js` (e.g. `https://host/api`).
- JSON in, JSON out. Timestamps are ISO 8601 UTC, generated on the device.
- Auth: `Authorization: Bearer <token>` on everything except the `/auth/*/start`
  redirect and `/auth/exchange`.
- Errors: HTTP status + `{ "error": { "code": "…", "message": "…" } }`.
  `401` makes the app ask for a fresh sign-in; queued data stays on the device.
- If the app is served from a different origin than the API, send CORS headers
  for that origin (`Authorization`, `Content-Type`).

## Authentication

**Pilot mode (what `api/` implements today):** `POST /auth/email` `{ email, device_id }` →
`{ token, user }`, or `403` with `DOMAIN_NOT_ALLOWED`, `NOT_WHITELISTED` or `NO_STATION`.
No password and no verification of the address; see `api/README.md`. The redirect
flow below is the target design and is not implemented in `api/` yet.

Sign-in is a server-side redirect flow, so no client secret or identity
library lives in the app.

| | |
|---|---|
| `GET /auth/google/start?return_to=<app url>` | Redirect to Google. |
| `GET /auth/microsoft/start?return_to=<app url>` | Redirect to Microsoft. |

On the provider callback the server checks, in this order:

1. e-mail domain is a company domain, else `DOMAIN_NOT_ALLOWED`
2. user is on the admin whitelist and active, else `NOT_WHITELISTED`
3. user has at least one authorized station, else `NO_STATION`

then redirects to `return_to#login_code=<one-time code>` or
`return_to#login_error=<CODE>`. Validate `return_to` against an allow-list.

`POST /auth/exchange` `{ code, device_id }` →

```json
{ "token": "…", "user": { "user_id": "…", "email": "…", "name": "…",
  "role": "STAFF", "rule_manager": false,
  "default_station_id": "stn-kul", "authorized_station_ids": ["stn-kul","stn-pen"] } }
```

`GET /auth/me` → `{ user }` (re-checked on every app start; `401/403` signs the device out).
`POST /auth/logout`.

## Configuration

`GET /config` → everything the scanner needs to work offline. Same shape as
`js/core/defaults.js`:

`config_version`, `thresholds {high, review}`, `tracking`, `queue {overflowThreshold}`,
`images {retentionDays}`, `cloudOcr {enabled}`, `scanModes[]` (Containers /
Pallets: `{mode, label, category, pipeline, active}`), `prefixes[]`
(`operational` = counted when scanned in the mode of its category), `operatorCodes[]`,
`validationRules[]` (all versions that are or will become effective, each with
`rule_version`, `effective_from`, `effective_until`), `correctionRules[]`,
`stations[]` with their `zones[]` (only stations the user is authorized for;
include inactive zones with `active:false` so history can still name them).

The app caches the last copy and keeps using it offline.

## Sync

`POST /sync`

```json
{ "device_id": "…",
  "ops": [ { "op_id": "scan:<uuid>:<rev>", "entity": "session|scan|event",
             "entity_id": "<uuid>", "base_rev": 3, "data": { … } } ] }
```

→ `{ "results": [ { "op_id": "…", "status": "applied|duplicate|conflict|rejected",
"server_rev": 4, "server_data": { … }, "reason": "…" } ] }`

Rules the server must follow (per op, in order):

1. **Idempotent.** An `op_id` seen before returns its earlier result with
   status `duplicate`. Devices retry freely.
2. **New record** (`entity_id` unknown): insert, `server_rev = 1`, `applied`.
3. **Events are immutable.** A known `event_id` is `duplicate`.
4. **Revision check.** `base_rev == current server_rev` → update,
   `server_rev + 1`, `applied`.
5. **Otherwise it is a conflict.** Do not overwrite. Store the incoming version
   next to the current one in `sync_conflicts`, flag for admin review, return
   `conflict` with the current `server_rev` and `server_data`.
6. `rejected` (with `reason`) is for records that can never be accepted, e.g.
   a scan for a station the user is not authorized for. The device keeps the
   record and stops retrying that version.

Also on the server: re-validate each confirmed scan against the rule version
named in the record (`rule_id`, `rule_version`); never re-judge history when
rules change; never replace device timestamps with the receive time (store the
receive time separately).

Record shapes are whatever the device sends in `data`; the columns in
`docs/schema.sql` list every field. Fields worth knowing:

- scan `state`: `PENDING | CONFIRMED | REJECTED | AUTO_SAVED` (`AUTO_SAVED` =
  recognised ULD of the kind that was NOT being scanned at that moment, e.g.
  a pallet seen in Containers mode: stored silently, not counted; it becomes
  `PENDING` if it is later scanned in its own mode)
- scan `category`: `CONTAINER | PALLET | OTHER`. Counted containers are
  `CONFIRMED` + `operational` + `CONTAINER`; counted pallets the same with `PALLET`
- scan `pipeline`: `container | pallet` (which reader produced it), `engine`:
  `tesseract | paddle | …`
- scan `flags.review[]`: reasons for a second look that come from how the
  number was read (rivet next to it, read differently in another frame, at
  the edge of the picture); `flags.unreadable`: the reader gave up and the
  value is only a starting point for typing
- scan `validation_status`: `VALID | NEEDS_REVIEW | INVALID`;
  `confidence_status`: `HIGH | REVIEW | UNCERTAIN`
- scan `history[]`: `DETECTED, REJECTED, EDITED, SUGGESTION_ACCEPTED,
  SUGGESTION_KEPT_ORIGINAL, CONFIRMED, CONFIRMED_AFTER_REJECT, ADDED_MANUALLY`
- scan `ocr_observations[]` → `OCR_OBSERVATIONS` rows
- session `status`: `DRAFT | IN_PROGRESS | COMPLETED | AUTO_COMPLETED`;
  `device` → `DEVICE_ANALYTICS`; `counters.duplicates` is the aggregate
  duplicate count (duplicate attempts are not individual records)
- event `type`: `SESSION_STARTED, SESSION_PAUSED, SESSION_UNPAUSED,
  SESSION_RESUMED, STAFF_TAKEOVER, SESSION_COMPLETED, SESSION_AUTO_COMPLETED,
  SCAN_MODE_CHANGED`

## Images

`POST /images` (multipart): `image_reference`, `scan_id`, `session_id`,
`captured_at`, `file` (JPEG crop, a few KB). Store the file in private object
storage, keep only `image_reference` in the database, delete after
`images.retentionDays`. No public URLs; admins fetch through an authenticated
endpoint. Only problem scans ever arrive here; clean confident scans upload nothing.

## Sessions (resume on another device)

`GET /sessions?station_id=&day=YYYY-MM-DD&open=1` → `{ sessions: [ … ] }`
open (`DRAFT`/`IN_PROGRESS`) sessions for a station the caller is authorized for.

`GET /sessions/{id}` → `{ session, scans, events }`, each record with its
current `server_rev`.

Server-side day-end job: once a day, mark sessions still open from an earlier
calendar day as `AUTO_COMPLETED` (devices do the same locally, but a lost
phone never will).

## Cloud OCR fallback

`POST /ocr` (multipart `file` = cropped ULD-number JPEG) →

```json
{ "engine": "provider-name",
  "symbols": [ { "ch": "A", "conf": 93, "bbox": { "x0": 10, "y0": 10, "x1": 34, "y1": 50 } } ] }
```

The backend proxies to whichever provider is selected after the benchmark.
The app only calls this when `cloudOcr.enabled` is true, the device is online,
and local OCR produced an unreadable ULD-like result; it sends the crop once.

In `api/` today: everything above except the OAuth redirect and `POST /ocr`
(returns `501`). The day-end job and image purge are `api/cron.php`.

## Not in this contract yet

Admin endpoints (users, whitelist, stations, zones, rules with versioning,
thresholds, retention), analytics queries, conflict resolution, and delivery
of a resolved conflict back to the device.
