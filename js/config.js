// Deployment settings. This is the only file that changes between
// environments.

export const APP_VERSION = '0.4.0';

// Base URL of the backend API, e.g. 'https://uld.example.com/api'.
// Leave empty to run in DEMO MODE: everything works on the device, nothing
// is sent anywhere, and sign-in is not verified.
export const API_BASE = '';

// How staff sign in when a backend is configured:
//   'email'  pilot mode: work e-mail checked against the server's whitelist
//            (no password, not verified; for a supervised pilot only)
//   'oauth'  Google / Microsoft redirect sign-in (needs the OAuth endpoints)
export const AUTH_MODE = 'email';

// Demo mode only: restrict demo sign-in to these e-mail domains, e.g.
// ['yourcompany.com']. Empty = any address. With a real backend the domain
// and whitelist checks happen on the server and this list is ignored.
export const DEMO_DOMAINS = [];

// OCR engine used on the device for CONTAINERS. Must be registered in js/ocr/.
// (Pallets have their own reader, js/pallet/, and do not use this setting.)
export const OCR_ENGINE = 'tesseract';

// Pallet reader.
//   PALLET_PREFETCH  download the reader (about 30 MB, once) in the background
//                    after sign-in, so Pallets mode also works where there is
//                    no signal. false = download only when Pallets is opened.
//   PALLET_THREADS   upper limit of processor threads the reader may use.
//                    More than one only takes effect when the page is
//                    "cross-origin isolated" (see ISOLATE in sw.js).
export const PALLET_PREFETCH = true;
export const PALLET_THREADS = 4;

// How long a cached sign-in may be used without reaching the server.
export const OFFLINE_LOGIN_DAYS = 7;

// Test hook: lets the automated tests point the app at the mock API without
// editing this file. Honoured on localhost only.
export function apiBase() {
  try {
    if (['localhost', '127.0.0.1'].includes(location.hostname)) return localStorage.getItem('uld_api_base') || API_BASE;
  } catch { /* storage unavailable */ }
  return API_BASE;
}
// Google Sheets backend: set API_BASE to the Apps Script web-app URL
// (https://script.google.com/macros/s/.../exec). It is detected automatically.
export function apiKind() {
  try {
    if (['localhost', '127.0.0.1'].includes(location.hostname) && localStorage.getItem('uld_api_kind')) return localStorage.getItem('uld_api_kind');
  } catch { /* storage unavailable */ }
  return /script\.google(usercontent)?\.com/.test(apiBase()) ? 'gas' : 'rest';
}
export function authMode() {
  try {
    if (['localhost', '127.0.0.1'].includes(location.hostname)) return localStorage.getItem('uld_auth_mode') || AUTH_MODE;
  } catch { /* storage unavailable */ }
  return AUTH_MODE;
}
