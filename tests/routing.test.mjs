import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it, test } from 'node:test';

// What Netlify will serve is decided by netlify.toml and the functions' own paths. Netlify's precedence between function paths
// and redirects is checked on a real deploy preview (scripts/verify-preview.mjs); these tests make sure the question cannot
// matter (no redirect competes with a private route) and that nothing that is not a page can be downloaded.
const root = new URL('../', import.meta.url);
const toml = readFileSync(new URL('netlify.toml', root), 'utf8');
const redirects = [...toml.matchAll(/\[\[redirects\]\]([\s\S]*?)(?=\n\[\[|\n\[|$)/g)].map((m) => ({
  from: /from = "([^"]+)"/.exec(m[1])[1],
  to: /to = "([^"]+)"/.exec(m[1])[1],
  status: Number(/status = (\d+)/.exec(m[1])[1]),
  force: /force = true/.test(m[1]),
}));
const escaped = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
const toRegex = (from) => new RegExp('^' + escaped(from).replace(/\*/g, '.*') + '$');
const covering = (path) => redirects.filter((r) => toRegex(r.from).test(path));

test('no redirect competes with the private routes or the public API', () => {
  for (const path of ['/auth/google', '/auth/callback', '/auth/reauth', '/auth/logout', '/me', '/me/progress', '/me/companies/acme', '/me/dashboard', '/api/v1/prep/ai', '/api/v1/health']) {
    assert.deepEqual(covering(path).map((r) => r.from), [], `${path} must not match any redirect`);
  }
});

test('nothing on the site proxies or rewrites the founder-only report paths', () => {
  for (const path of ['/admin', '/admin/users', '/admin/users.json', '/api/admin/users']) {
    assert.equal(covering(path).filter((r) => r.status === 200).length, 0, `${path} must not be rewritten to anything`);
  }
});

test('the functions answer exactly the paths the site relies on', async () => {
  const { config: privateConfig } = await import('../netlify/functions/private.mjs');
  const { config: apiConfig } = await import('../netlify/functions/api.mjs');
  assert.deepEqual([...privateConfig.path].sort(), ['/auth/*', '/me', '/me/*']);
  assert.equal(apiConfig.path, '/api/*');
});

const PAGES = new Set(['index.html', 'company.html', 'prep.html', 'question.html', 'sources.html', 'privacy.html', 'dashboard.html', '404.html', 'css', 'img', 'js']);

test('everything at the top of the repository that is not a page or an asset folder is blocked with a 404', () => {
  const unblocked = readdirSync(root).filter((name) => !PAGES.has(name)).filter((name) => {
    const hits = [...covering(`/${name}`), ...covering(`/${name}/x`)];
    return !hits.some((r) => r.status === 404 && r.force);
  });
  assert.deepEqual(unblocked, [], 'add a forced 404 redirect in netlify.toml for each of these (the publish directory is the repository root)');
});

test('every page the site links to is served', () => {
  for (const path of ['/privacy', '/dashboard', '/sources', '/c/acme', '/prep/ai', '/q/1']) {
    assert.ok(covering(path).some((r) => r.status === 200), `${path} has a rewrite`);
  }
});

describe('the build gate', () => {
  const toml = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  it('runs the tests before publishing, and leaves the static publish settings as they were', () => {
    assert.match(toml, /\[build\][^[]*publish = "\."/);
    assert.match(toml, /\[build\][^[]*functions = "netlify\/functions"/);
    assert.match(toml, /\[build\][^[]*command = "node --test"/);
    assert.match(toml, /\[build\.environment\][^[]*NODE_VERSION = "22"/);
  });
  it('needs no installed dependency: the test files import only Node itself and the site\'s own files', () => {
    const files = readdirSync(new URL('./', import.meta.url)).filter((n) => n.endsWith('.test.mjs'));
    assert.ok(files.length > 5);
    for (const f of files) {
      const imports = [...readFileSync(new URL(`./${f}`, import.meta.url), 'utf8').matchAll(/^import .*? from '([^']+)'/gm)].map((m) => m[1]);
      for (const i of imports) assert.ok(i.startsWith('node:') || i.startsWith('.') || i.startsWith('/'), `${f} imports ${i}`);
    }
  });
});
