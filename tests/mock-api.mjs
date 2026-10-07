// In-memory mock of the backend API (docs/API.md), used by the end-to-end
// tests. It is also the shortest readable statement of the sync rules the
// real PHP backend has to implement: idempotent ops, revision check,
// conflicts preserved instead of overwritten.
import { DEFAULT_CONFIG } from '../js/core/defaults.js';

export function createMockApi() {
  const state = {
    seenOps: new Map(),             // op_id -> result (idempotency)
    records: { session: new Map(), scan: new Map(), event: new Map() },
    conflicts: [], images: [], ocrCalls: [], failing: false,
    config: structuredClone(DEFAULT_CONFIG),
  };
  const user = { user_id: 'u-test', email: 'tester@company.test', name: 'Test Staff', role: 'STAFF', rule_manager: false,
    default_station_id: 'stn-kul', authorized_station_ids: ['stn-kul', 'stn-pen'] };

  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });

  function applyOp(op) {
    if (state.seenOps.has(op.op_id)) return { ...state.seenOps.get(op.op_id), status: 'duplicate' };
    const table = state.records[op.entity];
    if (!table) return { op_id: op.op_id, status: 'rejected', reason: 'unknown entity' };
    const cur = table.get(op.entity_id);
    let result;
    if (!cur) {
      table.set(op.entity_id, { server_rev: 1, data: op.data });
      result = { op_id: op.op_id, status: 'applied', server_rev: 1 };
    } else if (op.entity === 'event') {
      result = { op_id: op.op_id, status: 'duplicate', server_rev: cur.server_rev };   // events are immutable
    } else if (op.base_rev === cur.server_rev) {
      cur.server_rev++; cur.data = op.data;
      result = { op_id: op.op_id, status: 'applied', server_rev: cur.server_rev };
    } else {
      // Someone else changed this record since the device last saw it.
      // Keep BOTH versions and flag for admin review; never overwrite.
      state.conflicts.push({ entity: op.entity, entity_id: op.entity_id, incoming: op.data, current: cur.data, at: new Date().toISOString() });
      result = { op_id: op.op_id, status: 'conflict', server_rev: cur.server_rev, server_data: cur.data };
    }
    state.seenOps.set(op.op_id, result);
    return result;
  }

  async function handle(req, res, path, query) {
    if (path === '/_state') {
      return json(res, 200, { sessions: [...state.records.session.values()], scans: [...state.records.scan.values()],
        events: [...state.records.event.values()], conflicts: state.conflicts, images: state.images, ocrCalls: state.ocrCalls });
    }
    if (path === '/_control') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      if ('failing' in b) state.failing = b.failing;
      if (b.bump) { const r = state.records[b.bump.entity].get(b.bump.id); if (r) { r.server_rev++; r.data = { ...r.data, ...b.bump.patch }; } }
      if (b.config) Object.assign(state.config, b.config);
      return json(res, 200, { ok: true });
    }
    if (state.failing) return json(res, 503, { error: { code: 'UNAVAILABLE', message: 'down for test' } });

    let m;
    if ((m = path.match(/^\/auth\/(google|microsoft)\/start$/))) {
      const back = query.get('return_to');
      // In the tests, Microsoft plays the "not on the whitelist" account.
      const frag = m[1] === 'google' ? 'login_code=test-code' : 'login_error=NOT_WHITELISTED';
      res.writeHead(302, { Location: `${back}#${frag}` }); return res.end();
    }
    if (path === '/auth/exchange' && req.method === 'POST') return json(res, 200, { token: 'test-token', user });
    if (req.headers.authorization !== 'Bearer test-token') return json(res, 401, { error: { code: 'UNAUTHENTICATED' } });
    if (path === '/auth/me') return json(res, 200, { user });
    if (path === '/auth/logout') return json(res, 200, { ok: true });
    if (path === '/config') return json(res, 200, state.config);
    if (path === '/sync' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString());
      return json(res, 200, { results: body.ops.map(applyOp) });
    }
    if (path === '/images' && req.method === 'POST') {
      const raw = await readBody(req);
      const ref = (raw.toString('latin1').match(/name="image_reference"\r\n\r\n([^\r]+)/) || [])[1];
      state.images.push({ image_reference: ref, bytes: raw.length });
      return json(res, 200, { image_reference: ref });
    }
    if (path === '/ocr' && req.method === 'POST') {
      // Stand-in for a cloud OCR provider: always "reads" the same number.
      const raw = await readBody(req);
      state.ocrCalls.push({ bytes: raw.length });
      const symbols = [...'AKE77410MH'].map((ch, i) => ({ ch, conf: 93, bbox: { x0: 10 + i * 30, y0: 10, x1: 34 + i * 30, y1: 50 } }));
      return json(res, 200, { engine: 'mock-cloud', symbols });
    }
    if (path === '/sessions' && req.method === 'GET') {
      const list = [...state.records.session.values()].map((r) => ({ ...r.data, server_rev: r.server_rev }))
        .filter((s) => s.station_id === query.get('station_id') && s.day === query.get('day') && ['DRAFT', 'IN_PROGRESS'].includes(s.status));
      return json(res, 200, { sessions: list });
    }
    if ((m = path.match(/^\/sessions\/([\w-]+)$/))) {
      const s = state.records.session.get(m[1]);
      if (!s) return json(res, 404, { error: { code: 'NOT_FOUND' } });
      const pick = (t) => [...state.records[t].values()].filter((r) => r.data.session_id === m[1]).map((r) => ({ ...r.data, server_rev: r.server_rev }));
      return json(res, 200, { session: { ...s.data, server_rev: s.server_rev }, scans: pick('scan'), events: pick('event') });
    }
    return json(res, 404, { error: { code: 'NOT_FOUND' } });
  }
  return { handle, state };
}
