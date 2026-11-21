const ALLOWED_PATH = /^\/api\/v1\/(health|graph|companies|companies\/[a-z0-9-]+(\/(dsa|hld|ai|behavioral))?|resources\/[0-9]+|prep\/(ai|system-design)|sources|ping)$/;
const FORWARDED_PARAMS = ['q', 'page', 'limit', 'time_window', 'difficulty', 'topic', 'kind', 'company', 'category', 'status'];
const TIMEOUT_MS = 8000;

// Two lifetimes in the shared CDN cache (durable = one copy across edge nodes), because every backend read counts against a
// free daily allowance and every uncached call is also a function run here.
//  - Company data, the graph, single questions and sources change only when the content is rebuilt: one hour, and while a copy
//    refreshes it may be served stale for up to a day, so a busy hour costs each URL one backend call.
//  - Prep lists receive new answers in batches: at most 5 minutes old, stale for up to 10 more while it refreshes.
// Only 200 answers are kept; an error is never cached. Browsers keep either for 5 minutes.
const CDN_CACHE_CONTENT = 'public, durable, s-maxage=3600, stale-while-revalidate=86400';
const CDN_CACHE_PREP = 'public, durable, s-maxage=300, stale-while-revalidate=600';
const SLOW_CHANGING = /^\/api\/v1\/(graph|companies(\/[a-z0-9-]+(\/(dsa|hld|ai|behavioral))?)?|resources\/[0-9]+|sources)$/;
const BROWSER_CACHE = 'public, max-age=300';

const fail = (status, code, message, headers = {}) =>
  Response.json({ error: { code, message } }, { status, headers });

// One JSON line per call that reaches the function (CDN hits never do): path and status only, no IPs or query values.
export default async function handler(request, context) {
  const started = Date.now();
  const response = await handle(request, context);
  console.log(JSON.stringify({ event: 'api', path: new URL(request.url).pathname, backend: backendHost(), status: response.status, ms: Date.now() - started }));
  return response;
}

// Which backend this deploy talks to (the host only), so a wrong API_BASE_URL is visible in the function logs.
function backendHost() {
  try {
    return new URL(process.env.API_BASE_URL).host;
  } catch {
    return null;
  }
}

async function handle(request, context) {
  if (request.method !== 'GET') return fail(405, 'method_not_allowed', 'only GET is allowed', { Allow: 'GET' });

  const url = new URL(request.url);
  if (!ALLOWED_PATH.test(url.pathname)) return fail(404, 'not_found', 'route not found');

  let upstream;
  try {
    upstream = new URL(process.env.API_BASE_URL.trim().replace(/\/+$/, '') + url.pathname.slice('/api'.length));
  } catch {
    console.error(JSON.stringify({ event: 'config_error', problem: 'API_BASE_URL is missing or not a valid URL' }));
    return fail(500, 'misconfigured', 'the data service address is not configured');
  }
  for (const name of FORWARDED_PARAMS) {
    const value = url.searchParams.get(name);
    if (value !== null) upstream.searchParams.set(name, value);
  }

  const headers = { Accept: 'application/json' };
  if (process.env.API_KEY) headers['x-api-key'] = process.env.API_KEY;
  if (context.ip) headers['x-client-ip'] = context.ip;
  // Only the usage ping gets the browser's user agent, so the backend can set aside crawlers and monitors. It is used for that one
  // decision and never stored.
  const agent = url.pathname === '/api/v1/ping' ? request.headers.get('user-agent') : null;
  if (agent) headers['x-client-ua'] = agent.slice(0, 200);

  let response, body;
  try {
    response = await fetch(upstream, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    body = await response.json();
  } catch {
    return fail(502, 'upstream_unavailable', 'the data service is unavailable', { 'Retry-After': '30' });
  }

  const out = {};
  if (url.pathname === '/api/v1/ping') {
    out['Cache-Control'] = 'no-store'; // every visit must reach the backend to be counted
  } else if (response.status === 200) {
    out['Cache-Control'] = BROWSER_CACHE;
    out['Netlify-CDN-Cache-Control'] = SLOW_CHANGING.test(url.pathname) ? CDN_CACHE_CONTENT : CDN_CACHE_PREP;
  }
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) out['Retry-After'] = retryAfter;
  return Response.json(body, { status: response.status, headers: out });
}

export const config = { path: '/api/*' };
