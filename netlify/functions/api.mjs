const ALLOWED_PATH = /^\/api\/v1\/(health|graph|companies|companies\/[a-z0-9-]+(\/(dsa|hld|ai|behavioral))?|resources\/[0-9]+|prep\/(ai|system-design)|sources|ping)$/;
const FORWARDED_PARAMS = ['q', 'page', 'limit', 'time_window', 'difficulty', 'topic', 'kind', 'company', 'category', 'status'];
const TIMEOUT_MS = 8000;

// New answers are added in batches, so a copy may be at most 5 minutes old in the shared CDN cache (durable = one
// copy across edge nodes) and, while it refreshes, stale for up to 10 more. Repeat visitors still never reach the
// backend: each URL costs about 12 backend reads an hour at most, however many people ask.
const CDN_CACHE = 'public, durable, s-maxage=300, stale-while-revalidate=600';
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
    out['Netlify-CDN-Cache-Control'] = CDN_CACHE;
  }
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) out['Retry-After'] = retryAfter;
  return Response.json(body, { status: response.status, headers: out });
}

export const config = { path: '/api/*' };
