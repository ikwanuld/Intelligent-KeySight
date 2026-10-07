import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmedList, sessionCsv } from '../js/ui/export.js';

const session = { station_code: 'KUL', zone_name: 'Zone A', session_reference: 'KUL-20261005-ABC01', day: '2026-10-05' };
const scans = [
  { state: 'CONFIRMED', operational: true, value: 'AKE1234AI', uld_number: 'AKE1234AI', prefix: 'AKE', category: 'CONTAINER', created_at: '2026-10-05T01:00:00Z', confirmed_at: '2026-10-05T01:00:05Z', source: 'SINGLE', raw_ocr: 'AKE1234A1', correction_accepted: true, validation_status: 'VALID', confirmed_by: 'u1' },
  { state: 'AUTO_SAVED', operational: false, value: 'PMC12345MH', prefix: 'PMC', category: 'PALLET', created_at: '2026-10-05T01:01:00Z', source: 'SINGLE', validation_status: 'VALID', created_by: 'u1' },
  { state: 'REJECTED', operational: true, value: 'AKE99999MH', created_at: '2026-10-05T01:02:00Z', source: 'SINGLE', validation_status: 'VALID' },
  { state: 'CONFIRMED', operational: true, value: 'AKH9999SV', uld_number: 'AKH9999SV', manually_added: true, created_at: '2026-10-05T01:03:00Z', source: 'MANUAL', validation_status: 'VALID', confirmed_by: '=cmd,"x"' },
];

test('copy list = confirmed containers only, in scan order', () => {
  assert.deepEqual(confirmedList(scans), ['AKE1234AI', 'AKH9999SV']);
});

test('CSV: one row per record, quoted safely, formulas neutralised', () => {
  const lines = sessionCsv(session, scans).trim().split('\r\n');
  assert.equal(lines.length, 5);
  assert.ok(lines[0].startsWith('ULD Number,Status,Type'));
  assert.ok(lines[1].startsWith('AKE1234AI,Confirmed,AKE,CONTAINER,KUL,Zone A,KUL-20261005-ABC01,2026-10-05,'));
  assert.ok(lines[1].includes(',Scan,AKE1234A1,Yes,No,u1'));
  assert.ok(lines[2].includes('Other ULD')); assert.ok(lines[3].includes('Rejected'));
  assert.ok(lines[4].includes(',Manual,') && lines[4].endsWith(`"'=cmd,""x"""`));
});
