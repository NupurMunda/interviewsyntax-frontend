import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import handler, { config } from '../netlify/functions/private.mjs';
import publicHandler, { config as publicConfig } from '../netlify/functions/api.mjs';

const realFetch = globalThis.fetch;
let calls;
let reply;

beforeEach(() => {
  process.env.API_BASE_URL = 'https://backend.example.test/';
  process.env.API_KEY = 'proxy-secret-key';
  process.env.AUTH_ENABLED = 'true';
  calls = [];
  reply = () => Response.json({ ok: true });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return reply();
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.AUTH_ENABLED;
});

const SITE = 'https://site.test';
const SID = '__Host-sid=sessionTokenValue_123-abc';
const call = (path, { method = 'GET', headers = {}, body, ip = '198.51.100.9' } = {}) =>
  handler(new Request(`${SITE}${path}`, { method, headers, ...(body === undefined ? {} : { body }) }), { ip });
const json = { 'content-type': 'application/json' };
const lastHeaders = () => calls[0].init.headers;

describe('feature flag', () => {
  it('is off unless AUTH_ENABLED is exactly "true": every route is 404 and the Worker is never called', async () => {
    for (const value of [undefined, '', 'false', 'TRUE', '1', 'true ']) {
      if (value === undefined) delete process.env.AUTH_ENABLED; else process.env.AUTH_ENABLED = value;
      for (const [path, method] of [['/me', 'GET'], ['/auth/google', 'GET'], ['/me/progress', 'PUT'], ['/auth/logout', 'POST']]) {
        const res = await call(path, { method, headers: { cookie: SID, ...json }, body: method === 'GET' ? undefined : '{}' });
        assert.equal(res.status, 404, `${method} ${path} with flag ${JSON.stringify(value)}`);
        assert.equal(res.headers.get('cache-control'), 'private, no-store');
      }
    }
    assert.equal(calls.length, 0);
  });
});

describe('routes and methods', () => {
  const ok = [
    ['GET', '/auth/google', '/v1/auth/google'], ['GET', '/auth/callback', '/v1/auth/callback'],
    ['POST', '/auth/logout', '/v1/auth/logout'], ['POST', '/auth/reauth', '/v1/auth/reauth'],
    ['GET', '/me', '/v1/me'], ['DELETE', '/me', '/v1/me'], ['GET', '/me/progress', '/v1/me/progress'], ['PUT', '/me/progress', '/v1/me/progress'],
    ['GET', '/me/companies', '/v1/me/companies'], ['PUT', '/me/companies/acme-corp', '/v1/me/companies/acme-corp'], ['GET', '/me/dashboard', '/v1/me/dashboard'],
  ];
  it('maps each allowed route to its Worker path, and nothing else', async () => {
    for (const [method, path, upstream] of ok) {
      calls = [];
      const res = await call(path, { method, headers: { cookie: SID, ...json }, body: ['GET'].includes(method) || path === '/auth/logout' ? undefined : '{}' });
      assert.notEqual(res.status, 404, `${method} ${path}`);
      assert.equal(new URL(calls[0].url).pathname, upstream, `${method} ${path}`);
      assert.equal(new URL(calls[0].url).origin, 'https://backend.example.test');
      assert.equal(calls[0].init.method, method);
    }
  });

  it('answers 404 for every other path, including look-alikes, traversal and public API paths', async () => {
    for (const path of ['/', '/auth', '/auth/', '/auth/other', '/auth/google/', '/Auth/google', '/me/', '/me/other', '/me/progress/extra', '/mex', '/me/companies/Bad_Slug',
      '/me/companies/UPPER', '/me/companies/', '/me/companies/a/b', '/me//progress', '/me/progress%2Fx', '/api/v1/me', '/v1/me', '/admin', '/auth/callback/x']) {
      const res = await call(path, { headers: { cookie: SID } });
      assert.equal(res.status, 404, path);
    }
    assert.equal(calls.length, 0);
  });

  it('answers 405 with the allowed methods for a known path and the wrong method', async () => {
    for (const [method, path, allow] of [['POST', '/me', 'GET, DELETE'], ['PUT', '/me', 'GET, DELETE'], ['GET', '/auth/logout', 'POST'], ['DELETE', '/me/progress', 'GET, PUT'],
      ['PATCH', '/me/progress', 'GET, PUT'], ['POST', '/auth/google', 'GET'], ['GET', '/me/companies/acme', 'PUT'], ['HEAD', '/me', 'GET, DELETE'], ['OPTIONS', '/me/dashboard', 'GET']]) {
      const res = await call(path, { method, headers: { cookie: SID } });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.get('allow'), allow);
    }
    assert.equal(calls.length, 0);
  });

  it('claims exactly its own paths in the Netlify config, and not the public API', () => {
    assert.deepEqual(config.path, ['/auth/*', '/me', '/me/*']);
    assert.deepEqual(publicConfig.path, '/api/*');
  });
});

describe('request headers: strict allow-list', () => {
  it('forwards only accept, filtered cookies, origin and the content type, plus our own key and the visitor address', async () => {
    await call('/me/progress', {
      method: 'PUT', body: '{"a":1}', ip: '203.0.113.5',
      headers: {
        ...json, cookie: SID, origin: SITE, authorization: 'Bearer stolen', 'user-agent': 'x', 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '8.8.8.8', 'cf-connecting-ip': '7.7.7.7',
        host: 'evil.test', referer: 'https://evil.test/', 'x-custom': 'y', 'accept-language': 'en', forwarded: 'for=1.1.1.1', 'proxy-authorization': 'z',
      },
    });
    assert.deepEqual(Object.keys(lastHeaders()).sort(), ['accept', 'content-type', 'cookie', 'origin', 'x-api-key', 'x-client-ip']);
    assert.equal(lastHeaders()['x-api-key'], 'proxy-secret-key');
    assert.equal(lastHeaders()['x-client-ip'], '203.0.113.5');
    assert.equal(lastHeaders().origin, SITE);
  });

  it('never copies a browser-supplied x-api-key or x-client-ip (spoofing the proxy identity or the rate-limit address)', async () => {
    await call('/me', { headers: { cookie: SID, 'x-api-key': 'attacker-key', 'x-client-ip': '6.6.6.6' }, ip: '203.0.113.5' });
    assert.equal(lastHeaders()['x-api-key'], 'proxy-secret-key');
    assert.equal(lastHeaders()['x-client-ip'], '203.0.113.5');
    delete process.env.API_KEY;
    calls = [];
    await call('/me', { headers: { cookie: SID, 'x-api-key': 'attacker-key' }, ip: null });
    assert.equal(lastHeaders()['x-api-key'], undefined);
    assert.equal(lastHeaders()['x-client-ip'], undefined);
  });

  it('forwards only our two cookies, with sane values, and drops every other cookie', async () => {
    await call('/me', { headers: { cookie: `analytics=1; ${SID}; __Host-oauth=state_value-1; other=x; tracking=very-long; sid=; __Host-sid2=bad; =novalue; bad value=1` } });
    assert.equal(lastHeaders().cookie, '__Host-sid=sessionTokenValue_123-abc; __Host-oauth=state_value-1');
    calls = [];
    await call('/me', { headers: { cookie: '__Host-sid=has space; also=1; __Host-sid=ok_value' } });
    assert.equal(lastHeaders().cookie, '__Host-sid=ok_value');
    calls = [];
    await call('/me', { headers: { cookie: `__Host-sid=${'a'.repeat(300)}` } }); // implausible value: not forwarded, so treated as signed out
    assert.equal(calls.length, 0);
  });

  it('forwards the plain local cookie names too', async () => {
    await call('/me', { headers: { cookie: 'sid=localvalue; oauth=st' } });
    assert.equal(lastHeaders().cookie, 'sid=localvalue; oauth=st');
  });

  it('ignores an oversized origin header', async () => {
    await call('/me', { headers: { cookie: SID, origin: `https://${'a'.repeat(300)}.test` } });
    assert.equal(lastHeaders().origin, undefined);
  });
});

describe('query strings and bodies', () => {
  it('forwards only the named query parameters, and not oversized ones', async () => {
    await call('/auth/google?next=%2Fprep%2Fai&evil=1&code=x&state=y');
    assert.deepEqual([...new URL(calls[0].url).searchParams.entries()], [['next', '/prep/ai']]);
    calls = [];
    await call('/auth/callback?code=c&state=s&error=e&scope=email%20profile&authuser=0&prompt=consent&hd=x&next=%2F', { headers: { cookie: '__Host-oauth=st' } });
    assert.deepEqual([...new URL(calls[0].url).searchParams.keys()].sort(), ['code', 'error', 'state']);
    calls = [];
    await call(`/auth/google?next=${'a'.repeat(3000)}`);
    assert.equal(new URL(calls[0].url).searchParams.get('next'), null);
    calls = [];
    await call('/me?anything=1', { headers: { cookie: SID } });
    assert.equal(new URL(calls[0].url).search, '');
  });

  it('forwards JSON bodies unchanged and refuses other types and oversized bodies without calling the Worker', async () => {
    const body = JSON.stringify({ type: 'ai', id: 1, status: 'done', baseRev: 0, opId: 'op-12345678' });
    await call('/me/progress', { method: 'PUT', headers: { ...json, cookie: SID }, body });
    assert.equal(calls[0].init.body, body);
    calls = [];
    assert.equal((await call('/me/progress', { method: 'PUT', headers: { 'content-type': 'text/plain', cookie: SID }, body })).status, 415);
    assert.equal((await call('/me/progress', { method: 'PUT', headers: { cookie: SID }, body })).status, 415);
    assert.equal((await call('/me/progress', { method: 'PUT', headers: { ...json, cookie: SID }, body: JSON.stringify({ pad: 'x'.repeat(5000) }) })).status, 413);
    assert.equal((await call('/me/progress', { method: 'PUT', headers: { ...json, cookie: SID, 'content-length': '999999' }, body: '{}' })).status, 413);
    assert.equal((await call('/me', { method: 'DELETE', headers: { cookie: SID }, body: '{}' })).status, 415);
    assert.equal(calls.length, 0);
  });

  it('does not forward a body on routes that take none', async () => {
    await call('/auth/logout', { method: 'POST', headers: { cookie: SID, origin: SITE, ...json }, body: '{"x":1}' });
    assert.equal(calls[0].init.body, undefined);
    assert.equal(lastHeaders()['content-type'], undefined);
  });
});

describe('signed-out visitors cost the Worker nothing', () => {
  it('answers /me locally with {signedIn:false} when there is no session cookie', async () => {
    for (const cookie of [undefined, 'analytics=1', '__Host-oauth=only-the-attempt-cookie']) {
      const res = await call('/me', { headers: cookie ? { cookie } : {} });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { signedIn: false });
      assert.equal(res.headers.get('cache-control'), 'private, no-store');
    }
    assert.equal(calls.length, 0);
  });

  it('answers 401 locally for data routes and reauth without a session cookie, and 200 for a logout with nothing to end', async () => {
    for (const [method, path] of [['GET', '/me/progress'], ['PUT', '/me/progress'], ['GET', '/me/companies'], ['PUT', '/me/companies/acme'], ['GET', '/me/dashboard'], ['DELETE', '/me'], ['POST', '/auth/reauth']]) {
      const res = await call(path, { method, headers: json, body: method === 'GET' ? undefined : '{}' });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
    const logout = await call('/auth/logout', { method: 'POST', headers: { origin: SITE } });
    assert.deepEqual([logout.status, await logout.json()], [200, { ok: true }]);
    assert.equal(calls.length, 0);
  });

  it('still starts sign-in and handles the callback without a session cookie', async () => {
    reply = () => new Response(null, { status: 302, headers: { location: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' } });
    assert.equal((await call('/auth/google')).status, 302);
    assert.equal((await call('/auth/callback?code=c&state=s', { headers: { cookie: '__Host-oauth=st' } })).status, 302);
    assert.equal(calls.length, 2);
  });
});

describe('redirects are never followed, and only safe ones are passed on', () => {
  it('asks fetch not to follow redirects', async () => {
    await call('/auth/google');
    assert.equal(calls[0].init.redirect, 'manual');
    assert.equal(calls[0].init.method, 'GET');
  });

  it('passes the redirect to Google through, with its status and no body', async () => {
    const target = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=abc';
    reply = () => new Response('ignored', { status: 302, headers: { location: target, 'set-cookie': '__Host-oauth=abc; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600' } });
    const res = await call('/auth/google?next=%2Fprep');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), target);
    assert.equal(await res.text(), '');
    assert.match(res.headers.get('set-cookie'), /^__Host-oauth=abc;/);
  });

  it('turns a redirect back to this site into a relative one', async () => {
    reply = () => new Response(null, { status: 302, headers: { location: `${SITE}/prep/ai?topic=x` } });
    const res = await call('/auth/callback?code=c&state=s', { headers: { cookie: '__Host-oauth=st' } });
    assert.equal(res.headers.get('location'), '/prep/ai?topic=x');
    reply = () => new Response(null, { status: 302, headers: { location: '/?auth_error=denied' } });
    assert.equal((await call('/auth/callback?error=access_denied&state=s', { headers: { cookie: '__Host-oauth=st' } })).headers.get('location'), '/?auth_error=denied');
  });

  it('refuses a redirect anywhere else with a 502 and sets no cookies', async () => {
    for (const location of ['https://evil.test/', 'http://accounts.google.com/', 'https://accounts.google.com.evil.test/', '//evil.test/x', 'https://site.test.evil.test/', 'http://site.test/', 'javascript:alert(1)', '']) {
      reply = () => new Response(null, { status: 302, headers: { location, 'set-cookie': '__Host-sid=stolen; Path=/' } });
      const res = await call('/auth/callback?code=c&state=s', { headers: { cookie: '__Host-oauth=st' } });
      assert.equal(res.status, 502, `location ${JSON.stringify(location)}`);
      assert.equal(res.headers.get('set-cookie'), null);
      assert.equal(res.headers.get('location'), null);
    }
  });
});

describe('Set-Cookie handling', () => {
  it('keeps several cookies as separate headers, in order, untouched', async () => {
    const clear = '__Host-oauth=; Max-Age=0; Path=/; Secure';
    const session = '__Host-sid=newSessionToken_9; Max-Age=7776000; Path=/; HttpOnly; Secure; SameSite=Lax';
    reply = () => { const h = new Headers({ location: '/prep' }); h.append('set-cookie', clear); h.append('set-cookie', session); return new Response(null, { status: 302, headers: h }); };
    const res = await call('/auth/callback?code=c&state=s', { headers: { cookie: '__Host-oauth=st' } });
    assert.deepEqual(res.headers.getSetCookie(), [clear, session]);
  });

  it('drops cookies that are not ours or that set a Domain', async () => {
    reply = () => {
      const h = new Headers();
      h.append('set-cookie', 'tracker=1; Path=/');
      h.append('set-cookie', '__Host-sid=a; Domain=.evil.test; Path=/; Secure');
      h.append('set-cookie', '__Host-sid=ok; Path=/; HttpOnly; Secure');
      h.append('set-cookie', `__Host-sid=${'x'.repeat(2000)}; Path=/`);
      return Response.json({}, { headers: h });
    };
    const res = await call('/me', { headers: { cookie: SID } });
    assert.deepEqual(res.headers.getSetCookie(), ['__Host-sid=ok; Path=/; HttpOnly; Secure']);
  });
});

describe('responses are private and uncacheable', () => {
  const NO_STORE = ['cache-control', 'private, no-store'];
  it('sets no-store, no CDN caching and Vary: Cookie on every kind of response, and ignores the Worker\'s own cache headers', async () => {
    reply = () => Response.json({ signedIn: true }, { headers: { 'cache-control': 'public, max-age=3600', 'netlify-cdn-cache-control': 'public, s-maxage=600', etag: '"x"', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT', server: 'cloudflare', 'x-debug': '1', 'access-control-allow-origin': '*' } });
    const responses = [
      await call('/me', { headers: { cookie: SID } }),                                 // proxied success
      await call('/me'),                                                                // answered locally
      await call('/me/progress'),                                                       // answered locally (401)
      await call('/nope'),                                                              // 404
      await call('/me', { method: 'POST' }),                                            // 405
      await call('/me/progress', { method: 'PUT', headers: { ...json, cookie: SID }, body: JSON.stringify({ pad: 'x'.repeat(5000) }) }), // 413
    ];
    reply = () => { throw new Error('network'); };
    responses.push(await call('/me', { headers: { cookie: SID } }));                    // 502
    reply = () => new Response('{}', { status: 503 });
    responses.push(await call('/me', { headers: { cookie: SID } }));                    // passed-through 503
    for (const res of responses) {
      assert.equal(res.headers.get(NO_STORE[0]), NO_STORE[1], `status ${res.status}`);
      assert.equal(res.headers.get('netlify-cdn-cache-control'), 'no-store');
      assert.match(res.headers.get('vary'), /Cookie/);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      for (const leaked of ['etag', 'last-modified', 'server', 'x-debug', 'access-control-allow-origin']) assert.equal(res.headers.get(leaked), null, `${leaked} on ${res.status}`);
    }
  });

  it('passes status and JSON through for Worker answers, including conflicts, limits and outages', async () => {
    for (const [status, body] of [[200, { data: { x: 1 } }], [401, { error: { code: 'unauthenticated' } }], [409, { error: { code: 'conflict' }, current: { status: 'done', rev: 3 } }], [429, { error: { code: 'rate_limited' } }], [503, { error: { code: 'unavailable' } }]]) {
      reply = () => Response.json(body, { status, headers: status === 429 ? { 'retry-after': '42' } : {} });
      const res = await call('/me/dashboard', { headers: { cookie: SID } });
      assert.equal(res.status, status);
      assert.deepEqual(await res.json(), body);
      assert.equal(res.headers.get('content-type'), 'application/json');
      if (status === 429) assert.equal(res.headers.get('retry-after'), '42');
    }
  });

  it('ignores a malformed Retry-After', async () => {
    reply = () => new Response('{}', { status: 429, headers: { 'retry-after': 'soon<script>' } });
    assert.equal((await call('/me', { headers: { cookie: SID } })).headers.get('retry-after'), null);
  });
});

describe('failures', () => {
  it('answers 502 with Retry-After when the Worker is unreachable or slow, without leaking details', async () => {
    reply = () => { throw new Error('connect ECONNREFUSED 10.1.2.3:443 secret-host'); };
    const res = await call('/me', { headers: { cookie: SID } });
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('retry-after'), '30');
    assert.doesNotMatch(await res.text(), /ECONNREFUSED|10\.1\.2\.3|secret-host/);
  });

  it('answers 500 when API_BASE_URL is missing or invalid, and sends no request', async () => {
    for (const value of [undefined, '', 'not a url']) {
      if (value === undefined) delete process.env.API_BASE_URL; else process.env.API_BASE_URL = value;
      const res = await call('/me', { headers: { cookie: SID } });
      assert.equal(res.status, 500);
    }
    assert.equal(calls.length, 0);
  });
});

describe('logging', () => {
  it('logs route pattern, method, status and time, and never cookies, addresses, keys, slugs or query values', async () => {
    const lines = [];
    const realLog = console.log;
    console.log = (line) => lines.push(line);
    try {
      await call('/me/companies/secret-company-slug', { method: 'PUT', headers: { ...json, cookie: SID }, body: '{}', ip: '203.0.113.77' });
      await call('/auth/callback?code=SECRETCODE&state=SECRETSTATE', { headers: { cookie: '__Host-oauth=st' }, ip: '203.0.113.77' });
      await call('/me', { ip: '203.0.113.77' });
    } finally {
      console.log = realLog;
    }
    const logged = lines.map((l) => JSON.parse(l));
    assert.deepEqual(logged.map((l) => [l.route, l.method]), [['/me/companies/:slug', 'PUT'], ['/auth/callback', 'GET'], ['/me', 'GET']]);
    assert.ok(logged.every((l) => l.event === 'private' && typeof l.status === 'number' && typeof l.ms === 'number'));
    assert.doesNotMatch(lines.join('\n'), /203\.0\.113|SECRET|sessionTokenValue|secret-company|proxy-secret-key|__Host/);
  });
});

describe('regression: the public API and public browsing are unchanged', () => {
  const get = (path) => publicHandler(new Request(`${SITE}${path}`), { ip: '198.51.100.9' });

  it('the public API still refuses every private route, and sends no request upstream for them', async () => {
    for (const path of ['/api/v1/me', '/api/v1/me/progress', '/api/v1/me/dashboard', '/api/v1/me/companies/acme', '/api/v1/auth/google', '/api/v1/auth/callback']) {
      const res = await get(path);
      assert.equal(res.status, 404, path);
    }
    assert.equal(calls.length, 0);
  });

  it('the public API is still GET only and never carries cookies upstream', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await publicHandler(new Request(`${SITE}/api/v1/companies`, { method }), { ip: '1.1.1.1' })).status, 405);
    reply = () => Response.json({ data: [], meta: {} });
    await publicHandler(new Request(`${SITE}/api/v1/companies`, { headers: { cookie: SID, authorization: 'Bearer x' } }), { ip: '1.1.1.1' });
    assert.equal(calls[0].init.headers.cookie, undefined);
    assert.equal(calls[0].init.headers.authorization, undefined);
  });

  it('public responses keep their CDN caching, and nothing private leaks into them', async () => {
    reply = () => Response.json({ data: [], meta: {} });
    const res = await get('/api/v1/companies/acme/dsa');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(res.headers.get('netlify-cdn-cache-control'), 'public, durable, s-maxage=300, stale-while-revalidate=600');
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(res.headers.get('vary'), null);
  });

  it('netlify.toml has no redirect or header rule that touches the private paths or caches them', () => {
    const toml = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
    assert.doesNotMatch(toml, /from\s*=\s*"\/(auth|me)\b/);
    assert.doesNotMatch(toml, /for\s*=\s*"\/(auth|me)\b/);
    assert.doesNotMatch(toml, /s-maxage|durable/);
  });

  it('every page loads no new script or request while auth is off (no private path is referenced by shipped pages yet)', () => {
    for (const page of ['index.html', 'company.html', 'prep.html', 'question.html', 'sources.html', '404.html']) {
      const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
      assert.doesNotMatch(html, /["'(]\/(auth|me)\b/, page);
    }
  });
});
