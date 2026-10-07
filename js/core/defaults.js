// Seed configuration.
//
// Everything in here is DATA, not logic. In production the same structure is
// served by GET /config (see docs/API.md) and edited by the Admin / Rule
// Manager; the app caches the last copy it received for offline use. This file
// is only the fallback for demo mode and for the very first launch.
//
// ⚠ Stations, zones and operator codes below are placeholders to be replaced
//   by the real lists.

export const DEFAULT_CONFIG = {
  config_version: 1,

  // Admin-configurable confidence thresholds (percent). Staff never see these.
  thresholds: { high: 90, review: 70 },

  tracking: {
    minFrames: 2,             // consistent frames before a result is shown
    singleFrameIfHigh: true,  // one frame is enough when valid + high confidence
    invalidMinFrames: 3,      // an unreadable-but-ULD-like text must persist this long
    trackTtlMs: 1500,         // a track is dropped after not being seen this long
  },

  queue: { overflowThreshold: 8 },
  images: { retentionDays: 30 },
  cloudOcr: { enabled: false },

  // ULD prefix table. `operational` = this type is counted (in the scan mode
  // of its category); a recognised type that is not operational is only
  // stored silently as "Other ULD".
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

  // Scan modes. Each mode counts one category and uses its own OCR pipeline;
  // ULDs of another category seen while in a mode are stored silently.
  scanModes: [
    { mode: 'CONTAINER', label: 'Containers', category: 'CONTAINER', pipeline: 'container', active: true },
    { mode: 'PALLET', label: 'Pallets', category: 'PALLET', pipeline: 'pallet', active: true },
  ],

  // Known airline/operator codes for rules that do not list their own
  // `allowed_codes`. A structurally valid ULD with a code outside this list
  // becomes NEEDS_REVIEW ("Unknown airline/operator code"). Empty = no check.
  // R7, R9, C6, TG, EK and TRA were read off the reference pallet photos.
  operatorCodes: ['AK', 'D7', 'FD', 'QZ', 'Z2', 'XJ', 'MH', 'R7', 'R9', 'C6', 'TG', 'EK', 'TRA'],

  // Validation rules. Several rows may share a rule_id (versions); the one
  // whose effective window contains the scan time is used.
  validationRules: [
    {
      rule_id: 'rule-ai-sv', rule_version: 1,
      name: 'AI / SV: 4-digit serial',
      prefixes: '*', prefix_length: 3,
      serial_length: 4, serial_type: 'N',
      code_length: 2, code_type: 'A',
      allowed_codes: ['AI', 'SV'], excluded_codes: [],
      priority: 10, active: true,
      effective_from: '2026-01-01T00:00:00Z', effective_until: null,
    },
    {
      rule_id: 'rule-standard', rule_version: 1,
      name: 'Other operators: 5-digit serial',
      prefixes: '*', prefix_length: 3,
      serial_length: 5, serial_type: 'N',
      code_length: 2, code_type: 'AN',
      allowed_codes: null, excluded_codes: ['AI', 'SV'],
      priority: 20, active: true,
      effective_from: '2026-01-01T00:00:00Z', effective_until: null,
    },
    // Pallets also carry 3-letter owner codes, with 4- or 5-digit serials
    // (seen on the reference photos: "PAJ 0606 TRA").
    {
      rule_id: 'rule-pallet-owner3-4', rule_version: 1,
      name: 'Pallet, 3-letter owner: 4-digit serial',
      prefixes: ['PAG', 'PAJ', 'PKC', 'PMC', 'PLA'], prefix_length: 3,
      serial_length: 4, serial_type: 'N',
      code_length: 3, code_type: 'A',
      allowed_codes: null, excluded_codes: [],
      priority: 30, active: true,
      effective_from: '2026-01-01T00:00:00Z', effective_until: null,
    },
    {
      rule_id: 'rule-pallet-owner3-5', rule_version: 1,
      name: 'Pallet, 3-letter owner: 5-digit serial',
      prefixes: ['PAG', 'PAJ', 'PKC', 'PMC', 'PLA'], prefix_length: 3,
      serial_length: 5, serial_type: 'N',
      code_length: 3, code_type: 'A',
      allowed_codes: null, excluded_codes: [],
      priority: 40, active: true,
      effective_from: '2026-01-01T00:00:00Z', effective_until: null,
    },
  ],

  // OCR confusion rules. context: 'N' = applies where a digit is expected,
  // 'A' = applies where a letter is expected. Suggestions only, never applied
  // silently.
  correctionRules: [
    ['O', '0', 'N'], ['0', 'O', 'A'],
    ['I', '1', 'N'], ['1', 'I', 'A'],
    ['S', '5', 'N'], ['5', 'S', 'A'],
    ['B', '8', 'N'], ['8', 'B', 'A'],
    ['G', '6', 'N'], ['6', 'G', 'A'],
    ['Z', '2', 'N'], ['2', 'Z', 'A'],
  ].map(([source, suggested, context], i) => ({
    correction_rule_id: `corr-${i + 1}`, source_character: source,
    suggested_character: suggested, context, active: true,
  })),

  stations: [
    { station_id: 'stn-kul', station_code: 'KUL', station_name: 'Kuala Lumpur', active: true,
      zones: [
        { zone_id: 'kul-a', zone_name: 'Zone A', active: true },
        { zone_id: 'kul-b', zone_name: 'Zone B', active: true },
        { zone_id: 'kul-c', zone_name: 'Zone C', active: true },
      ] },
    { station_id: 'stn-pen', station_code: 'PEN', station_name: 'Penang', active: true,
      zones: [
        { zone_id: 'pen-1', zone_name: 'Zone 1', active: true },
        { zone_id: 'pen-2', zone_name: 'Zone 2', active: true },
      ] },
    { station_id: 'stn-jhb', station_code: 'JHB', station_name: 'Johor Bahru', active: true,
      zones: [{ zone_id: 'jhb-1', zone_name: 'Zone 1', active: true }] },
  ],
};

/** The scan modes staff can choose between (Containers, Pallets). */
export function scanModes(config) {
  const modes = (config.scanModes || DEFAULT_CONFIG.scanModes).filter((m) => m.active);
  return modes.length ? modes : DEFAULT_CONFIG.scanModes.slice(0, 1);
}

/**
 * Bring a configuration from the server (or an older cached one) up to what
 * this version of the app expects. A configuration written before pallet
 * mode existed has no scan modes and marks pallets as "not counted", because
 * nothing could count them then; left like that, Pallets mode would save
 * every pallet silently. Validation rules and operator codes are the
 * administrator's data and are never touched here.
 */
export function withDefaults(config) {
  if (!config || config.scanModes) return config;
  return {
    ...config,
    scanModes: DEFAULT_CONFIG.scanModes,
    prefixes: (config.prefixes || []).map((p) => (p.category === 'PALLET' ? { ...p, operational: true } : p)),
  };
}
