// Read-only routing check for a deployed copy of the site (a Netlify deploy preview, or the site itself). It answers:
// do the private routes (/auth/*, /me*) reach private.mjs and not a page or a redirect, are they never cached, is the public
// API still cached the way it was, and is everything that is not a page unreachable?
//
//   node scripts/verify-preview.mjs https://deploy-preview-12--interviewsyntax.netlify.app [--start-sign-in]
//
// Only GET requests. The one exception is opt-in: --start-sign-in requests /auth/google, which makes the Worker store one
// short-lived sign-in attempt (a row that expires in 10 minutes and is removed by the scheduled cleanup). Nothing else writes.
// It works whether the feature is on or off, and says which it found. The check itself is tested in tests/verify-preview.test.mjs.
import { pathToFileURL } from 'node:url';

const get = async (base, path) => fetch(new URL(path, base), { redirect: 'manual', headers: { accept: 'application/json,text/html' } });
const text = (r) => r.clone().text();
const isJson = (r) => (r.headers.get('content-type') ?? '').includes('application/json');
const hasAll = (value, ...needles) => needles.every((n) => (value ?? '').toLowerCase().includes(n));

export async function verify(base, { startSignIn = false } = {}) {
  const results = [];
  const check = (ok, what, detail = '') => results.push({ ok: !!ok, what, detail: ok ? '' : detail });
  let featureOn = null;

  // --- pages and the rewrites ---
  for (const path of ['/', '/privacy', '/dashboard', '/sources', '/prep/ai', '/c/acme']) {
    const r = await get(base, path);
    check(r.status === 200 && (r.headers.get('content-type') ?? '').includes('text/html'), `page ${path} is served`, `status ${r.status}`);
  }
  const home = await get(base, '/');
  check(hasAll(home.headers.get('content-security-policy'), "default-src 'self'"), 'the content security policy is sent', String(home.headers.get('content-security-policy')));

  // --- nothing that is not a page can be downloaded ---
  for (const path of ['/netlify/functions/private.mjs', '/netlify/functions/api.mjs', '/tests/private.test.mjs', '/tests-e2e/server.mjs', '/playwright.config.mjs', '/playwright.real.config.mjs', '/package.json', '/package-lock.json', '/netlify.toml', '/.env', '/.env.example', '/.git/config', '/.gitignore', '/node_modules/x', '/README.md', '/ARCHITECTURE.md']) {
    const r = await get(base, path);
    check(r.status === 404, `${path} is not downloadable`, `status ${r.status}`);
  }

  // --- the public API: still cached by the CDN, still public ---
  const api = await get(base, '/api/v1/health');
  const apiCdn = api.headers.get('netlify-cdn-cache-control');
  check(api.status === 200 && isJson(api), 'public API answers', `status ${api.status}`);
  check(hasAll(apiCdn, 's-maxage'), 'public API responses keep their CDN cache headers', String(apiCdn));
  check(!api.headers.get('set-cookie'), 'public API never sets a cookie', String(api.headers.get('set-cookie')));

  // --- private routes: the function must answer, not a page, not a redirect ---
  const me = await get(base, '/me');
  const meBody = await text(me);
  if (me.status === 200 && isJson(me)) {
    featureOn = true;
    check(/"signedIn":\s*false/.test(meBody), '/me with no cookie answers signed out', meBody.slice(0, 120));
  } else if (me.status === 404 && isJson(me) && /not_found/.test(meBody)) {
    featureOn = false;
  } else {
    check(false, '/me is answered by private.mjs (JSON), not by a page or a redirect', `status ${me.status}, content-type ${me.headers.get('content-type')}, body starts ${meBody.slice(0, 60).replace(/\s+/g, ' ')}`);
  }
  if (featureOn !== null) {
    check(hasAll(me.headers.get('cache-control'), 'no-store'), 'private responses are Cache-Control: no-store', String(me.headers.get('cache-control')));
    check(hasAll(me.headers.get('netlify-cdn-cache-control'), 'no-store'), 'private responses are never held by the CDN', String(me.headers.get('netlify-cdn-cache-control')));
    check(hasAll(me.headers.get('vary'), 'cookie'), 'private responses vary on Cookie', String(me.headers.get('vary')));
    check(!me.headers.get('set-cookie'), '/me with no cookie sets nothing', String(me.headers.get('set-cookie')));
  }
  for (const path of ['/me/progress', '/me/companies', '/me/dashboard']) {
    const r = await get(base, path);
    const body = await text(r);
    const expected = featureOn ? 401 : 404;
    check(featureOn !== null && r.status === expected && isJson(r), `${path} with no cookie answers ${expected} as JSON`, `status ${r.status}, ${body.slice(0, 60).replace(/\s+/g, ' ')}`);
  }
  const unknown = await get(base, '/me/anything-else');
  check(unknown.status === 404 && isJson(unknown), 'an unknown private path is a JSON 404, not a page', `status ${unknown.status}`);

  // --- starting sign-in (opt-in: one short-lived row on the Worker) ---
  if (startSignIn && featureOn) {
    const r = await get(base, '/auth/google?next=%2Fprep%2Fai');
    const location = r.headers.get('location') ?? '';
    const cookie = r.headers.getSetCookie?.().join('\n') ?? '';
    const url = (() => { try { return new URL(location); } catch { return null; } })();
    check(r.status === 302 && url?.origin === 'https://accounts.google.com' && url.pathname === '/o/oauth2/v2/auth', 'sign-in sends the browser to Google', `status ${r.status}, location ${location.slice(0, 80)}`);
    check(url?.searchParams.get('redirect_uri') === `${new URL(base).origin}/auth/callback`, 'the return address is this site\'s /auth/callback', String(url?.searchParams.get('redirect_uri')));
    check(url?.searchParams.get('code_challenge_method') === 'S256' && !!url?.searchParams.get('state') && !!url?.searchParams.get('nonce'), 'state, nonce and PKCE (S256) are sent', location.slice(0, 120));
    const secure = new URL(base).protocol === 'https:';
    check(secure ? /^__Host-oauth=/m.test(cookie) : /^oauth=/m.test(cookie), 'the sign-in cookie has the expected name', cookie.slice(0, 60));
    check(hasAll(cookie, 'httponly', 'samesite=lax', 'path=/') && !/domain=/i.test(cookie) && (!secure || /;\s*secure/i.test(cookie)), 'the sign-in cookie is HttpOnly, SameSite=Lax, Secure on https, no Domain', cookie.slice(0, 160));
    check(hasAll(r.headers.get('cache-control'), 'no-store'), 'the sign-in redirect is never cached', String(r.headers.get('cache-control')));
  } else if (startSignIn) {
    results.push({ ok: true, what: 'sign-in start skipped: the feature is off here', detail: '' });
  }

  return { featureOn, results };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const base = process.argv[2];
  if (!base || !/^https?:\/\//.test(base)) { console.error('usage: node scripts/verify-preview.mjs <https://site> [--start-sign-in]'); process.exit(2); }
  const { featureOn, results } = await verify(base, { startSignIn: process.argv.includes('--start-sign-in') });
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.what}${r.detail ? `   <- ${r.detail}` : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nSign-in feature on this site: ${featureOn === null ? 'UNKNOWN (routing is wrong)' : featureOn ? 'ON' : 'OFF (private routes answer 404, as intended)'}`);
  console.log(failed ? `${failed} check(s) FAILED` : 'All checks passed.');
  process.exit(failed ? 1 : 0);
}
