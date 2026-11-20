// Local stand-in for Netlify + the Worker, for browser tests only. Serves the site from the repo root with the same
// rewrites as netlify.toml, answers /api/v1/* with a small fixed data set, and runs the REAL netlify/functions/private.mjs
// in front of a fake Worker that follows the documented revision rule. Test controls live under /__test/*.
//
//   node tests-e2e/server.mjs <port> [auth=on|off]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import privateHandler from '../netlify/functions/private.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.argv[2] ?? 8801);
const authOn = (process.argv[3] ?? 'on') === 'on';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

process.env.API_BASE_URL = `http://127.0.0.1:${port}/__worker`;
process.env.API_KEY = 'e2e-key';
if (authOn) process.env.AUTH_ENABLED = 'true';

// ---- fixed public data -----------------------------------------------------------------------------------------------
const QUESTIONS = [
  { id: 101, title: 'How does attention work?', topics: ['LLM'], written: '2026-01-01', summary: '', concepts: [], links: [] },
  { id: 102, title: 'What is KV caching?', topics: ['LLM'], written: '2026-01-01', summary: '', concepts: [], links: [] },
];
const PUBLIC = {
  '/api/v1/ping': () => ({}),
  '/api/v1/prep/ai': () => ({ data: QUESTIONS, meta: { total: 2, questions: 2, topics: [{ name: 'LLM', answered: 2, total: 2 }], companies: [] } }),
  '/api/v1/prep/system-design': () => ({ data: [{ id: 301, title: 'Design a URL shortener', topics: [], written: null, summary: 'Short links', concepts: [], links: [] }], meta: { total: 1, questions: 1, topics: [], companies: [] } }),
  '/api/v1/companies/acme': () => ({ data: { id: 1, name: 'Acme', slug: 'acme', categories: { dsa: 2, hld: 0, ai: 1 }, profile: null } }),
  '/api/v1/companies/acme/dsa': () => ({ data: [{ id: 201, title: 'Two Sum', url: 'https://example.com/two-sum', difficulty: 'Easy', topics: ['Array'] }, { id: 202, title: 'Valid Parentheses', url: 'https://example.com/vp', difficulty: 'Easy', topics: ['Stack'] }], meta: { total: 2 } }),
  '/api/v1/companies/acme/ai': () => ({ data: [{ id: 101, title: 'How does attention work?', has_answer: true, url: null, topics: ['LLM'] }], meta: { total: 1 } }),
  '/api/v1/resources/101': () => ({ data: { id: 101, title: 'How does attention work?', category: 'ai', topics: ['LLM'], url: null, answer: null, solutions: [], companies: [] } }),
  '/api/v1/graph': () => ({ data: { nodes: [{ slug: 'acme', name: 'Acme', size: 3 }], edges: [] } }),
  '/api/v1/companies': () => ({ data: [{ id: 1, name: 'Acme', slug: 'acme', counts: { dsa: 2, hld: 0, ai: 1 } }], meta: { total: 1 } }),
};

// ---- fake Worker (the contract the real one implements; its own tests live in roundwise-backend) --------------------------
const world = {
  sessions: new Map(),   // token -> { ref, name, email }
  rows: new Map(),       // `${ref}|${key}` -> { value, rev, lastOp }
  canDelete: false, meDelay: 0, meStatus: 0, dataStatus: 0, writeDelay: 0, deleted: [], calls: [], pageHits: [],
  reauthFresh: false,
};
const reset = () => Object.assign(world, { sessions: new Map(), rows: new Map(), canDelete: false, meDelay: 0, meStatus: 0, dataStatus: 0, writeDelay: 0, deleted: [], calls: [], pageHits: [], reauthFresh: false });

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });
const cookieOf = (req) => /(?:^|;\s*)sid=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1];

async function worker(req, res, path, body) {
  world.calls.push({ method: req.method, path, hadKey: req.headers['x-api-key'] === 'e2e-key', origin: req.headers.origin ?? null });
  if (req.headers['x-api-key'] !== 'e2e-key') return send(res, 401, { error: { code: 'unauthorized' } });
  const sid = cookieOf(req);
  const session = sid ? world.sessions.get(sid) : undefined;
  if (path === '/v1/me' && req.method === 'GET') {
    if (world.meDelay) await new Promise((r) => setTimeout(r, world.meDelay));
    if (world.meStatus) return send(res, world.meStatus, { error: { code: 'unavailable' } });
    if (!session) return send(res, 401, { signedIn: false }, { 'Set-Cookie': 'sid=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax' });
    return send(res, 200, { signedIn: true, name: session.name, email: session.email, ref: session.ref, canDelete: world.canDelete });
  }
  if (path === '/v1/auth/logout') {
    if (sid) world.sessions.delete(sid);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax' });
  }
  if (path === '/v1/auth/google') { res.writeHead(302, { Location: 'https://accounts.google.com/o/oauth2/v2/auth?fake=1' }); return res.end(); }
  if (path === '/v1/auth/reauth') return send(res, 200, { redirect: 'https://accounts.google.com/o/oauth2/v2/auth?reauth=1' });
  if (!session) return send(res, 401, { error: { code: 'unauthenticated' } }, { 'Set-Cookie': 'sid=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax' });
  if (world.dataStatus) return send(res, world.dataStatus, { error: { code: 'unavailable' } });
  const mine = (kind) => [...world.rows].filter(([k]) => k.startsWith(`${session.ref}|${kind}:`)).map(([k, r]) => [k.split('|')[1], r]);
  if (path === '/v1/me/progress' && req.method === 'GET') {
    return send(res, 200, { data: { items: mine('p').map(([k, r]) => { const [, type, id] = k.split(':'); return { type, id: Number(id), status: r.value, rev: r.rev }; }) } });
  }
  if (path === '/v1/me/companies' && req.method === 'GET') {
    return send(res, 200, { data: { items: mine('c').map(([k, r]) => ({ slug: k.split(':')[1], tracked: r.value, rev: r.rev })) } });
  }
  if (path === '/v1/me/dashboard') {
    const done = (type) => mine('p').filter(([k, r]) => k.startsWith(`p:${type}:`) && r.value === 'done').length;
    const revisit = (type) => mine('p').filter(([k, r]) => k.startsWith(`p:${type}:`) && r.value === 'revisit').length;
    return send(res, 200, { data: {
      totals: { company_dsa: { done: done('company_dsa'), revisit: revisit('company_dsa'), total: 2 }, ai: { done: done('ai'), revisit: revisit('ai'), total: 2 }, system_design: { done: done('system_design'), revisit: revisit('system_design'), total: 1 } },
      companies: mine('c').filter(([, r]) => r.value).map(([k]) => ({ slug: k.split(':')[1], name: 'Acme', tracked: true, dsa: { done: 0, revisit: 0, total: 2 }, hld: { done: 0, revisit: 0, total: 0 }, ai: { done: 0, revisit: 0, total: 1 } })),
    } });
  }
  if (path === '/v1/me' && req.method === 'DELETE') {
    if (!world.canDelete) return send(res, 403, { error: { code: 'deletion_unavailable' } });
    const input = JSON.parse(body || '{}');
    if (String(input.confirm).toLowerCase() !== 'delete my account') return send(res, 400, { error: { code: 'confirmation_required' } });
    if (!world.reauthFresh) return send(res, 403, { error: { code: 'reauth_required' } });
    for (const k of [...world.rows.keys()]) if (k.startsWith(`${session.ref}|`)) world.rows.delete(k);
    world.sessions.delete(sid);
    world.deleted.push(session.ref);
    return send(res, 200, { data: { state: 'complete', clearLocalData: true } }, { 'Set-Cookie': 'sid=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax' });
  }
  const put = path === '/v1/me/progress' ? 'p' : path.startsWith('/v1/me/companies/') ? 'c' : null;
  if (put && req.method === 'PUT') {
    if (world.writeDelay) await new Promise((r) => setTimeout(r, world.writeDelay));
    const input = JSON.parse(body);
    const key = put === 'p' ? `p:${input.type}:${input.id}` : `c:${path.split('/').pop()}`;
    const value = put === 'p' ? input.status : input.tracked;
    const id = `${session.ref}|${key}`;
    const row = world.rows.get(id);
    const shape = (r) => (put === 'p' ? { status: r?.value ?? null, rev: r?.rev ?? 0 } : { tracked: r?.value ?? false, rev: r?.rev ?? 0 });
    if ((row && row.rev === input.baseRev) || (!row && input.baseRev === 0)) {
      world.rows.set(id, { value, rev: (row?.rev ?? 0) + 1, lastOp: input.opId });
      return send(res, 200, { data: shape(world.rows.get(id)) });
    }
    if (row?.lastOp === input.opId) return send(res, 200, { data: { ...shape(row), duplicate: true } });
    return send(res, 409, { error: { code: 'conflict' }, current: shape(row) });
  }
  return send(res, 404, { error: { code: 'not_found' } });
}

// ---- the site --------------------------------------------------------------------------------------------------------
const REWRITES = [[/^\/c\/.+/, '/company.html'], [/^\/prep\/.+/, '/prep.html'], [/^\/q\/.+/, '/question.html'], [/^\/sources$/, '/sources.html'], [/^\/privacy$/, '/privacy.html'], [/^\/dashboard$/, '/dashboard.html']];

async function toRequest(req, url, body) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  return new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const path = url.pathname;
  try {
    if (path.startsWith('/__test/')) {
      if (path === '/__test/reset') { reset(); return send(res, 200, {}); }
      if (path === '/__test/state') return send(res, 200, { rows: Object.fromEntries(world.rows), calls: world.calls, deleted: world.deleted, pageHits: world.pageHits });
      const input = JSON.parse((await readBody(req)) || '{}');
      if (path === '/__test/session') { world.sessions.set(input.token, { ref: input.ref, name: input.name ?? 'Ada Lovelace', email: input.email ?? 'ada@example.com' }); return send(res, 200, {}); }
      if (path === '/__test/expire') { world.sessions.clear(); return send(res, 200, {}); }
      if (path === '/__test/config') { Object.assign(world, input); return send(res, 200, {}); }
      if (path === '/__test/row') { world.rows.set(`${input.ref}|${input.key}`, { value: input.value, rev: input.rev, lastOp: 'seed-op-xxxx' }); return send(res, 200, {}); }
      if (path === '/__test/drop') { world.rows.delete(`${input.ref}|${input.key}`); return send(res, 200, {}); }
      return send(res, 404, {});
    }
    if (path.startsWith('/__worker/')) return await worker(req, res, path.slice('/__worker'.length), await readBody(req));
    if (path.startsWith('/api/v1/')) {
      const make = PUBLIC[path];
      return make ? send(res, 200, make(), { 'Cache-Control': 'public, max-age=300' }) : send(res, 404, { error: { code: 'not_found' } });
    }
    if (path === '/auth/callback' || path.startsWith('/auth/') || path === '/me' || path.startsWith('/me/')) {
      world.pageHits.push(`${req.method} ${path}`);
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
      const response = await privateHandler(await toRequest(req, `http://127.0.0.1:${port}${req.url}`, body), { ip: '127.0.0.1' });
      const headers = {};
      for (const [k, v] of response.headers) if (k !== 'set-cookie') headers[k] = v;
      headers['set-cookie'] = response.headers.getSetCookie();
      res.writeHead(response.status, headers);
      return res.end(Buffer.from(await response.arrayBuffer()));
    }
    let file = path === '/' ? '/index.html' : path;
    for (const [pattern, target] of REWRITES) if (pattern.test(path)) file = target;
    if (/^\/(netlify|tests|tests-e2e|node_modules|\.git)\//.test(file)) file = '/404.html';
    const abs = normalize(join(ROOT, file));
    if (!abs.startsWith(ROOT)) throw new Error('outside root');
    const data = await readFile(abs).catch(() => null);
    if (!data) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end(await readFile(join(ROOT, '404.html'))); }
    res.writeHead(200, { 'Content-Type': TYPES[extname(abs)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    return res.end(data);
  } catch (error) {
    console.error(error);
    res.writeHead(500); res.end('error');
  }
}).listen(port, '127.0.0.1', () => console.log(`e2e server on ${port} (auth ${authOn ? 'on' : 'off'})`));
