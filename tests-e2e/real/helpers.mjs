export const SITE = 'http://127.0.0.1:8812';

export async function prepare(context) {
  // Never depend on the public internet, and send the browser's "go to Google" to the local Google instead.
  // Safety net: nothing in these tests may leave this machine (routes registered later win, so this is the fallback).
  await context.route((url) => url.hostname !== '127.0.0.1', (route) => route.abort());
  await context.route(/^https:\/\/accounts\.google\.com\//, (route) => {
    const url = new URL(route.request().url());
    const target = `${SITE}/__idp/authorize${url.search}`;
    return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><meta http-equiv="refresh" content="0;url=${target.replace(/&/g, '&amp;')}">` });
  });
}

export async function sql(request, db, statement, params = []) {
  const response = await request.post(`${SITE}/__test/sql`, { data: { db, sql: statement, params } });
  if (!response.ok()) throw new Error(`sql failed: ${response.status()} ${await response.text()}`);
  return (await response.json()).rows;
}

export const idp = (request, data = {}) => request.post(`${SITE}/__test/idp`, { data });

// Everything the tests create is removed between tests (users cascade to sessions, progress and companies).
export async function clean(request) {
  await sql(request, 'users', 'DELETE FROM users');
  await sql(request, 'users', 'DELETE FROM oauth_attempts');
  await sql(request, 'users', 'DELETE FROM deletion_ledger');
  await sql(request, 'content', 'DELETE FROM deletion_ledger');
  await idp(request, { reset: true });
}

// The whole sign-in, through the UI: dialog, Google's button, the local Google's account chooser, the callback.
export async function signInThroughUi(page, accountName) {
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Sign in with Google' }).click();
  await page.getByRole('link', { name: new RegExp(accountName) }).click();
  await page.getByRole('button', { name: /Account menu for/ }).waitFor();
}

export const row = (page, title, group = 'Progress') => page.getByRole('group', { name: `${group} for ${title}` });
// One status button per question: Not Started -> Done -> Revisit -> Not Started on each click.
export const mark = (page, title) => row(page, title).getByRole('button');
const ORDER = ['none', 'done', 'revisit'];
export async function setStatus(page, title, status) {
  const button = mark(page, title);
  const current = (await button.getAttribute('data-status')) ?? 'none';
  for (let i = (ORDER.indexOf(status) - ORDER.indexOf(current) + 3) % 3; i > 0; i--) await button.click();
}
