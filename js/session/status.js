// Staff-facing status of a scan. Raw confidence numbers stay in the record
// for admin analytics; the UI only ever gets the labels produced here.

import { validate } from '../validation/validator.js';

export function confidenceStatus(conf, config) {
  if (conf == null) return null;
  if (conf >= config.thresholds.high) return 'HIGH';
  if (conf >= config.thresholds.review) return 'REVIEW';
  return 'UNCERTAIN';
}

export function evaluate(scan, config) {
  // Rules are chosen by when the scan was made, so a later rule change does
  // not silently re-judge an item that is still waiting in the queue.
  const v = validate(scan.value, config, Date.parse(scan.created_at));
  const reasons = [...v.reasons];
  let status = v.status;
  // Doubts about HOW a number was read stop mattering once a person has typed it.
  const typed = scan.manually_added || scan.manually_corrected;
  if (!typed && scan.flags?.unreadable) {
    // The reader could not make the number out. Whatever it guessed is only
    // a starting point for editing, even if it happens to look like a ULD.
    if (status !== 'INVALID') reasons.length = 0;
    status = 'INVALID';
    reasons.unshift('Not read reliably');
  } else if (status !== 'INVALID' && !typed) {
    for (const r of scan.flags?.review || []) reasons.push(r);
    if (scan.confidence_status && scan.confidence_status !== 'HIGH') {
      reasons.push(scan.confidence_status === 'UNCERTAIN' ? 'Uncertain reading' : 'Check the reading');
    }
    if (reasons.length) status = 'NEEDS_REVIEW';
  }
  const suggestionOpen = !!scan.suggested_correction && scan.correction_accepted == null && !scan.manually_corrected;
  const tone = scan.state === 'CONFIRMED' ? 'ok' : scan.state === 'REJECTED' ? 'bad' : scan.state === 'AUTO_SAVED' ? 'info'
    : status === 'VALID' ? 'ok' : status === 'NEEDS_REVIEW' ? 'review' : 'bad';
  const label = scan.state === 'CONFIRMED' ? 'Confirmed' : scan.state === 'REJECTED' ? 'Rejected'
    : scan.state === 'AUTO_SAVED' ? 'Other ULD'
    : status === 'VALID' ? 'High confidence' : status === 'NEEDS_REVIEW' ? 'Needs review' : 'Uncertain or invalid';
  return { validation: v, status, reasons, tone, label, suggestionOpen,
    confirmable: status !== 'INVALID' && !suggestionOpen };
}
