/**
 * ULD Scanner: Google Sheets backend (Apps Script web app).
 *
 * A stop-gap so the scanner can record from phones before a PHP/MySQL host
 * exists. It speaks the same API as the PHP backend, so moving later means
 * changing one line (API_BASE) in the scanner.
 *
 * Set-up: see sheets/README.md. In short: paste this file into
 * Extensions > Apps Script of a new Google Sheet, run setup() once, then
 * Deploy > New deployment > Web app (Execute as: Me, Access: Anyone).
 */

// ------------------------------------------------------------- settings --

var SHEETS = {
  SESSIONS: ['session_id', 'server_rev', 'session_reference', 'station_code', 'zone_name', 'day', 'status', 'started_at',
    'completed_at', 'created_by', 'device_id', 'duplicates', 'device_model', 'device_rev', 'received_at', 'data'],
  SCANS: ['scan_id', 'server_rev', 'session_id', 'station_code', 'zone_name', 'day', 'uld_number', 'value', 'state', 'category',
    'counted_as_container', 'validation_status', 'confidence_status', 'raw_ocr', 'suggested_correction', 'correction_accepted',
    'manually_added', 'manually_corrected', 'source', 'overall_confidence', 'lighting', 'created_at', 'confirmed_at',
    'confirmed_by', 'image_reference', 'device_rev', 'received_at', 'data'],
  EVENTS: ['event_id', 'session_id', 'type', 'user_id', 'at', 'received_at', 'data'],
  USERS: ['email', 'name', 'role', 'default_station', 'stations', 'active'],
  STATIONS: ['station_code', 'station_name', 'active'],
  ZONES: ['station_code', 'zone_name', 'active'],
  CONFIG: ['key', 'value_json'],
  CONFLICTS: ['detected_at', 'entity', 'entity_id', 'user', 'base_rev', 'server_rev', 'incoming_data', 'current_data', 'resolved'],
  IMAGES: ['image_reference', 'scan_id', 'session_id', 'captured_at', 'drive_file_id', 'bytes', 'received_at'],
};

var DEFAULT_CONFIG = {
  config_version: 1,
  thresholds: { high: 90, review: 70 },
  tracking: { minFrames: 2, singleFrameIfHigh: true, invalidMinFrames: 3, trackTtlMs: 1500 },
  queue: { overflowThreshold: 8 },
  images: { retentionDays: 30 },
  cloudOcr: { enabled: false },
  company_domains: [],           // e.g. ["yourcompany.com"]; empty = any domain
  prefixes: [
    { prefix: 'AKE', category: 'CONTAINER', operational: true, active: true },
    { prefix: 'AAY', category: 'CONTAINER', operational: true, active: true },
    { prefix: 'AKH', category: 'CONTAINER', operational: true, active: true },
    { prefix: 'PAG', category: 'PALLET', operational: true, active: true },
    { prefix: 'PAJ', category: 'PALLET', operational: true, active: true },
    { prefix: 'PKC', category: 'PALLET', operational: true, active: true },
    { prefix: 'PMC', category: 'PALLET', operational: true, active: true },
    { prefix: 'PLA', category: 'PALLET', operational: true, active: true },
  ],
  // What staff can switch between on the scanner. Each mode counts one category of ULD.
  scanModes: [
    { mode: 'CONTAINER', label: 'Containers', category: 'CONTAINER', pipeline: 'container', active: true },
    { mode: 'PALLET', label: 'Pallets', category: 'PALLET', pipeline: 'pallet', active: true },
  ],
  operatorCodes: ['AK', 'D7', 'FD', 'QZ', 'Z2', 'XJ', 'MH', 'R7', 'R9', 'C6', 'TG', 'EK', 'TRA'],
  validationRules: [
    { rule_id: 'rule-ai-sv', rule_version: 1, name: 'AI / SV: 4-digit serial', prefixes: '*', prefix_length: 3,
      serial_length: 4, serial_type: 'N', code_length: 2, code_type: 'A', allowed_codes: ['AI', 'SV'], excluded_codes: [],
      priority: 10, active: true, effective_from: '2026-01-01T00:00:00Z', effective_until: null },
    { rule_id: 'rule-standard', rule_version: 1, name: 'Other operators: 5-digit serial', prefixes: '*', prefix_length: 3,
      serial_length: 5, serial_type: 'N', code_length: 2, code_type: 'AN', allowed_codes: null, excluded_codes: ['AI', 'SV'],
      priority: 20, active: true, effective_from: '2026-01-01T00:00:00Z', effective_until: null },
    // Pallets also carry 3-letter owner codes, with 4- or 5-digit serials ("PAJ 0606 TRA").
    { rule_id: 'rule-pallet-owner3-4', rule_version: 1, name: 'Pallet, 3-letter owner: 4-digit serial',
      prefixes: ['PAG', 'PAJ', 'PKC', 'PMC', 'PLA'], prefix_length: 3,
      serial_length: 4, serial_type: 'N', code_length: 3, code_type: 'A', allowed_codes: null, excluded_codes: [],
      priority: 30, active: true, effective_from: '2026-01-01T00:00:00Z', effective_until: null },
    { rule_id: 'rule-pallet-owner3-5', rule_version: 1, name: 'Pallet, 3-letter owner: 5-digit serial',
      prefixes: ['PAG', 'PAJ', 'PKC', 'PMC', 'PLA'], prefix_length: 3,
      serial_length: 5, serial_type: 'N', code_length: 3, code_type: 'A', allowed_codes: null, excluded_codes: [],
      priority: 40, active: true, effective_from: '2026-01-01T00:00:00Z', effective_until: null },
  ],
  correctionRules: [['O', '0', 'N'], ['0', 'O', 'A'], ['I', '1', 'N'], ['1', 'I', 'A'], ['S', '5', 'N'], ['5', 'S', 'A'],
    ['B', '8', 'N'], ['8', 'B', 'A'], ['G', '6', 'N'], ['6', 'G', 'A'], ['Z', '2', 'N'], ['2', 'Z', 'A']].map(function (r, i) {
    return { correction_rule_id: 'corr-' + (i + 1), source_character: r[0], suggested_character: r[1], context: r[2], active: true };
  }),
};

var TOKEN_DAYS = 30;

// ---------------------------------------------------------------- setup --

/** Run once from the Apps Script editor. Safe to run again: it never deletes data. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var head = SHEETS[name];
    if (sh.getLastRow() === 0) sh.appendRow(head);
    sh.setFrozenRows(1);
    // Plain text everywhere, so Sheets never rewrites IDs, dates or ULD numbers.
    sh.getRange(1, 1, sh.getMaxRows(), head.length).setNumberFormat('@');
  });
  var cfg = ss.getSheetByName('CONFIG');
  if (cfg.getLastRow() < 2) {
    Object.keys(DEFAULT_CONFIG).forEach(function (k) { cfg.appendRow([k, JSON.stringify(DEFAULT_CONFIG[k])]); });
  }
  var st = ss.getSheetByName('STATIONS');
  if (st.getLastRow() < 2) {   // placeholders: replace with the real stations and zones
    [['KUL', 'Kuala Lumpur', 'TRUE'], ['PEN', 'Penang', 'TRUE'], ['JHB', 'Johor Bahru', 'TRUE']].forEach(function (r) { st.appendRow(r); });
    var z = ss.getSheetByName('ZONES');
    [['KUL', 'Zone A', 'TRUE'], ['KUL', 'Zone B', 'TRUE'], ['KUL', 'Zone C', 'TRUE'], ['PEN', 'Zone 1', 'TRUE'], ['PEN', 'Zone 2', 'TRUE'], ['JHB', 'Zone 1', 'TRUE']]
      .forEach(function (r) { z.appendRow(r); });
  }
  var us = ss.getSheetByName('USERS');
  if (us.getLastRow() < 2) {   // whoever runs setup becomes the first admin
    var me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
    if (me) us.appendRow([me, me.split('@')[0], 'ADMIN', 'KUL', '*', 'TRUE']);
  }
  secret_();
  return 'Setup complete';
}

/**
 * Run ONCE from the Apps Script editor on a Sheet that was set up before
 * scanner version 0.4 (Pallets mode). Adds what pallets need to the CONFIG
 * tab: pallet types become countable, the owner codes and the two rules for
 * 3-letter owner codes ("PAJ 0606 TRA") are added. Nothing is removed and no
 * scan data is touched. Safe to run again.
 */
function upgradePallets() {
  var sh = sheet_('CONFIG'), rows = rows_('CONFIG'), done = [];
  function edit(key, change) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][0] !== key) continue;
      var v;
      try { v = JSON.parse(rows[i][1]); } catch (e) { return; }      // a broken cell is left for a person to fix
      sh.getRange(i + 2, 2, 1, 1).setValues([[JSON.stringify(change(v))]]);
      done.push(key);
      return;
    }
  }
  function addMissing(list, wanted, same) {
    wanted.forEach(function (w) { if (!list.some(function (x) { return same(x, w); })) list.push(w); });
    return list;
  }
  edit('prefixes', function (list) { list.forEach(function (p) { if (p.category === 'PALLET') p.operational = true; }); return list; });
  edit('operatorCodes', function (list) { return addMissing(list, DEFAULT_CONFIG.operatorCodes, function (a, b) { return a === b; }); });
  edit('validationRules', function (list) { return addMissing(list, DEFAULT_CONFIG.validationRules, function (a, b) { return a.rule_id === b.rule_id; }); });
  edit('correctionRules', function (list) {
    return addMissing(list, DEFAULT_CONFIG.correctionRules, function (a, b) { return a.source_character === b.source_character && a.context === b.context; });
  });
  return 'Pallet settings added to: ' + done.join(', ');
}

function secret_() {
  var p = PropertiesService.getScriptProperties();
  var s = p.getProperty('TOKEN_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('TOKEN_SECRET', s); }
  return s;
}

// --------------------------------------------------------------- helpers --

function ApiError(status, code, message) { this.status = status; this.code = code; this.message = message || code; }

function sheet_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new ApiError(500, 'NOT_CONFIGURED', 'Run setup() first');
  return sh;
}

/** All data rows of a sheet as arrays of strings (header excluded). */
function rows_(name) {
  var sh = sheet_(name), n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, SHEETS[name].length).getValues();
}

function objects_(name) {
  var head = SHEETS[name];
  return rows_(name).map(function (r) { var o = {}; head.forEach(function (h, i) { o[h] = r[i]; }); return o; });
}

function yes_(v) { return v === true || /^(true|1|yes|y)$/i.test(String(v).trim()); }
function now_() { return new Date().toISOString(); }
function s_(v) { return v === null || v === undefined ? '' : String(v); }
function stationId_(code) { return 'stn-' + String(code).toLowerCase(); }
function zoneId_(code, zone) { return (String(code) + '-' + String(zone)).toLowerCase().replace(/[^a-z0-9]+/g, '-'); }

function loadConfig_() {
  var cfg = {};
  rows_('CONFIG').forEach(function (r) { try { cfg[r[0]] = JSON.parse(r[1]); } catch (e) { /* ignore a broken cell */ } });
  Object.keys(DEFAULT_CONFIG).forEach(function (k) { if (cfg[k] === undefined) cfg[k] = DEFAULT_CONFIG[k]; });
  return cfg;
}

// ------------------------------------------------------------------ auth --

function sign_(text) {
  var raw = Utilities.computeHmacSha256Signature(text, secret_());
  return Utilities.base64EncodeWebSafe(raw).replace(/=+$/, '');
}
function issueToken_(email) {
  var payload = Utilities.base64EncodeWebSafe(email + '|' + (Date.now() + TOKEN_DAYS * 864e5)).replace(/=+$/, '');
  return payload + '.' + sign_(payload);
}
function emailFromToken_(token) {
  var parts = String(token || '').split('.');
  if (parts.length !== 2 || sign_(parts[0]) !== parts[1]) return null;
  var text = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString().split('|');
  return Number(text[1]) > Date.now() ? text[0] : null;
}

function stations_() {
  var zones = objects_('ZONES');
  return objects_('STATIONS').filter(function (s) { return s.station_code && yes_(s.active); }).map(function (s) {
    var code = String(s.station_code).trim().toUpperCase();
    return { station_id: stationId_(code), station_code: code, station_name: s_(s.station_name), active: true,
      zones: zones.filter(function (z) { return String(z.station_code).trim().toUpperCase() === code && z.zone_name; }).map(function (z) {
        return { zone_id: zoneId_(code, z.zone_name), zone_name: s_(z.zone_name), active: yes_(z.active) };
      }) };
  });
}

/** Whitelist + station access for one e-mail, re-read from the USERS sheet every request. */
function userFor_(email, allStations) {
  email = String(email || '').trim().toLowerCase();
  var row = objects_('USERS').filter(function (u) { return String(u.email).trim().toLowerCase() === email; })[0];
  if (!row || !yes_(row.active)) throw new ApiError(403, 'NOT_WHITELISTED');
  var codes = allStations.map(function (s) { return s.station_code; });
  var wanted = String(row.stations).trim() === '*' ? codes
    : String(row.stations).toUpperCase().split(/[\s,;]+/).filter(function (c) { return codes.indexOf(c) >= 0; });
  if (!wanted.length) throw new ApiError(403, 'NO_STATION');
  var def = String(row.default_station).trim().toUpperCase();
  return { user_id: email, email: email, name: s_(row.name) || email.split('@')[0], role: /^admin$/i.test(row.role) ? 'ADMIN' : 'STAFF',
    rule_manager: /^admin$/i.test(row.role), default_station_id: stationId_(wanted.indexOf(def) >= 0 ? def : wanted[0]),
    authorized_station_ids: wanted.map(stationId_) };
}

// ------------------------------------------------------------- validation --

function fits_(text, type) {
  if (type === 'N') return /^[0-9]*$/.test(text);
  if (type === 'A') return /^[A-Z]*$/.test(text);
  return /^[A-Z0-9]*$/.test(text);
}

/** Server-side format check against the rule version the device used. */
function uldFormatValid_(value, ruleId, ruleVersion, cfg) {
  value = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  var rules = (cfg.validationRules || []).filter(function (r) {
    return ruleId ? (r.rule_id === ruleId && Number(r.rule_version) === Number(ruleVersion)) : r.active;
  });
  return rules.some(function (r) {
    var pl = r.prefix_length || 3;
    if (value.length !== pl + r.serial_length + r.code_length) return false;
    var prefix = value.slice(0, pl), serial = value.slice(pl, pl + r.serial_length), code = value.slice(pl + r.serial_length);
    if (!fits_(prefix, 'A') || !fits_(serial, r.serial_type || 'N') || !fits_(code, r.code_type || 'AN')) return false;
    if (r.prefixes && r.prefixes !== '*' && r.prefixes.indexOf(prefix) < 0) return false;
    if (r.allowed_codes && r.allowed_codes.length && r.allowed_codes.indexOf(code) < 0) return false;
    if (r.excluded_codes && r.excluded_codes.indexOf(code) >= 0) return false;
    return true;
  });
}

// ------------------------------------------------------------------- sync --

/** In-memory view of one sheet for the duration of a request. */
function Table_(name) {
  this.name = name; this.sh = sheet_(name); this.head = SHEETS[name];
  this.dataCol = this.head.indexOf('data');
  this.rows = rows_(name);
  this.index = {};
  for (var i = 0; i < this.rows.length; i++) this.index[this.rows[i][0]] = i;
  this.firstNew = this.rows.length;   // rows from here on are new in this request
  this.changed = {};
}
Table_.prototype.has = function (id) { return this.index[id] !== undefined; };
Table_.prototype.get = function (id) { var i = this.index[id]; return i === undefined ? null : this.rows[i]; };
Table_.prototype.data = function (id) { var r = this.get(id); try { return r ? JSON.parse(r[this.dataCol]) : null; } catch (e) { return null; } };
Table_.prototype.put = function (id, row) {
  var i = this.index[id];
  if (i === undefined) { this.index[id] = this.rows.length; this.rows.push(row); return; }
  this.rows[i] = row;
  if (i < this.firstNew) this.changed[i] = true;
};
/** Write everything back in as few calls as possible. */
Table_.prototype.flush = function () {
  var self = this, added = this.rows.slice(this.firstNew);
  Object.keys(this.changed).forEach(function (i) { self.sh.getRange(Number(i) + 2, 1, 1, self.head.length).setValues([self.rows[i]]); });
  if (added.length) this.sh.getRange(this.firstNew + 2, 1, added.length, this.head.length).setValues(added);
};

function sessionRow_(id, d, rev) {
  return [id, String(rev), s_(d.session_reference), s_(d.station_code), s_(d.zone_name), s_(d.day), s_(d.status), s_(d.started_at),
    s_(d.completed_at), s_(d.created_by), s_(d.device_id), s_(d.counters && d.counters.duplicates), s_(d.device && d.device.device_model),
    s_(d.rev), now_(), JSON.stringify(d)];
}
function scanRow_(id, d, rev, session) {
  var c = d.confidence || {}, e = d.env || {};
  return [id, String(rev), s_(d.session_id), s_(session.station_code), s_(session.zone_name), s_(session.day), s_(d.uld_number), s_(d.value),
    s_(d.state), s_(d.category), (d.state === 'CONFIRMED' && d.operational && d.category === 'CONTAINER') ? 'TRUE' : 'FALSE', s_(d.validation_status), s_(d.confidence_status),
    s_(d.raw_ocr), s_(d.suggested_correction), s_(d.correction_accepted), d.manually_added ? 'TRUE' : 'FALSE', d.manually_corrected ? 'TRUE' : 'FALSE',
    s_(d.source), s_(c.overall), s_(e.lighting), s_(d.created_at), s_(d.confirmed_at), s_(d.confirmed_by), s_(d.image_reference),
    s_(d.rev), now_(), JSON.stringify(d)];
}

/**
 * Same rules as the PHP backend:
 *  new record -> insert (server_rev 1); matching base_rev -> update;
 *  the same device version sent again -> duplicate (safe retry);
 *  anything else -> CONFLICT: nothing overwritten, both versions logged.
 */
function applyRecord_(table, id, data, baseRev, makeRow, entity, user, conflicts) {
  var cur = table.get(id);
  if (!cur) { table.put(id, makeRow(1)); return { status: 'applied', server_rev: 1 }; }
  var rev = Number(cur[1]), curData = table.data(id) || {};
  if (Number(curData.rev) === Number(data.rev) && JSON.stringify(curData) === JSON.stringify(data)) return { status: 'duplicate', server_rev: rev };
  if (baseRev !== null && baseRev !== undefined && Number(baseRev) === rev) { table.put(id, makeRow(rev + 1)); return { status: 'applied', server_rev: rev + 1 }; }
  conflicts.push([now_(), entity, id, user.email, s_(baseRev), String(rev), JSON.stringify(data), JSON.stringify(curData), '']);
  return { status: 'conflict', server_rev: rev, server_data: curData };
}

function handleSync_(user, body, cfg) {
  var ops = body.ops;
  if (!Array.isArray(ops)) throw new ApiError(400, 'BAD_REQUEST', 'ops must be a list');
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);   // one writer at a time: Sheets has no transactions
  try {
    var sessions = new Table_('SESSIONS'), scans = new Table_('SCANS'), events = new Table_('EVENTS');
    var conflicts = [], results = [];
    var allowed = user.authorized_station_ids;

    ops.forEach(function (op) {
      var id = s_(op.entity_id), d = op.data, r;
      try {
        if (!op.op_id || !id || !d || typeof d !== 'object') throw new Error('malformed op');
        if (op.entity === 'session') {
          if (allowed.indexOf(d.station_id) < 0) throw new Error('station not authorized for this user');
          r = applyRecord_(sessions, id, d, op.base_rev, function (rev) { return sessionRow_(id, d, rev); }, 'session', user, conflicts);
        } else if (op.entity === 'scan') {
          var s = sessions.data(d.session_id);
          if (!s) throw new Error('unknown session');
          if (allowed.indexOf(s.station_id) < 0) throw new Error('station not authorized for this user');
          if (!d.value) throw new Error('empty ULD number');
          if ((d.state === 'CONFIRMED' || d.state === 'AUTO_SAVED') && !uldFormatValid_(d.final_value || d.value, d.rule_id, d.rule_version, cfg)) {
            throw new Error('ULD number does not match the validation rule');
          }
          r = applyRecord_(scans, id, d, op.base_rev, function (rev) { return scanRow_(id, d, rev, s); }, 'scan', user, conflicts);
        } else if (op.entity === 'event') {
          if (events.has(id)) r = { status: 'duplicate', server_rev: 1 };
          else {
            var es = sessions.data(d.session_id);
            if (!es) throw new Error('unknown session');
            if (allowed.indexOf(es.station_id) < 0) throw new Error('station not authorized for this user');
            events.put(id, [id, s_(d.session_id), s_(d.type), s_(d.user_id), s_(d.at), now_(), JSON.stringify(d)]);
            r = { status: 'applied', server_rev: 1 };
          }
        } else throw new Error('malformed op');
      } catch (e) {
        r = { status: 'rejected', reason: e.message };
      }
      r.op_id = s_(op.op_id);
      results.push(r);
    });

    sessions.flush(); scans.flush(); events.flush();
    if (conflicts.length) { var csh = sheet_('CONFLICTS'); csh.getRange(csh.getLastRow() + 1, 1, conflicts.length, SHEETS.CONFLICTS.length).setValues(conflicts); }
    return { results: results };
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------- sessions, images --

function withRev_(row, dataCol) { var d = JSON.parse(row[dataCol]); d.server_rev = Number(row[1]) || 1; return d; }

function listOpenSessions_(user, query) {
  if (user.authorized_station_ids.indexOf(query.station_id) < 0) throw new ApiError(403, 'STATION_NOT_AUTHORIZED');
  var col = SHEETS.SESSIONS.indexOf('data');
  var out = rows_('SESSIONS').map(function (r) { return withRev_(r, col); }).filter(function (s) {
    return s.station_id === query.station_id && s.day === query.day && (s.status === 'DRAFT' || s.status === 'IN_PROGRESS');
  });
  return { sessions: out };
}

function getSession_(user, id) {
  var col = SHEETS.SESSIONS.indexOf('data');
  var row = rows_('SESSIONS').filter(function (r) { return r[0] === id; })[0];
  if (!row) throw new ApiError(404, 'NOT_FOUND');
  var session = withRev_(row, col);
  if (user.authorized_station_ids.indexOf(session.station_id) < 0) throw new ApiError(403, 'STATION_NOT_AUTHORIZED');
  var sc = SHEETS.SCANS.indexOf('data'), ec = SHEETS.EVENTS.indexOf('data');
  return { session: session,
    scans: rows_('SCANS').filter(function (r) { return r[2] === id; }).map(function (r) { return withRev_(r, sc); }),
    events: rows_('EVENTS').filter(function (r) { return r[1] === id; }).map(function (r) { var d = JSON.parse(r[ec]); d.server_rev = 1; return d; }) };
}

/** Crops for problem scans go to a private Drive folder; the sheet keeps only the file id. */
function uploadImage_(user, body) {
  var ref = s_(body.image_reference);
  if (!/^[0-9a-fA-F-]{8,36}$/.test(ref) || !body.data_base64) throw new ApiError(400, 'BAD_REQUEST');
  if (rows_('IMAGES').some(function (r) { return r[0] === ref; })) return { image_reference: ref };
  var bytes = Utilities.base64Decode(body.data_base64);
  if (bytes.length > 400 * 1024) throw new ApiError(413, 'IMAGE_TOO_LARGE');
  var props = PropertiesService.getScriptProperties(), folderId = props.getProperty('IMAGE_FOLDER'), folder;
  try { folder = folderId ? DriveApp.getFolderById(folderId) : null; } catch (e) { folder = null; }
  if (!folder) { folder = DriveApp.createFolder('ULD Scanner crops'); props.setProperty('IMAGE_FOLDER', folder.getId()); }
  var file = folder.createFile(Utilities.newBlob(bytes, 'image/jpeg', ref + '.jpg'));
  sheet_('IMAGES').appendRow([ref, s_(body.scan_id), s_(body.session_id), s_(body.captured_at), file.getId(), String(bytes.length), now_()]);
  return { image_reference: ref };
}

// ----------------------------------------------------------------- router --

function route_(req) {
  var method = String(req.method || 'GET').toUpperCase(), path = '/' + String(req.path || '').replace(/^\/+|\/+$/g, '');
  var body = req.body || {}, query = req.query || {};
  if (method === 'GET' && path === '/health') { sheet_('SCANS'); return { ok: true, database: 'connected', kind: 'google-sheets' }; }

  var cfg = loadConfig_(), all = stations_();
  if (method === 'POST' && path === '/auth/email') {
    var email = String(body.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError(400, 'BAD_EMAIL');
    var domains = (cfg.company_domains || []).map(function (d) { return String(d).toLowerCase(); });
    if (domains.length && domains.indexOf(email.split('@')[1]) < 0) throw new ApiError(403, 'DOMAIN_NOT_ALLOWED');
    return { token: issueToken_(email), user: userFor_(email, all) };
  }
  if (method === 'POST' && path === '/auth/logout') return { ok: true };

  var who = emailFromToken_(req.token);
  if (!who) throw new ApiError(401, 'UNAUTHENTICATED');
  var user = userFor_(who, all);

  if (method === 'GET' && path === '/auth/me') return { user: user };
  if (method === 'GET' && path === '/config') {
    var out = {};
    Object.keys(cfg).forEach(function (k) { if (k !== 'company_domains') out[k] = cfg[k]; });
    out.stations = all.filter(function (s) { return user.authorized_station_ids.indexOf(s.station_id) >= 0; });
    return out;
  }
  if (method === 'POST' && path === '/sync') return handleSync_(user, body, cfg);
  if (method === 'POST' && path === '/images') return uploadImage_(user, body);
  if (method === 'GET' && path === '/sessions') return listOpenSessions_(user, query);
  var m = path.match(/^\/sessions\/([0-9a-fA-F-]{8,36})$/);
  if (method === 'GET' && m) return getSession_(user, m[1]);
  if (method === 'POST' && path === '/ocr') throw new ApiError(501, 'CLOUD_OCR_NOT_CONFIGURED');
  throw new ApiError(404, 'NOT_FOUND');
}

/**
 * Every call arrives as a POST with a JSON envelope in a text/plain body:
 *   { method, path, query, token, body }
 * (Apps Script web apps cannot read custom headers or answer CORS preflight,
 * so the scanner wraps its normal API calls this way.) The reply is always
 * HTTP 200 with { status, body }.
 */
function doPost(e) {
  var status = 200, out;
  try {
    out = route_(JSON.parse(e.postData.contents));
  } catch (err) {
    status = err instanceof ApiError ? err.status : 500;
    out = { error: { code: err instanceof ApiError ? err.code : 'SERVER_ERROR', message: String(err && err.message) } };
  }
  return ContentService.createTextOutput(JSON.stringify({ status: status, body: out })).setMimeType(ContentService.MimeType.JSON);
}

/** Opening the web-app URL in a browser shows that it is alive. */
function doGet() {
  var ok = true, note = 'connected';
  try { sheet_('SCANS'); } catch (e) { ok = false; note = 'Run setup() first'; }
  return ContentService.createTextOutput(JSON.stringify({ service: 'uld-scanner-sheets', ok: ok, database: note })).setMimeType(ContentService.MimeType.JSON);
}
