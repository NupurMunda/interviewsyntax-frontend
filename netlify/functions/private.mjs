// Sign-in and per-person data. Unlike api.mjs this is NOT a cached public proxy: it forwards a visitor's own cookies to
// the Worker and the answers belong to that one visitor, so nothing here is ever cached or shared.
//
// Browser path          Worker path            Methods
// /auth/google          /v1/auth/google        GET     (starts sign-in; the Worker answers with a redirect to Google)
// /auth/callback        /v1/auth/callback      GET     (Google sends the browser back here)
// /auth/logout          /v1/auth/logout        POST
// /auth/reauth          /v1/auth/reauth        POST
// /me                   /v1/me                 GET, DELETE
// /me/progress          /v1/me/progress        GET, PUT
// /me/companies         /v1/me/companies       GET
// /me/companies/:slug   /v1/me/companies/:slug PUT
// /me/dashboard         /v1/me/dashboard       GET
//
// Off unless the AUTH_ENABLED environment variable is exactly "true": until then every route answers 404 and the
// Worker is never called.

const TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 4096;
const MAX_QUERY_VALUE = 2048;
// The only cookies we ever forward or accept back (production names, and the plain names used on http localhost).
const SESSION_COOKIES = ['__Host-sid', 'sid'];
const OAUTH_COOKIES = ['__Host-oauth', 'oauth'];
const OUR_COOKIES = new Set([...SESSION_COOKIES, ...OAUTH_COOKIES]);
const COOKIE_VALUE = /^[A-Za-z0-9_-]{1,200}$/;
const SLUG = '[a-z0-9][a-z0-9-]{0,80}';

// session: needs a session cookie, otherwise answered here without calling the Worker.
// body: sends a JSON body. query: the only query parameters forwarded.
const ROUTES = [
  { label: '/auth/google', method: 'GET', path: /^\/auth\/google$/, upstream: '/v1/auth/google', query: ['next'] },
  { label: '/auth/callback', method: 'GET', path: /^\/auth\/callback$/, upstream: '/v1/auth/callback', query: ['code', 'state', 'error'] },
  { label: '/auth/logout', method: 'POST', path: /^\/auth\/logout$/, upstream: '/v1/auth/logout', session: 'logout' },
  { label: '/auth/reauth', method: 'POST', path: /^\/auth\/reauth$/, upstream: '/v1/auth/reauth', body: true, session: 'required' },
  { label: '/me', method: 'GET', path: /^\/me$/, upstream: '/v1/me', session: 'me' },
  { label: '/me', method: 'DELETE', path: /^\/me$/, upstream: '/v1/me', body: true, session: 'required' },
  { label: '/me/progress', method: 'GET', path: /^\/me\/progress$/, upstream: '/v1/me/progress', session: 'required' },
  { label: '/me/progress', method: 'PUT', path: /^\/me\/progress$/, upstream: '/v1/me/progress', body: true, session: 'required' },
  { label: '/me/companies', method: 'GET', path: /^\/me\/companies$/, upstream: '/v1/me/companies', session: 'required' },
  { label: '/me/companies/:slug', method: 'PUT', path: new RegExp(`^/me/companies/(${SLUG})$`), upstream: '/v1/me/companies/', body: true, session: 'required', slug: true },
  { label: '/me/marks', method: 'GET', path: /^\/me\/marks$/, upstream: '/v1/me/marks', session: 'required', query: ['type', 'status', 'page'] },
  { label: '/me/dashboard', method: 'GET', path: /^\/me\/dashboard$/, upstream: '/v1/me/dashboard', session: 'required' },
];

// Every response from here is private. Only the headers named below are ever copied from the Worker.
const privateHeaders = () => new Headers({
  'Cache-Control': 'private, no-store',
  'Netlify-CDN-Cache-Control': 'no-store',
  Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff',
});

const json = (status, body, extra = {}) => {
  const headers = privateHeaders();
  headers.set('Content-Type', 'application/json');
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(JSON.stringify(body), { status, headers });
};
const fail = (status, code, message, extra) => json(status, { error: { code, message } }, extra);

// One JSON line per call: the route pattern, method and status only. Never cookies, addresses or query values.
export default async function handler(request, context) {
  const started = Date.now();
  const { response, label } = await handle(request, context);
  console.log(JSON.stringify({ event: 'private', route: label, method: request.method, status: response.status, ms: Date.now() - started }));
  return response;
}

function filterCookies(header) {
  const kept = [];
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (OUR_COOKIES.has(name) && COOKIE_VALUE.test(value)) kept.push({ name, value });
  }
  return kept;
}

// A redirect may only go to Google's sign-in page or back to this site, never anywhere else.
function safeLocation(location, requestUrl) {
  if (!location) return null; // an empty Location would resolve to the request's own URL
  let target;
  try { target = new URL(location, requestUrl); } catch { return null; }
  if (target.protocol === 'https:' && target.host === 'accounts.google.com') return target.toString();
  if (target.host === requestUrl.host && target.protocol === requestUrl.protocol) return target.pathname + target.search;
  return null;
}

function safeSetCookies(response) {
  const kept = [];
  for (const line of response.headers.getSetCookie()) {
    const name = /^([^=;\s]+)=/.exec(line)?.[1];
    if (!name || !OUR_COOKIES.has(name)) continue;
    if (/;\s*domain\s*=/i.test(line) || line.length > 1024) continue;
    kept.push(line);
  }
  return kept;
}

async function handle(request, context) {
  const none = (response) => ({ response, label: 'unmatched' });
  if (process.env.AUTH_ENABLED !== 'true') return none(fail(404, 'not_found', 'route not found'));

  const url = new URL(request.url);
  const matches = ROUTES.filter((r) => r.path.test(url.pathname));
  if (!matches.length) return none(fail(404, 'not_found', 'route not found'));
  const route = matches.find((r) => r.method === request.method);
  const label = matches[0].label;
  if (!route) return { label, response: fail(405, 'method_not_allowed', `use ${matches.map((m) => m.method).join(' or ')}`, { Allow: matches.map((m) => m.method).join(', ') }) };

  const cookies = filterCookies(request.headers.get('cookie'));
  const hasSession = cookies.some((c) => SESSION_COOKIES.includes(c.name));
  // No session cookie means there is nobody to ask about: answer here, so signed-out visitors cost the Worker nothing.
  if (route.session && !hasSession) {
    if (route.session === 'me') return { label, response: json(200, { signedIn: false }) };
    if (route.session === 'logout') return { label, response: json(200, { ok: true }) };
    return { label, response: fail(401, 'unauthenticated', 'sign in first') };
  }

  let upstream;
  try {
    upstream = new URL(process.env.API_BASE_URL.trim().replace(/\/+$/, '') + route.upstream + (route.slug ? url.pathname.match(route.path)[1] : ''));
  } catch {
    console.error(JSON.stringify({ event: 'config_error', problem: 'API_BASE_URL is missing or not a valid URL' }));
    return { label, response: fail(500, 'misconfigured', 'the service address is not configured') };
  }
  for (const name of route.query ?? []) {
    const value = url.searchParams.get(name);
    if (value !== null && value.length <= MAX_QUERY_VALUE) upstream.searchParams.set(name, value);
  }

  // Header allow-list: nothing else from the browser reaches the Worker. The key and address are ours, never the
  // browser's (a browser-supplied x-api-key or x-client-ip is simply not copied).
  const headers = { accept: 'application/json' };
  if (cookies.length) headers.cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const origin = request.headers.get('origin');
  if (origin && origin.length <= 200) headers.origin = origin;
  if (process.env.API_KEY) headers['x-api-key'] = process.env.API_KEY;
  if (context.ip) headers['x-client-ip'] = context.ip;

  let body;
  if (route.body) {
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return { label, response: fail(415, 'unsupported_media_type', 'send JSON') };
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return { label, response: fail(413, 'too_large', 'request too large') };
    body = await request.text();
    if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) return { label, response: fail(413, 'too_large', 'request too large') };
    headers['content-type'] = 'application/json';
  }

  let upstreamResponse;
  let text = '';
  try {
    // redirect: 'manual' hands us the Worker's redirect itself (to Google, or back to the site) instead of following it.
    upstreamResponse = await fetch(upstream, { method: route.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (upstreamResponse.status < 300 || upstreamResponse.status >= 400) text = await upstreamResponse.text();
  } catch {
    return { label, response: fail(502, 'upstream_unavailable', 'the service is unavailable', { 'Retry-After': '30' }) };
  }

  const out = privateHeaders();
  for (const line of safeSetCookies(upstreamResponse)) out.append('Set-Cookie', line); // each cookie stays its own header
  const retryAfter = upstreamResponse.headers.get('retry-after');
  if (retryAfter && /^\d{1,6}$/.test(retryAfter)) out.set('Retry-After', retryAfter);

  if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
    const location = safeLocation(upstreamResponse.headers.get('location') ?? '', url);
    if (!location) {
      console.error(JSON.stringify({ event: 'bad_redirect', route: label }));
      return { label, response: fail(502, 'bad_redirect', 'the service returned an unexpected redirect') };
    }
    out.set('Location', location);
    return { label, response: new Response(null, { status: upstreamResponse.status, headers: out }) };
  }
  out.set('Content-Type', 'application/json');
  return { label, response: new Response(text, { status: upstreamResponse.status, headers: out }) };
}

export const config = { path: ['/auth/*', '/me', '/me/*'] };
