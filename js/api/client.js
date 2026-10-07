// API client. The app talks to the backend only through this module, so a
// future native app can use the same endpoints (see docs/API.md).

import { apiBase, apiKind } from '../config.js';

export class ApiError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

let token = null;
export const api = {
  get enabled() { return !!apiBase(); },
  get base() { return apiBase().replace(/\/$/, ''); },
  setToken(t) { token = t; },

  async request(method, path, body, { form } = {}) {
    if (apiKind() === 'gas') return this.gasRequest(method, path, body, form);
    const headers = { Accept: 'application/json' };
    // X-Auth-Token is a duplicate for hosts that strip the Authorization header.
    if (token) { headers.Authorization = `Bearer ${token}`; headers['X-Auth-Token'] = token; }
    if (body && !form) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(this.base + path, { method, headers, body: form ? body : body ? JSON.stringify(body) : undefined });
    } catch {
      throw new ApiError(0, 'NETWORK', 'Server not reachable');
    }
    let json = null;
    try { json = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) throw new ApiError(res.status, json?.error?.code || `HTTP_${res.status}`, json?.error?.message);
    return json;
  },

  /**
   * Google Apps Script transport. A web app cannot read headers or answer a
   * CORS preflight, so every call is one plain-text POST carrying
   * { method, path, query, token, body }; the reply is { status, body }.
   */
  async gasRequest(method, path, body, form) {
    const [p, qs] = path.split('?');
    const env = { method, path: p, query: Object.fromEntries(new URLSearchParams(qs || '')), token, body: body && !form ? body : undefined };
    if (form) {   // `body` is a FormData; multipart is not available, so the crop goes as base64
      env.body = {};
      for (const [k, v] of body.entries()) {
        if (v instanceof Blob) env.body.data_base64 = await blobToBase64(v); else env.body[k] = v;
      }
    }
    let res, json;
    try {
      res = await fetch(this.base, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(env), redirect: 'follow' });
      json = await res.json();
    } catch {
      throw new ApiError(0, 'NETWORK', 'Server not reachable');
    }
    if (!json || typeof json.status !== 'number') throw new ApiError(502, 'BAD_RESPONSE');
    if (json.status >= 400) throw new ApiError(json.status, json.body?.error?.code || `HTTP_${json.status}`, json.body?.error?.message);
    return json.body;
  },

  loginUrl(provider, returnTo) { return `${this.base}/auth/${provider}/start?return_to=${encodeURIComponent(returnTo)}`; },
  emailLogin(email, deviceId) { return this.request('POST', '/auth/email', { email, device_id: deviceId }); },
  exchange(code, deviceId) { return this.request('POST', '/auth/exchange', { code, device_id: deviceId }); },
  me() { return this.request('GET', '/auth/me'); },
  logout() { return this.request('POST', '/auth/logout'); },
  config() { return this.request('GET', '/config'); },
  sync(deviceId, ops) { return this.request('POST', '/sync', { device_id: deviceId, ops }); },
  uploadImage(meta, blob) {
    const f = new FormData();
    for (const [k, v] of Object.entries(meta)) f.append(k, v);
    f.append('file', blob, `${meta.image_reference}.jpg`);
    return this.request('POST', '/images', f, { form: true });
  },
  openSessions(stationId, day) {
    return this.request('GET', `/sessions?station_id=${encodeURIComponent(stationId)}&day=${day}&open=1`);
  },
  session(id) { return this.request('GET', `/sessions/${encodeURIComponent(id)}`); },
  /** Cloud OCR fallback: sends ONE cropped ULD-number image, never a frame. */
  cloudOcr(blob) {
    const f = new FormData();
    f.append('file', blob, 'crop.jpg');
    return this.request('POST', '/ocr', f, { form: true });
  },
};

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
