import { expect, test } from '@playwright/test';
import { SITE, clean, idp, mark, prepare, setStatus, signInThroughUi, sql } from './helpers.mjs';

test.beforeEach(async ({ context, request }) => {
  await prepare(context);
  await clean(request);
});

const count = async (request, where) => Number((await sql(request, 'users', `SELECT COUNT(*) AS n FROM user_progress WHERE ${where}`))[0].n);
const accountMenu = (page, name = 'Ada Lovelace') => page.getByRole('button', { name: `Account menu for ${name}` });

test('the complete journey: browse, sign in with the local Google, track, mark, dashboard, restart, sign out, keep browsing', async ({ page, context, request, browser }) => {
  // 1. Signed-out browsing of every kind of page.
  await page.goto(`${SITE}/`);
  await expect(page.locator('main')).toBeVisible();
  await page.goto(`${SITE}/prep/ai`);
  await expect(page.getByRole('link', { name: 'Fixture AI question one' })).toBeVisible();
  await page.goto(`${SITE}/prep/system-design`);
  await expect(page.getByText('Fixture HLD question')).toBeVisible();
  await page.goto(`${SITE}/c/acme`);
  await expect(page.getByRole('link', { name: 'Fixture Problem 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

  // 2. Sign in through the UI and the local Google; we come back to the same page.
  await signInThroughUi(page, 'Ada Lovelace');
  await expect(page).toHaveURL(`${SITE}/c/acme`);
  await accountMenu(page).click();
  await expect(page.getByText('ada@example.com')).toBeVisible();
  const ref = (await page.locator('#acct-panel').innerText()).match(/Support reference: (\S+)/)[1];
  await page.keyboard.press('Escape');
  expect((await sql(request, 'users', 'SELECT public_ref FROM users')).map((r) => r.public_ref)).toEqual([ref]);
  const sid = (await context.cookies()).find((c) => c.name === 'sid');
  expect(sid.httpOnly).toBe(true);
  expect(sid.sameSite).toBe('Lax');

  // 3. Track a company and mark questions on every kind of list.
  const tracking = page.getByRole('group', { name: 'Tracking for Acme' }).getByRole('button');
  await tracking.click();
  await expect(tracking).toHaveAttribute('aria-pressed', 'true');
  await setStatus(page, 'Fixture Problem 1', 'done');
  await setStatus(page, 'Fixture Problem 2', 'revisit');
  await expect(mark(page, 'Fixture Problem 1')).toHaveAttribute('data-status', 'done');
  await expect.poll(() => count(request, "status IN ('done','revisit')")).toBe(2);
  await page.goto(`${SITE}/prep/ai`);
  await setStatus(page, 'Fixture AI question one', 'done');
  await expect.poll(() => count(request, "question_type = 'ai' AND status = 'done'")).toBe(1);
  await page.goto(`${SITE}/prep/system-design`);
  await setStatus(page, 'Fixture HLD question', 'revisit');
  await expect.poll(() => count(request, "question_type = 'system_design' AND status = 'revisit'")).toBe(1);

  // 4. The dashboard agrees with what was done, and with the database.
  await page.goto(`${SITE}/dashboard`);
  await expect(page.getByLabel(/^Company coding problems: 1 of \d+ done$/)).toBeVisible();
  await expect(page.getByLabel(/^AI questions: 1 of \d+ done$/)).toBeVisible();
  await expect(page.getByLabel(/^System design questions: 0 of \d+ done$/)).toBeVisible();
  await expect(page.getByText('1 to revisit')).toHaveCount(2); // coding and system design
  const dsaTotal = Number((await sql(request, 'content', "SELECT COUNT(DISTINCT r.id) AS n FROM resources r JOIN sources s ON s.id = r.source_id JOIN company_resources cr ON cr.resource_id = r.id WHERE r.category = 'leetcode' AND s.display_mode IN ('full','link')"))[0].n);
  await expect(page.getByLabel(`Company coding problems: 1 of ${dsaTotal} done`)).toBeVisible();
  const acme = page.getByRole('row', { name: /Acme/ });
  await expect(acme).toContainText('1 /');

  // 4b. Analytics: this one person is counted (aggregates only), and only the admin password opens the report.
  const report = 'http://127.0.0.1:8811/admin/users.json';
  expect((await request.get(report)).status()).toBe(401);
  const body = await (await request.get(report, { headers: { authorization: `Basic ${Buffer.from('founder:e2e-admin-password').toString('base64')}` } })).json();
  expect(body.metrics.registrations).toMatchObject({ total: 1, currentAccounts: 1, today: 1 });
  expect(body.metrics.active).toMatchObject({ dauToday: 1, wau: 1, mau: 1 });
  // Events, not questions: reaching Revisit goes through Done (none -> done -> revisit), so each Revisit mark also counted one Done.
  expect(body.metrics.usage.last7).toMatchObject({ markedDone: 4, markedRevisit: 2, companiesTracked: 1, dashboardUsers: 1 });
  expect(body.metrics.usage.last7.dashboardOpens).toBeGreaterThanOrEqual(1);
  expect(JSON.stringify(body)).not.toMatch(/ada@example|Ada Lovelace|ref-|@/);

  // 5. "Browser restart": a brand new browser context that has only the saved cookie (no local copy of anything).
  const saved = (await context.storageState()).cookies;
  const restarted = await browser.newContext({ viewport: page.viewportSize() });
  await prepare(restarted);
  await restarted.addCookies(saved);
  const again = await restarted.newPage();
  await again.goto(`${SITE}/c/acme`);
  await expect(accountMenu(again)).toBeVisible();
  await expect(mark(again, 'Fixture Problem 1')).toHaveAttribute('data-status', 'done');
  await expect(mark(again, 'Fixture Problem 2')).toHaveAttribute('data-status', 'revisit');
  await expect(again.getByRole('group', { name: 'Tracking for Acme' }).getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  await expect(mark(again, 'Fixture Problem 3')).toHaveAttribute('data-status', 'none');

  // 6. Sign out; public browsing carries on and nothing personal is left on the device.
  await accountMenu(again).click();
  await again.getByRole('button', { name: 'Sign out' }).click();
  await expect(again.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(mark(again, 'Fixture Problem 1')).toHaveAttribute('data-status', 'none');
  expect(await again.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('isx-u:')))).toEqual([]);
  expect((await restarted.cookies()).find((c) => c.name === 'sid')?.value ?? '').toBe('');
  expect(Number((await sql(request, 'users', 'SELECT COUNT(*) AS n FROM sessions'))[0].n)).toBe(0);
  expect(await count(request, '1 = 1')).toBe(4); // the account keeps its data
  for (const path of ['/', '/prep/ai', '/prep/system-design', '/c/acme', '/q/1', '/sources', '/privacy']) {
    const response = await again.goto(`${SITE}${path}`);
    expect(response.status(), path).toBe(200);
    await expect(again.locator('main')).toBeVisible();
  }
  await again.goto(`${SITE}/prep/ai`);
  await expect(again.getByRole('link', { name: 'Fixture AI question one' })).toBeVisible();
  expect(await (await again.request.get(`${SITE}/me`)).json()).toEqual({ signedIn: false });

  // 7. The same account signs in again and finds everything.
  await signInThroughUi(again, 'Ada Lovelace');
  await again.goto(`${SITE}/prep/ai`);
  await expect(mark(again, 'Fixture AI question one')).toHaveAttribute('data-status', 'done');
  await restarted.close();
});

test("a second account on the same browser sees none of the first one's progress", async ({ page, request }) => {
  await page.goto(`${SITE}/prep/ai`);
  await signInThroughUi(page, 'Ada Lovelace');
  await setStatus(page, 'Fixture AI question one', 'done');
  await expect.poll(() => count(request, "status = 'done'")).toBe(1);
  await accountMenu(page).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await signInThroughUi(page, 'Grace Hopper');
  await expect(mark(page, 'Fixture AI question one')).toHaveAttribute('data-status', 'none');
  expect(Number((await sql(request, 'users', 'SELECT COUNT(*) AS n FROM users'))[0].n)).toBe(2);
});

test('cancelling at Google, or a forged return, ends without signing in and says so', async ({ page, context }) => {
  await page.goto(`${SITE}/prep/ai`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Sign in with Google' }).click();
  await page.getByRole('link', { name: 'Cancel' }).click();
  await expect(page.getByText('Sign-in did not complete')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.goto(`${SITE}/auth/callback?code=forged&state=forged`); // a state we never issued
  await expect(page.getByText('Sign-in did not complete')).toBeVisible();
  expect((await context.cookies()).some((c) => c.name === 'sid' && c.value)).toBe(false);
});

test('two devices on the real Worker: the stale device is told and never overwrites', async ({ page, browser, context, request }) => {
  await page.goto(`${SITE}/prep/ai`);
  await signInThroughUi(page, 'Ada Lovelace');
  await expect(mark(page, 'Fixture AI question one')).toBeEnabled();
  const other = await browser.newContext({ viewport: page.viewportSize() });
  await prepare(other);
  await other.addCookies((await context.storageState()).cookies);
  const second = await other.newPage();
  await second.goto(`${SITE}/prep/ai`);
  await setStatus(second, 'Fixture AI question one', 'revisit');
  await expect.poll(() => count(request, "status = 'revisit'")).toBe(1);
  await mark(page, 'Fixture AI question one').click(); // this device still believes "never marked" and sends Done
  await expect(page.getByText('Changed on another device')).toBeVisible();
  await expect(mark(page, 'Fixture AI question one')).toHaveAttribute('data-status', 'revisit');
  expect((await sql(request, 'users', 'SELECT status FROM user_progress')).map((r) => r.status)).toEqual(['revisit']);
  await other.close();
});

test.afterEach(async ({ request }) => { await idp(request, { reset: true }); });
