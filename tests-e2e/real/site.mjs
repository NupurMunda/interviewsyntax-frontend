// The site for the real-stack browser tests: the static pages with netlify.toml's rewrites, the REAL Netlify functions
// (api.mjs for /api/*, private.mjs for /auth/* and /me*) in front of the REAL Worker (scripts/e2e-real-backend.mjs in
// roundwise-backend, on local D1), and a small local "Google" at /__idp so the whole sign-in flow runs end to end.
//
//   node tests-e2e/real/site.mjs [port] [backendPort]
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2] ?? 8812);
const backend = Number(process.argv[3] ?? 8811);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

process.env.API_BASE_URL = `http://127.0.0.1:${backend}`;
process.env.API_KEY = 'e2e-real-proxy-key';
process.env.AUTH_ENABLED = 'true';
const { default: apiHandler } = await import('../../netlify/functions/api.mjs');
const { default: privateHandler } = await import('../../netlify/functions/private.mjs');

// ---- local Google --------------------------------------------------------------------------------------------------
const CLIENT_ID = 'e2e-client-id.apps.test';
const CLIENT_SECRET = 'e2e-client-secret';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'e2e-key-1', alg: 'RS256', use: 'sig' };
const ACCOUNTS = {
  ada: { sub: 'g-ada-1', name: 'Ada Lovelace', email: 'ada@example.com' },
  grace: { sub: 'g-grace-2', name: 'Grace Hopper', email: 'grace@example.com' },
};
const idp = { codes: new Map(), omitAuthTime: false, authTimeOffsetS: 0, requests: [] };
const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
function idToken(account, nonce, withAuthTime) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: account.sub, name: account.name, email: account.email, email_verified: true, iat: now, exp: now + 600, nonce };
  if (withAuthTime && !idp.omitAuthTime) claims.auth_time = now + idp.authTimeOffsetS;
  const head = b64({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' });
  const body = b64(claims);
  const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}
const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function authorize(url, res) {
  const q = url.searchParams;
  idp.requests.push(Object.fromEntries(q));
  if (q.get('client_id') !== CLIENT_ID || !q.get('redirect_uri') || !q.get('state') || q.get('code_challenge_method') !== 'S256') {
    res.writeHead(400); return res.end('bad authorization request');
  }
  const links = Object.entries(ACCOUNTS).map(([key, a]) => {
    const next = new URLSearchParams(q);
    next.set('acct', key);
    return `<li><a href="/__idp/approve?${esc(next)}">${esc(a.name)} (${esc(a.email)})</a></li>`;
  }).join('');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>Local Google</title><h1>Choose an account</h1><p>Local test provider.</p><ul>${links}</ul><p><a href="${esc(q.get('redirect_uri'))}?error=access_denied&state=${esc(q.get('state'))}">Cancel</a></p>`);
}

function approve(url, res) {
  const q = url.searchParams;
  const account = ACCOUNTS[q.get('acct')];
  if (!account) { res.writeHead(400); return res.end('no such account'); }
  const code = randomBytes(16).toString('hex');
  idp.codes.set(code, { account, nonce: q.get('nonce'), challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri'), reauth: q.get('prompt') === 'login' && (q.get('claims') ?? '').includes('auth_time') });
  const back = new URL(q.get('redirect_uri'));
  back.searchParams.set('code', code);
  back.searchParams.set('state', q.get('state'));
  res.writeHead(302, { Location: back.toString() });
  res.end();
}

async function token(req, res) {
  const form = new URLSearchParams(await readBody(req));
  const entry = idp.codes.get(form.get('code'));
  idp.codes.delete(form.get('code')); // single use, like the real thing
  const verifier = form.get('code_verifier') ?? '';
  const ok = entry && form.get('client_id') === CLIENT_ID && form.get('client_secret') === CLIENT_SECRET && form.get('redirect_uri') === entry.redirectUri
    && createHash('sha256').update(verifier).digest('base64url') === entry.challenge;
  res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(ok ? { id_token: idToken(entry.account, entry.nonce, entry.reauth), token_type: 'Bearer' } : { error: 'invalid_grant' }));
}

// ---- plumbing ------------------------------------------------------------------------------------------------------
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });
async function toRequest(req, body) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  return new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
}
async function sendResponse(res, response) {
  const headers = {};
  for (const [k, v] of response.headers) if (k !== 'set-cookie') headers[k] = v;
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}
const REWRITES = [[/^\/c\/.+/, '/company.html'], [/^\/prep\/.+/, '/prep.html'], [/^\/q\/.+/, '/question.html'], [/^\/sources$/, '/sources.html'], [/^\/privacy$/, '/privacy.html'], [/^\/dashboard$/, '/dashboard.html']];

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const path = url.pathname;
  try {
    if (path === '/__idp/authorize') return authorize(url, res);
    if (path === '/__idp/approve') return approve(url, res);
    if (path === '/__idp/token' && req.method === 'POST') return await token(req, res);
    if (path === '/__idp/certs') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ keys: [jwk] })); }
    if (path === '/__test/idp') {
      const input = JSON.parse((await readBody(req)) || '{}');
      if ('omitAuthTime' in input) idp.omitAuthTime = input.omitAuthTime;
      if ('authTimeOffsetS' in input) idp.authTimeOffsetS = input.authTimeOffsetS;
      if (input.reset) { idp.omitAuthTime = false; idp.authTimeOffsetS = 0; idp.requests = []; idp.codes.clear(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ requests: idp.requests }));
    }
    if (path === '/__test/sql' || path === '/__test/scheduled') {
      const target = path === '/__test/sql' ? `/__test/sql` : '/__scheduled?cron=*/15+*+*+*+*';
      const upstream = await fetch(`http://127.0.0.1:${backend}${target}`, { method: path === '/__test/sql' ? 'POST' : 'GET', body: path === '/__test/sql' ? await readBody(req) : undefined, headers: { 'Content-Type': 'application/json' } });
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      return res.end(await upstream.text());
    }
    if (path.startsWith('/api/') || path.startsWith('/auth/') || path === '/me' || path.startsWith('/me/')) {
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
      const handler = path.startsWith('/api/') ? apiHandler : privateHandler;
      const response = await handler(await toRequest(req, body), { ip: '127.0.0.1' });
      // The proxy correctly lets a redirect to accounts.google.com through. Here (test harness only) the browser is sent to the
      // local Google instead, so a test can never reach the real one: redirect chains are not reliably interceptable in the browser.
      const location = response.headers.get('location') ?? '';
      if (location.startsWith('https://accounts.google.com/o/oauth2/v2/auth')) {
        const headers = new Headers(response.headers);
        headers.set('location', location.replace('https://accounts.google.com/o/oauth2/v2/auth', '/__idp/authorize'));
        return await sendResponse(res, new Response(null, { status: response.status, headers }));
      }
      return await sendResponse(res, response);
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
}).listen(port, '127.0.0.1', () => console.log(`real-stack site on ${port} (Worker on ${backend})`));
