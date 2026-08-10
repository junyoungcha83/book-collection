// 도서모음 — 동기화 API
// - GET /api/data : 누구나 읽기 (전체 JSON)
// - PUT /api/data : X-Edit-Token 이 EDIT_TOKEN 과 일치할 때만 전체 저장
// KV: BOOKS (단일 키 "doso-data")  ·  Secret: EDIT_TOKEN

const KEY = 'doso-data';
const MAX_BYTES = 10 * 1024 * 1024;   // 10MB (그림 포함 여유)

const ALLOWED_ORIGINS = [
  'https://junyoungcha83.github.io',
  'http://localhost:8000',
  'http://localhost:8080',
  'http://127.0.0.1:8000',
];

function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Edit-Token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
function json(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}
function isValidShape(p) { return p && typeof p === 'object' && Array.isArray(p.books); }

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    if (url.pathname === '/api/data') {
      if (req.method === 'GET') {
        const raw = await env.BOOKS.get(KEY);
        return new Response(raw || JSON.stringify({ version: 1, books: [] }), {
          headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
      if (req.method === 'PUT') {
        const token = req.headers.get('X-Edit-Token') || '';
        if (!env.EDIT_TOKEN || token !== env.EDIT_TOKEN) return json({ error: 'unauthorized' }, 401, cors);
        const body = await req.text();
        if (body.length > MAX_BYTES) return json({ error: 'too_large' }, 413, cors);
        let parsed;
        try { parsed = JSON.parse(body); } catch { return json({ error: 'invalid_json' }, 400, cors); }
        if (!isValidShape(parsed)) return json({ error: 'invalid_shape' }, 400, cors);
        await env.BOOKS.put(KEY, body);
        return json({ ok: true, bytes: body.length }, 200, cors);
      }
      return json({ error: 'method_not_allowed' }, 405, cors);
    }

    if (url.pathname === '/' || url.pathname === '/api/health') {
      return json({ ok: true, service: 'book-collection-api' }, 200, cors);
    }
    return new Response('Not Found', { status: 404, headers: cors });
  },
};
