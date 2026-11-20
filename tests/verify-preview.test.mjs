import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { verify } from '../scripts/verify-preview.mjs';

const PAGES = ['/', '/privacy', '/dashboard', '/sources'];
const PRIVATE = { 'Cache-Control': 'private, no-store', 'Netlify-CDN-Cache-Control': 'no-store', Vary: 'Cookie', 'Content-Type': 'application/json' };
const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };

// A stand-in for a deployed site. `fault` breaks one thing so the checker has to notice it.
async function site(on, fault) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const page = () => { res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'" }); res.end('<html></html>'); };
    if (fault === 'exposed' && path === '/package.json') return json(res, 200, {});
    if (path === '/api/v1/health') return json(res, 200, { data: {} }, { 'Netlify-CDN-Cache-Control': fault === 'api-uncached' ? 'no-store' : 'public, durable, s-maxage=300' });
    if (path === '/me') {
      if (fault === 'swallowed') return page(); // a rewrite answered instead of the function
      if (!on) return json(res, 404, { error: { code: 'not_found' } }, PRIVATE);
      return json(res, 200, { signedIn: false }, fault === 'cached' ? { ...PRIVATE, 'Cache-Control': 'public, max-age=300' } : PRIVATE);
    }
    if (path.startsWith('/me/')) return on && path !== '/me/anything-else' ? json(res, 401, { error: { code: 'unauthorized' } }, PRIVATE) : json(res, 404, { error: { code: 'not_found' } }, PRIVATE);
    if (path === '/auth/google') {
      res.setHeader('Set-Cookie', fault === 'weak-cookie' ? 'oauth=abc; Path=/; Domain=example.com' : 'oauth=abc; Max-Age=600; Path=/; HttpOnly; SameSite=Lax');
      res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?client_id=c&redirect_uri=${encodeURIComponent(`http://${req.headers.host}/auth/callback`)}&state=s&nonce=n&code_challenge=x&code_challenge_method=S256`, 'Cache-Control': 'private, no-store' });
      return res.end();
    }
    if (PAGES.includes(path) || path.startsWith('/prep/') || path.startsWith('/c/')) return page();
    return json(res, 404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const failures = (r) => r.results.filter((x) => !x.ok).map((x) => x.what);

test('a correctly routed site with the feature on passes, including starting sign-in', async () => {
  const s = await site(true);
  const r = await verify(s.base, { startSignIn: true });
  s.close();
  assert.equal(r.featureOn, true);
  assert.deepEqual(failures(r), []);
});

test('a correctly routed site with the feature off passes and is reported as off', async () => {
  const s = await site(false);
  const r = await verify(s.base, { startSignIn: true });
  s.close();
  assert.equal(r.featureOn, false);
  assert.deepEqual(failures(r), []);
});

for (const [fault, expected] of [
  ['swallowed', /\/me is answered by private\.mjs/],
  ['cached', /Cache-Control: no-store/],
  ['exposed', /package\.json is not downloadable/],
  ['api-uncached', /keep their CDN cache headers/],
  ['weak-cookie', /sign-in cookie is HttpOnly/],
]) {
  test(`the checker catches: ${fault}`, async () => {
    const s = await site(true, fault);
    const r = await verify(s.base, { startSignIn: true });
    s.close();
    assert.ok(failures(r).some((w) => expected.test(w)), `expected a failure matching ${expected}, got ${JSON.stringify(failures(r))}`);
  });
}
