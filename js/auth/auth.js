// Authentication.
//
// With a backend: Google / Microsoft sign-in is a server-side redirect flow.
// The server checks company domain -> admin whitelist -> station access and
// sends the browser back with a one-time code, which is exchanged for an API
// token. No identity-provider library or secret lives in the app.
//
// Demo mode (no API_BASE): an unverified e-mail prompt so the scanner can be
// tried on a device. It is labelled as such in the UI.

import { api } from '../api/client.js';
import { db, uuid } from '../offline/db.js';
import { DEMO_DOMAINS, OFFLINE_LOGIN_DAYS } from '../config.js';
import { DEFAULT_CONFIG } from '../core/defaults.js';

export const DENIED_TEXT = 'Your account is not authorized to use ULD Scanner. Please contact your system administrator.';

export const auth = {
  user: null,
  deviceId: null,

  async init() {
    this.deviceId = await db.getMeta('device_id');
    if (!this.deviceId) { this.deviceId = uuid(); await db.setMeta('device_id', this.deviceId); }
    const saved = await db.getMeta('auth');
    if (saved?.user) {
      const ageDays = (Date.now() - Date.parse(saved.verified_at)) / 864e5;
      if (!api.enabled || ageDays <= OFFLINE_LOGIN_DAYS) { this.user = saved.user; api.setToken(saved.token); }
    }
    return this.user;
  },

  /** Complete a redirect sign-in if the URL carries a result. */
  async handleRedirect() {
    const h = new URLSearchParams(location.hash.replace(/^#/, ''));
    const code = h.get('login_code'), error = h.get('login_error');
    if (!code && !error) return null;
    history.replaceState(null, '', location.pathname + location.search);
    if (error) return { error };
    try {
      const r = await api.exchange(code, this.deviceId);
      await this._save(r.user, r.token);
      return { user: r.user };
    } catch (e) {
      return { error: e.code || 'FAILED' };
    }
  },

  startLogin(provider) {
    location.href = api.loginUrl(provider, location.origin + location.pathname);
  },

  /** Refresh the profile (stations, role) when the server is reachable. */
  async refresh() {
    if (!api.enabled || !this.user) return;
    try {
      const r = await api.me();
      await this._save(r.user, (await db.getMeta('auth')).token);
    } catch (e) {
      if (e.status === 401 || e.status === 403) { await this.logout(true); throw e; }
    }
  },

  /** Pilot sign-in: the server checks domain, whitelist and station access. */
  async emailLogin(email) {
    try {
      const r = await api.emailLogin(String(email || '').trim().toLowerCase(), this.deviceId);
      await this._save(r.user, r.token);
      return { user: r.user };
    } catch (e) {
      return { error: e.code || 'FAILED' };
    }
  },

  async demoLogin(email, name) {
    email = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'BAD_EMAIL' };
    const domain = email.split('@')[1];
    if (DEMO_DOMAINS.length && !DEMO_DOMAINS.includes(domain)) return { error: 'DOMAIN_NOT_ALLOWED' };
    const stations = DEFAULT_CONFIG.stations;
    const user = { user_id: `demo:${email}`, email, name: name || email.split('@')[0], role: 'STAFF',
      rule_manager: false, default_station_id: stations[0].station_id,
      authorized_station_ids: stations.map((s) => s.station_id), demo: true };
    await this._save(user, null);
    return { user };
  },

  async _save(user, token) {
    this.user = user; api.setToken(token);
    await db.setMeta('auth', { user, token, verified_at: new Date().toISOString() });
  },

  async logout(silent) {
    if (api.enabled && !silent) { try { await api.logout(); } catch { /* offline */ } }
    this.user = null; api.setToken(null);
    await db.setMeta('auth', null);
  },
};

export function deniedMessage(code) {
  if (code === 'NO_STATION') return 'Your account has no station assigned yet. Ask your administrator to add one.';
  if (code === 'BAD_EMAIL') return 'Enter a valid e-mail address.';
  if (code === 'NETWORK') return 'Sign-in needs an internet connection the first time.';
  if (['NOT_WHITELISTED', 'DOMAIN_NOT_ALLOWED'].includes(code)) return DENIED_TEXT;
  if (code === 'HTTP_404') return 'The server address is wrong (not found). Check API_BASE in js/config.js.';
  return `The server could not be reached or returned an error (${code}). Try again shortly.`;
}
