# ULD Scanner — v0.4 (scanner PWA, with Pallets mode)

Camera-first ULD counting. Point the phone at the number, confirm with a
swipe, move on. Works with no network; syncs when it can.

Two scan modes, switched on the scanner screen:

- **Containers** (AKE / AAY / AKH): stencilled numbers on container panels.
- **Pallets** (PAG / PAJ / PMC / PKC / PLA): the small ID plate on the pallet
  edge. New in 0.4, with its own reader. See [Pallets mode](#pallets-mode).

This repo holds the **scanner PWA** and two optional backends: PHP + MySQL
(`api/`, guide in `api/README.md`) and Google Sheets (`sheets/`). The admin
dashboard is not built yet.

## Try it

It is a static site: no build step, no npm install.

```
node tests/serve.mjs 8766        # then open http://localhost:8766
```

On a phone the page must be served over **HTTPS** (browsers only give camera
access to secure origins; `localhost` is the one exception). Any static host
works: your PHP hosting, GitHub Pages, etc. Upload the folder as it is.

Out of the box it runs in **demo mode** (`API_BASE` empty in `js/config.js`):
everything is stored on the device only, the header says "On this device only",
and sign-in is an unverified e-mail prompt. That is enough to judge scanning on
real containers and pallets.

After changing any file, run `node tools/update-sw.mjs` so installed phones
pick up the new version.

## Pallets mode

### Using it

1. On the scanner screen tap **Pallets**. The first time, the pallet reader is
   downloaded (about 30 MB, once; the pill over the camera picture shows the progress). After
   that it is on the phone and works with no signal. By default the download
   already starts in the background after sign-in (`PALLET_PREFETCH` in
   `js/config.js`).
2. Point at the ID plate. The plate may be upright, sideways or upside down,
   and there may be several in the picture (a stack).
3. A card comes up for each number, exactly as for containers: swipe right or
   **Confirm**, swipe left or **Reject**, **Edit** to type.
4. **Multi-scan** takes every plate in view from one deliberate snap (it reads
   two frames a moment apart and compares them).

A ULD of the other kind that passes through the picture (a container while
scanning pallets, or the other way round) is stored silently as "Other ULD"
and not counted, as before. If it is later scanned in its own mode, that same
record comes up for confirmation.

### How it reads, and what it will not do

`find text lines (any angle) -> join the pieces of one plate -> read ->
read the other way up -> look further along the line if a group is missing ->
second look with stretched contrast -> lay the three groups (type, serial,
owner) over the characters using the configured rules -> follow each plate
from frame to frame`

The reader is built so that a wrong number does not look like a right one:

| What the reader got | What staff see |
|---|---|
| Every character sure, known type and owner code, nothing odd | **High confidence**, after one frame |
| Good but not rock solid | Card only after two frames read the same |
| A weak character (below 85), a character the reader nearly took for another one ("3, but 15 % says 2"), a rivet next to the number, plate at the picture edge, unknown type or owner code, two frames disagreeing | **Needs review**, with the reason and **the photo of the plate on the card** |
| A known type code read one letter off (PMS for PMC) | The reading plus "Did you mean PMC…?"; never applied silently |
| Not readable (digit scraped off, too far, too blurred) | **Uncertain or invalid**, photo on the card, **Edit** to type; cannot be confirmed as it stands |

Two rules worth knowing:

- **A rivet is never turned into a zero.** Rivets through the plate read as
  "O" or "0". On a damaged plate that would produce a number of the right
  length that is wrong, so a round shape next to the serial is only ever
  skipped, never counted as a digit.
- **Two doubts together are not offered at all** (e.g. a character to change
  *and* an unknown owner code). That is shown as unreadable.

### Measured on the 18 reference photos

`node tests/pallet-eval.mjs --limit 736 --out /tmp/annotated`

| | Result |
|---|---|
| Clear plates | 18 of 18 read |
| Hard plates (embossed same-colour, engraved, upside down, tilted, purple outline font) | 6 of 6 read |
| Shown as high confidence / shown for review | 17 / 7 (embossed plate, scratched letter, three with one less-than-sure character, rivet, two at the picture edge) |
| Damaged plate (one digit scraped off) | not guessed: shown for typing |
| Blurred second plate in two photos | one not found; one shown for review as "PNC…, type code may be misread (PMC or PKC?)" |
| **Wrong number shown as a confident result** | **0** |
| Before (the container reader on the same photos) | 2 of 27 read, 4 wrong numbers accepted |

The most fragile plate is the embossed same-colour one (`p-004`): it is read
at some picture sizes and shown for typing at others.

`node tests/pallet-stress.mjs` makes the same photos worse on purpose: further
away, turned 90 / 180 / 270 degrees, tilted, blurred, dark, over-exposed,
heavily compressed (18 variants, 432 plate readings per run). Run at five
picture sizes (2160 readings): **91-93 % read, 0 wrong numbers shown as
confident, about 2 % wrong numbers shown for review** (mostly the damaged
plate and the embossed one). About 8 in 10 of the numbers read come out as
high confidence; the rest ask for a look. Over-exposure and a 30-degree tilt
are the weakest conditions (about 70-80 % read).

Where the wrong numbers came from: before the confidence rules were tightened,
every wrong number that looked flawless (9 of them in those 2160 readings) was
the embossed plate with one digit misread ("63621" or "53631" for "63631").
All nine had a weakest character below 85 and a rival character of 15 % or
more, which is where the two limits in `js/pallet/candidate.js` come from.
They are set on this one plate, so treat embossed and same-colour plates as
the place to look first when testing on real pallets.

### What has NOT been verified

- **Real phones.** Everything above ran on a server and in headless Chrome
  with the photos played as a fake camera. Nothing has been tried on an
  Android or iOS device yet.
- **Live video.** The photos are sharp stills. A hand-held phone adds motion
  blur and focus hunting; expect lower read rates until tuned on real footage.
- **Speed on a phone.** In desktop Chrome on a 2.1 GHz server core one pass
  (find + read one plate) takes about 0.5 s on one thread and 0.35 s on two.
  A mid-range phone is likely 2-3 times slower. The scanner adapts the picture
  size to the phone and keeps plates across slow passes (tested with
  artificial 3-second passes), but how it *feels* is unknown.
- **Memory.** The pallet reader needs roughly 300-400 MB while it works. Only
  one reader (containers or pallets) is kept in memory at a time; on a phone
  with very little RAM the browser may still close the page.
- **18 photos is a small sample**, from a handful of operators. Other fonts,
  colours and plate layouts will behave differently.

**Recommended next step:** an hour with a real phone on real pallets. Note
which plates fail and send photos of those; `tests/pallet-photos/` plus
`ground-truth.json` is the regression set, so every new photo makes the next
change safer.

### Settings

| Where | What |
|---|---|
| `js/core/defaults.js` | pallet type codes, known owner codes (`operatorCodes`, currently those seen on the photos: R7, R9, C6, TG, EK, TRA), validation rules incl. the two for 3-letter owner codes |
| `js/config.js` | `PALLET_PREFETCH`, `PALLET_THREADS` |
| `sw.js` | `ISOLATE`: lets the reader use several processor threads (about 1.5x faster on two). Works by adding two security headers from the service worker; from the second start of the app. If anything misbehaves, set it to `false` and run `node tools/update-sw.mjs` |
| `js/pallet/reader.js` | `DEFAULTS`: confidence levels, how many lines per frame |
| `js/pallet/candidate.js` | when a number counts as high confidence / needs two frames |
| `js/scanner/pallet-pipeline.js` | picture sizes, how long a place is remembered |
| `vendor/paddle/README.md` | the text models and how to swap them |

## What is in this cut

| Area | State |
|---|---|
| Continuous single scan, no capture button; Multi-Scan snap | built |
| Scan modes: Containers / Pallets, each with its own reading pipeline, shared queue and storage | built |
| Containers: text-region detection, tracking, Tesseract WASM (offline) | built |
| Pallets: PP-OCRv6 detection + recognition on ONNX Runtime Web in a worker (offline after first download), any orientation, several plates per frame | built |
| Live guidance (distance, steadiness, light, glare, angle), never blocking | built |
| Cloud OCR fallback hook (crop only, off by default; containers only) | built, needs a provider behind `POST /ocr` |
| Configurable, versioned validation rules; suggestion-only correction | built |
| Duplicate detection (same session, OCR variations) with toast, no queue entry | built |
| Confirmation cards: swipe + buttons, queue, overflow pause/resume, edit, reject + recovery, manual entry; photo of the number on cards that need checking | built |
| ULDs of the kind not being scanned saved silently, not counted; promoted when scanned in their own mode | built |
| Sessions: station/zone, autosave, crash recovery, same-day resume, day-end auto-complete, summary before completion | built |
| Copy ULD list / download CSV (containers and pallets) | built |
| Offline-first storage (IndexedDB), background sync, conflict preservation | built, tested against the mock API |
| Daily activity view (containers, pallets, per zone, other ULDs, per session) | built (per device) |
| Image minimisation: crop only, only for problem scans | built |
| PHP + MySQL backend; Google Sheets backend | built; both updated for pallets (see their READMEs for upgrading an existing database / sheet) |
| Sign-in | pilot e-mail + whitelist + station check (no password); Google / Microsoft not built |

## Not built yet

- **Admin / Rule Manager screens and the analytics dashboard.** The scanner
  already consumes rules, prefixes, thresholds, stations and zones as data
  (`GET /config`), so nothing in the app needs to change when they exist.
- **Container OCR benchmark on real photos.** The container reader has only
  been tested on computer-drawn text. Given how much better the pallet reader
  does on real plates, trying it on containers too is the obvious experiment
  (`js/pallet/` reads any text line; only the parser is pallet-specific).
- **Torch button** for plates in deep shadow.

## What has and has not been verified

Verified by automated tests in this repo:

| Command | What |
|---|---|
| `npm test` | 64 unit tests: validation, correction, duplicates, tracking, pallet parser / tracker / reader logic, CTC decoding, geometry, Sheets backend |
| `node tests/pallet-eval.mjs` | the pallet reader on the 18 real photos against `ground-truth.json` |
| `node tests/pallet-stress.mjs` | the same photos degraded 18 ways |
| `node tests/pallet-browser.mjs` | the reader in real Chrome (worker + WebAssembly): same answers as Node, timing, nothing downloaded twice |
| `node tests/e2e-pallet.mjs` | 16 end-to-end checks of Pallets mode with the photos as the camera: mode switch, four plates read, damaged plate not guessed, duplicates, records, sync, CSV, offline after restart, a stack via Multi-scan, both kinds in one session, slow phone, first use with no signal |
| `node tests/e2e.mjs` | 28 end-to-end checks of the container flow (sign-in, confirm, suggestions, reject and recovery, manual entry, sync, offline, day-end rule, conflicts, resume, overflow, Multi-scan, unreadable, cloud fallback) |
| `node tests/e2e-php.mjs`, `node tests/e2e-sheets.mjs` | the app against the real PHP + MySQL backend (6 checks, plus 15 API checks in `tests/php-api.mjs`) and an imitation of Apps Script (3 checks) |

To run the browser tests: `python3 tests/make_fixtures.py`,
`sh tests/make_videos.sh /tmp/videos` (needs ffmpeg), start the test server,
then e.g. `VIDEOS=/tmp/videos node tests/e2e-pallet.mjs` (needs Playwright).
The Node pallet tools need `npm i -D onnxruntime-node sharp`. The offline
checks also switch the test server off, because a browser's own "offline"
switch does not stop a service worker from fetching.

Not verified: see [above](#what-has-not-been-verified) for pallets. For
containers: accuracy on real containers and real phones (test images are
computer-drawn text). Also untested: iOS Safari, the real Google/Microsoft
redirect, the Sheets backend on real Google, the midnight rollover while the
scanner is open (the same rule is tested on app start).

## Decisions made where the spec left room

Change any of these if they are wrong for the operation.

1. **Unknown prefix** (structurally valid, prefix not in the table) goes to the
   queue as Needs Review rather than being auto-saved. Only *known* prefixes
   of the other category are saved silently.
2. **Low OCR confidence on a valid number** is Needs Review ("Confirm anyway"),
   not blocked. Only format-invalid and unreadable numbers cannot be confirmed.
3. **Known operator codes** are seeded as AK, D7, FD, QZ, Z2, XJ, MH, R7, R9,
   C6, TG, EK, TRA; anything else is Needs Review. Replace with the real list.
4. **A re-scan of a rejected number** is not re-queued; the toast points to
   Rejected, where it is fixed by editing (the spec's recovery path).
5. **Pending items at completion** are allowed with a warning and are not
   counted; they stay in the record as pending.
6. **Calendar day** is the device's local day.
7. **Scanning covers only what is visible on screen**, not the parts of the
   camera frame cropped away by the layout.
8. **Session reference** is `STATION-YYYYMMDD-<device><nn>`, generated on the
   device so it works offline.
9. **Detection confidence** is stored as null for containers: the classical
   detector has no meaningful probability.
10. **Stations and zones** in `js/core/defaults.js` are placeholders
    (KUL / PEN / JHB taken from the spec's example).
11. **Pallet owner codes** may be 2 characters, or 3 letters with a 4- or
    5-digit serial ("PAJ 0606 TRA"), for pallet types only. Taken from the
    reference photos; adjust the rules if the fleet has other layouts.
12. **Scan mode is remembered per phone**, not per session: a session may hold
    both containers and pallets.
13. **A number typed by hand is counted by what it is**, whichever mode the
    scanner is in.
14. **Unreadable numbers of the other kind are ignored** (an unreadable pallet
    plate while scanning containers raises no card).

## Layout

```
index.html, manifest.webmanifest, sw.js
css/app.css
js/config.js            deployment settings (API_BASE, engines)
js/core/defaults.js     seed configuration (rules, prefixes, scan modes, stations)
js/camera/              rear camera access
js/detection/           container text-region detector, image quality + guidance
js/ocr/                 container OCR: engine interface, Tesseract, cloud fallback, candidates
js/tracking/            container tracker
js/paddle/              text detection + recognition models on ONNX Runtime (no DOM: runs in a worker and in Node)
js/pallet/              pallet reader: line grouping, parser, reader, candidates, tracker, worker, model download
js/scanner/             pipeline.js (containers), pallet-pipeline.js (pallets)
js/validation/          rule engine          js/correction/  suggestions
js/duplicate/           duplicate matching
js/session/             sessions, scans, status labels
js/offline/db.js        IndexedDB            js/sync/        outbox sync
js/api/  js/auth/       backend client, sign-in
js/analytics/           device info
js/ui/                  screens
vendor/                 Tesseract (Apache-2.0), ONNX Runtime Web (MIT), PP-OCRv6 models (Apache-2.0), B612 fonts (OFL)
tools/                  update-sw.mjs (after any change), half_weights.py (model size)
docs/                   API contract
api/  sheets/           optional backends
tests/                  unit, vision and end-to-end tests, mock backend, reference pallet photos
```
