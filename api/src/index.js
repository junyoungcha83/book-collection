// 도서모음 — 동기화 API
// - GET /api/data : 누구나 읽기 (전체 JSON, rev 포함)
// - PUT /api/data : X-Edit-Token 이 EDIT_TOKEN 과 일치할 때만 저장.
//                   X-Base-Rev 가 지금 rev 와 다르면 409 + 최신본을 돌려준다
//                   (그 사이 다른 기기가 저장한 것 — 앱이 합쳐서 다시 올린다)
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
    'Access-Control-Allow-Headers': 'Content-Type, X-Edit-Token, X-Base-Rev',
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

// 저장된 문서를 읽는다. 아직 없거나 깨졌으면 빈 문서(rev 0)로 본다.
async function readDoc(env) {
  const raw = await env.BOOKS.get(KEY);
  if (!raw) return { version: 1, rev: 0, books: [] };
  try {
    const d = JSON.parse(raw);
    if (isValidShape(d)) return { ...d, rev: Number(d.rev) || 0 };
  } catch {}
  return { version: 1, rev: 0, books: [] };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    if (url.pathname === '/api/data') {
      if (req.method === 'GET') {
        const doc = await readDoc(env);      // rev 를 반드시 실어 보낸다(앱이 PUT 때 되돌려 줘야 한다)
        return new Response(JSON.stringify(doc), {
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

        // 보낸 쪽이 어느 판을 보고 고쳤는지 확인한다. 그 사이 다른 기기가 저장했으면
        // 덮어쓰지 않고 최신본을 돌려준다 — 앱이 책 단위로 합쳐 다시 올린다.
        const cur = await readDoc(env);
        // 헤더가 아예 없으면(옛 버전 앱) 검사를 건너뛴다.
        // Number(null) 은 0 이라, 없는 헤더를 그대로 숫자로 바꾸면 rev 0 으로 읽혀 전부 409 가 된다.
        const rawRev = req.headers.get('X-Base-Rev');
        const baseRev = rawRev == null || rawRev === '' ? null : Number(rawRev);
        if (baseRev !== null && Number.isFinite(baseRev) && baseRev !== cur.rev) {
          return json({ error: 'conflict', rev: cur.rev, current: cur }, 409, cors);
        }

        const next = { ...parsed, version: 1, rev: cur.rev + 1, updated_at: new Date().toISOString() };
        const out = JSON.stringify(next);
        if (out.length > MAX_BYTES) return json({ error: 'too_large' }, 413, cors);
        await env.BOOKS.put(KEY, out);
        return json({ ok: true, rev: next.rev, bytes: out.length }, 200, cors);
      }
      return json({ error: 'method_not_allowed' }, 405, cors);
    }

    if (url.pathname === '/' || url.pathname === '/api/health') {
      return json({ ok: true, service: 'book-collection-api' }, 200, cors);
    }
    return new Response('Not Found', { status: 404, headers: cors });
  },
};
