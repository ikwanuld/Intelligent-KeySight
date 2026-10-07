// Copy / download the ULD list of a session. Works entirely on the device,
// so it is available offline and in demo mode.

const STATE_LABEL = { CONFIRMED: 'Confirmed', AUTO_SAVED: 'Other ULD', PENDING: 'Pending', REJECTED: 'Rejected' };
const localTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** Confirmed container and pallet numbers, one per line, in scan order: pastes straight into a sheet column. */
export function confirmedList(scans) {
  return scans.filter((s) => s.state === 'CONFIRMED' && s.operational).map((s) => s.uld_number || s.value);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers / blocked clipboard permission.
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* not available */ }
    ta.remove();
    return ok;
  }
}

const cell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;          // never let a spreadsheet run a cell as a formula
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Every record of the session (all states), one row each. Times are device-local. */
export function sessionCsv(session, scans) {
  const head = ['ULD Number', 'Status', 'Type', 'Category', 'Station', 'Zone', 'Session', 'Date', 'Scanned At', 'Confirmed At',
    'Entry', 'Raw OCR', 'Corrected', 'Needs Review', 'Scanned By'];
  const rows = scans.map((s) => [
    s.uld_number || s.value, STATE_LABEL[s.state] || s.state, s.prefix || '', s.category || '',
    session.station_code, session.zone_name, session.session_reference, session.day,
    localTime(s.created_at), localTime(s.confirmed_at),
    s.manually_added ? 'Manual' : s.source === 'MULTI' ? 'Multi-scan' : 'Scan',
    s.raw_ocr || '', s.manually_corrected || s.correction_accepted ? 'Yes' : 'No',
    s.validation_status === 'NEEDS_REVIEW' ? 'Yes' : 'No', s.confirmed_by || s.created_by || '',
  ]);
  return [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function downloadCsv(session, scans) {
  // BOM so Excel opens it as UTF-8.
  const blob = new Blob(['﻿', sessionCsv(session, scans)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ULD_${session.session_reference}_${session.zone_name.replace(/[^A-Za-z0-9]+/g, '-')}.csv`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
