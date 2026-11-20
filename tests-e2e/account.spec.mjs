import { expect, test } from '@playwright/test';

const ON = 'http://127.0.0.1:8801';
const OFF = 'http://127.0.0.1:8802';
const control = (request, path, data = {}) => request.post(`${ON}/__test/${path}`, { data });
const state = async (request) => (await request.get(`${ON}/__test/state`)).json();

async function signIn(context, request, { token = 'tok-ada-0001', ref = 'ref-ada', name = 'Ada Lovelace', email = 'ada@example.com' } = {}) {
  await control(request, 'session', { token, ref, name, email });
  await context.addCookies([{ name: 'sid', value: token, url: ON }]);
}

test.beforeEach(async ({ request, context }) => {
  await control(request, 'reset');
  await context.route(/fonts.(googleapis|gstatic).com/, (route) => route.abort()); // never depend on the public internet
});

const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
// One status button per question: Not Started -> Done -> Revisit -> Not Started on each click.
const doneButton = (page, title) => page.getByRole('group', { name: `Progress for ${title}` }).getByRole('button');
const revisitButton = doneButton;

test.describe('sign-in switched off (the production default)', () => {
  const pages = ['/', '/prep/ai', '/prep/system-design', '/c/acme', '/q/101', '/sources', '/privacy'];

  for (const path of pages) {
    test(`${path} gets no account UI, no extra stylesheet and no visible change`, async ({ page }) => {
      const hits = [];
      page.on('request', (r) => hits.push(new URL(r.url()).pathname));
      await page.goto(`${OFF}${path}`);
      await page.waitForLoadState('networkidle');
      expect(await page.locator('.prog, .acct, #signin-open, dialog, .toasts, .sr-only').count()).toBe(0);
      expect(await page.locator('link[href*="account.css"]').count()).toBe(0);
      expect(hits.some((h) => h.endsWith('account.css'))).toBe(false);
      expect(await noHorizontalScroll(page)).toBe(true);
    });
  }

  test('the public pages still show their content and the header keeps exactly its original controls', async ({ page }) => {
    await page.goto(`${OFF}/prep/ai`);
    await expect(page.getByRole('link', { name: 'How does attention work?' })).toBeVisible();
    expect(await page.locator('header.top > *').evaluateAll((nodes) => nodes.map((n) => n.id || n.className))).toEqual(['brandbox', 'nav', 'theme']);
    await page.goto(`${OFF}/c/acme`);
    await expect(page.getByRole('link', { name: 'Two Sum' })).toBeVisible();
  });

  test('the private routes answer 404 and the public API still refuses /me', async ({ request }) => {
    expect((await request.get(`${OFF}/me`)).status()).toBe(404);
    expect((await request.get(`${OFF}/auth/google`)).status()).toBe(404);
    expect((await request.get(`${OFF}/api/v1/me`)).status()).toBe(404);
  });
});

test.describe('public browsing never waits for sign-in', () => {
  test('the page is drawn and usable while /me is still unanswered, and nothing changes when /me gives up', async ({ page, context, request }) => {
    await signIn(context, request);
    await control(request, 'config', { meDelay: 10_000 });
    let hold;
    const gate = new Promise((resolve) => { hold = resolve; });
    await page.route('**/me', async (route) => { await gate; await route.continue(); });
    await page.goto(`${ON}/prep/ai`);
    // /me is held open by the test: the content is already there, so nothing waited for it.
    await expect(page.getByRole('link', { name: 'How does attention work?' })).toBeVisible();
    expect(await page.locator('.prog, .acct, #signin-open').count()).toBe(0);
    await page.waitForTimeout(3500); // longer than the 3 second limit on /me
    expect(await page.locator('.prog, .acct, #signin-open').count()).toBe(0);
    await expect(page.getByRole('link', { name: 'How does attention work?' })).toBeVisible();
    hold();
  });

  test('a failing /me (503) leaves the page exactly as the signed-out default', async ({ page, context, request }) => {
    await signIn(context, request);
    await control(request, 'config', { meStatus: 503 });
    await page.goto(`${ON}/c/acme`);
    await expect(page.getByRole('link', { name: 'Two Sum' })).toBeVisible();
    await page.waitForTimeout(500);
    expect(await page.locator('.prog, .acct, #signin-open').count()).toBe(0);
  });
});

test.describe('signed out, sign-in on', () => {
  test('shows Sign in and selectors; choosing one opens a dialog that goes to Google and returns focus on Esc', async ({ page }) => {
    await page.goto(`${ON}/prep/ai`);
    const open = page.getByRole('button', { name: 'Sign in' });
    await expect(open).toBeVisible();
    const done = doneButton(page, 'How does attention work?');
    await expect(done).toBeEnabled();
    await expect(done).toHaveAttribute('data-status', 'none');
    await expect(done).toHaveText('Not Started');
    await done.click();
    const dialog = page.getByRole('dialog', { name: 'Sign in to track your progress' });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in with Google' })).toHaveAttribute('href', '/auth/google?next=%2Fprep%2Fai');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(done).toBeFocused();
  });

  test('The Google button reaches the proxy, which starts sign-in without following the redirect itself', async ({ page, request }) => {
    await page.route('https://accounts.google.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: 'google' }));
    await page.goto(`${ON}/prep/ai`);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await Promise.all([page.waitForURL('https://accounts.google.com/**'), page.getByRole('link', { name: 'Sign in with Google' }).click()]);
    expect((await state(request)).pageHits).toContain('GET /auth/google');
  });

  test('the dashboard asks to sign in', async ({ page }) => {
    await page.goto(`${ON}/dashboard`);
    await expect(page.getByRole('link', { name: 'Sign in with Google' })).toHaveAttribute('href', '/auth/google?next=%2Fdashboard');
  });

  test('an auth_error in the address explains itself once and is removed', async ({ page }) => {
    await page.goto(`${ON}/?auth_error=denied`);
    await expect(page.getByText('Sign-in did not complete')).toBeVisible();
    await expect(page).toHaveURL(`${ON}/`);
  });

  test('stays inside the screen on a phone', async ({ page }) => {
    await page.goto(`${ON}/prep/ai`);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
  });
});

test.describe('signed in', () => {
  test('the account menu shows who is signed in, the support reference and links, and works from the keyboard', async ({ page, context, request }) => {
    await signIn(context, request);
    await page.goto(`${ON}/prep/ai`);
    const menu = page.getByRole('button', { name: 'Account menu for Ada Lovelace' });
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(menu.locator('.avatar')).toHaveText('AL');
    await menu.focus();
    await page.keyboard.press('Enter');
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('Signed in as Ada Lovelace')).toBeVisible();
    await expect(page.getByText('ada@example.com')).toBeVisible();
    await expect(page.getByText('Support reference: ref-ada')).toBeVisible();
    await expect(page.getByRole('link', { name: 'My dashboard' })).toBeFocused();
    const box = await page.locator('#acct-panel').boundingBox();
    const view = page.viewportSize();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(view.width);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toBeFocused();
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test('marking progress saves to the server and is remembered after a reload, on every kind of question list', async ({ page, context, request }) => {
    await signIn(context, request);
    await page.goto(`${ON}/prep/ai`);
    await doneButton(page, 'How does attention work?').click();
    await expect(doneButton(page, 'How does attention work?')).toHaveAttribute('data-status', 'done');
    await expect.poll(async () => (await state(request)).rows['ref-ada|p:ai:101']?.value).toBe('done');
    await page.reload();
    await expect(doneButton(page, 'How does attention work?')).toHaveAttribute('data-status', 'done');
    await expect(doneButton(page, 'What is KV caching?')).toHaveAttribute('data-status', 'none');

    await page.goto(`${ON}/prep/system-design`);
    await revisitButton(page, 'Design a URL shortener').click();
    await expect(revisitButton(page, 'Design a URL shortener')).toHaveText('Done');
    await revisitButton(page, 'Design a URL shortener').click();
    await expect(revisitButton(page, 'Design a URL shortener')).toHaveText('Revisit');
    await expect.poll(async () => (await state(request)).rows['ref-ada|p:system_design:301']?.value).toBe('revisit');

    await page.goto(`${ON}/c/acme`);
    await doneButton(page, 'Two Sum').click();
    await expect.poll(async () => (await state(request)).rows['ref-ada|p:company_dsa:201']?.value).toBe('done');
    await doneButton(page, 'Two Sum').click(); // Done -> Revisit
    await expect.poll(async () => (await state(request)).rows['ref-ada|p:company_dsa:201']?.value).toBe('revisit');
    await doneButton(page, 'Two Sum').click(); // Revisit -> Not Started
    await expect.poll(async () => (await state(request)).rows['ref-ada|p:company_dsa:201']?.value).toBe('none');

    await page.goto(`${ON}/q/101`);
    await expect(doneButton(page, 'How does attention work?')).toHaveAttribute('data-status', 'done');
  });

  test('company tracking toggles and persists', async ({ page, context, request }) => {
    await signIn(context, request);
    await page.goto(`${ON}/c/acme`);
    const track = page.getByRole('group', { name: 'Tracking for Acme' }).getByRole('button');
    await expect(track).toHaveAttribute('aria-pressed', 'false');
    await track.click();
    await expect(track).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await state(request)).rows['ref-ada|c:acme']?.value).toBe(true);
    await page.reload();
    await expect(page.getByRole('group', { name: 'Tracking for Acme' }).getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  });

  test('never shows "not started" while the saved progress is still loading (the response is held until the test releases it)', async ({ page, context, request }) => {
    await signIn(context, request);
    await control(request, 'row', { ref: 'ref-ada', key: 'p:ai:101', value: 'done', rev: 1 });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route('**/me/progress', async (route) => { await gate; await route.continue(); });
    await page.goto(`${ON}/prep/ai`);
    const group = page.getByRole('group', { name: 'Progress for How does attention work?' });
    const done = group.getByRole('button');
    await expect(group).toBeVisible();
    // The state is held open by the test, so these are exact rather than a race with a timer.
    await expect(group).toHaveAttribute('aria-busy', 'true');
    await expect(done).toBeDisabled();
    await expect(done).toHaveAttribute('data-status', 'none');
    await page.waitForTimeout(300);
    await expect(group).toHaveAttribute('aria-busy', 'true');
    release();
    await expect(group).toHaveAttribute('aria-busy', 'false');
    await expect(done).toBeEnabled();
    await expect(done).toHaveAttribute('data-status', 'done');
  });

  test('a failed first load recovers by itself: selectors stay unavailable, then show the saved progress', async ({ page, context, request }) => {
    await signIn(context, request);
    await control(request, 'row', { ref: 'ref-ada', key: 'p:ai:101', value: 'done', rev: 1 });
    let failures = 1;
    await page.route('**/me/progress', (route) => (failures-- > 0 ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : route.continue()));
    await page.goto(`${ON}/prep/ai`);
    const group = page.getByRole('group', { name: 'Progress for How does attention work?' });
    await expect(group).toHaveAttribute('aria-busy', 'true');
    await expect(group).toHaveAttribute('aria-busy', 'false', { timeout: 10_000 });
    await expect(group.getByRole('button')).toHaveAttribute('data-status', 'done');
  });

  test('a saved copy shows at once on the next visit, before the network answers', async ({ page, context, request }) => {
    await signIn(context, request);
    await page.goto(`${ON}/prep/ai`);
    await doneButton(page, 'How does attention work?').click();
    await expect.poll(async () => (await state(request)).rows['ref-ada|p:ai:101']?.value).toBe('done');
    await page.route('**/me/progress', () => {}); // never answers
    await page.reload();
    await expect(doneButton(page, 'How does attention work?')).toHaveAttribute('data-status', 'done');
  });

  test('two devices: the stale one never overwrites newer progress, and is told', async ({ browser, context, page, request }) => {
    await signIn(context, request);
    await page.goto(`${ON}/prep/ai`);
    await expect(doneButton(page, 'How does attention work?')).toBeEnabled(); // device A loaded at revision 0

    const other = await browser.newContext({ viewport: page.viewportSize() });
    await other.route(/fonts.(googleapis|gstatic).com/, (route) => route.abort());
    await other.addCookies([{ name: 'sid', value: 'tok-ada-0001', url: ON }]);
    const second = await other.newPage();
    await second.goto(`${ON}/prep/ai`);
    await doneButton(second, 'How does attention work?').click();
    await doneButton(second, 'How does attention work?').click(); // Done -> Revisit
    await expect.poll(async () => (await state(request)).rows['ref-ada|p:ai:101']?.value).toBe('revisit');

    await doneButton(page, 'How does attention work?').click(); // A still believes revision 0 and sends Done
    await expect(page.getByText('Changed on another device')).toBeVisible();
    await expect(doneButton(page, 'How does attention work?')).toHaveAttribute('data-status', 'revisit');
    expect((await state(request)).rows['ref-ada|p:ai:101']).toMatchObject({ value: 'revisit' });
    await other.close();
  });

  test('two devices: progress made on one appears on the other after a reload', async ({ browser, context, page, request }) => {
    await signIn(context, request);
    await page.goto(`${ON}/c/acme`);
    await doneButton(page, 'Valid Parentheses').click();
    await expect.poll(async () => (await state(request)).rows['ref-ada|p:company_dsa:202']?.value).toBe('done');
    const other = await browser.newContext({ viewport: page.viewportSize() });
    await other.route(/fonts.(googleapis|gstatic).com/, (route) => route.abort());
    await other.addCookies([{ name: 'sid', value: 'tok-ada-0001', url: ON }]);
    const second = await other.newPage();
    await second.goto(`${ON}/c/acme`);
    await expect(doneButton(second, 'Valid Parentheses')).toHaveAttribute('data-status', 'done');
    await other.close();
  });

  test('offline: the change shows at once and is saved when the connection returns', async ({ page, context, request }) => {
    await signIn(context, request);
    await page.goto(`${ON}/prep/ai`);
    await expect(doneButton(page, 'What is KV caching?')).toBeEnabled();
    await context.setOffline(true);
    await doneButton(page, 'What is KV caching?').click();
    await expect(doneButton(page, 'What is KV caching?')).toHaveAttribute('data-status', 'done');
    await expect(page.getByText('You are offline or the service is busy')).toBeVisible();
    expect((await state(request)).rows['ref-ada|p:ai:102']).toBeUndefined();
    await context.setOffline(false);
    await expect.poll(async () => (await state(request)).rows['ref-ada|p:ai:102']?.value, { timeout: 15_000 }).toBe('done');
  });

  test('a service failure while saving keeps the change and retries', async ({ page, context, request }) => {
    await signIn(context, request);
    await page.goto(`${ON}/prep/ai`);
    await expect(doneButton(page, 'What is KV caching?')).toBeEnabled();
    await page.route('**/me/progress', (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : route.continue()));
    await doneButton(page, 'What is KV caching?').click();
    await expect(doneButton(page, 'What is KV caching?')).toHaveAttribute('data-status', 'done');
    await page.unroute('**/me/progress');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(async () => (await state(request)).rows['ref-ada|p:ai:102']?.value, { timeout: 15_000 }).toBe('done');
  });

  test('progress data failing (503) keeps browsing working and the selectors unavailable instead of wrong', async ({ page, context, request }) => {
    await signIn(context, request);
    await control(request, 'config', { dataStatus: 503 });
    await page.goto(`${ON}/prep/ai`);
    await expect(page.getByRole('link', { name: 'How does attention work?' })).toBeVisible();
    const group = page.getByRole('group', { name: 'Progress for How does attention work?' });
    await expect(group).toHaveAttribute('aria-busy', 'true');
    await expect(group.getByRole('button')).toBeDisabled();
  });

  test('an expired session is reported once, the header falls back to Sign in, and the page keeps working', async ({ page, context, request }) => {
    await signIn(context, request);
    await page.goto(`${ON}/prep/ai`);
    await expect(doneButton(page, 'What is KV caching?')).toBeEnabled();
    await control(request, 'expire');
    await doneButton(page, 'What is KV caching?').click();
    await expect(page.getByText('Your session has ended')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'What is KV caching?' })).toBeVisible();
    await doneButton(page, 'What is KV caching?').click();
    await expect(page.getByRole('dialog', { name: 'Sign in to track your progress' })).toBeVisible();
  });

  test('an expired cookie shows the signed-out page, not an error', async ({ page, context }) => {
    await context.addCookies([{ name: 'sid', value: 'not-a-live-token', url: ON }]);
    await page.goto(`${ON}/prep/ai`);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('signing out forgets everything on this device, in this tab and in others', async ({ page, context, request }) => {
    await signIn(context, request);
    await page.goto(`${ON}/prep/ai`);
    await doneButton(page, 'How does attention work?').click();
    await expect.poll(async () => (await state(request)).rows['ref-ada|p:ai:101']?.value).toBe('done');
    const sibling = await context.newPage();
    await sibling.goto(`${ON}/prep/ai`);
    await expect(sibling.getByRole('button', { name: 'Account menu for Ada Lovelace' })).toBeVisible();

    await page.getByRole('button', { name: 'Account menu for Ada Lovelace' }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(doneButton(page, 'How does attention work?')).toHaveAttribute('data-status', 'none');
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('isx-u:')))).toEqual([]);
    await expect(sibling.getByRole('button', { name: 'Sign in' })).toBeVisible();
    expect((await state(request)).rows['ref-ada|p:ai:101']).toMatchObject({ value: 'done' }); // the server keeps the account's data
  });

  test('another account on the same browser never sees the first one\'s progress', async ({ page, context, request }) => {
    await signIn(context, request);
    await page.goto(`${ON}/prep/ai`);
    await doneButton(page, 'How does attention work?').click();
    await expect.poll(async () => (await state(request)).rows['ref-ada|p:ai:101']?.value).toBe('done');
    await context.clearCookies();
    await signIn(context, request, { token: 'tok-grace-0002', ref: 'ref-grace', name: 'Grace Hopper', email: 'grace@example.com' });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Account menu for Grace Hopper' })).toBeVisible();
    await expect(doneButton(page, 'How does attention work?')).toHaveAttribute('data-status', 'none');
    expect((await state(request)).rows['ref-grace|p:ai:101']).toBeUndefined();
  });

  test('a stale device cannot recreate progress that the server no longer has', async ({ page, context, request }) => {
    await signIn(context, request);
    await page.goto(`${ON}/prep/ai`);
    await doneButton(page, 'How does attention work?').click();
    await expect.poll(async () => (await state(request)).rows['ref-ada|p:ai:101']?.value).toBe('done');
    await request.post(`${ON}/__test/drop`, { data: { ref: 'ref-ada', key: 'p:ai:101' } }); // pruned on the server
    await revisitButton(page, 'How does attention work?').click();
    await expect(page.getByText('Changed on another device')).toBeVisible();
    expect((await state(request)).rows['ref-ada|p:ai:101']).toBeUndefined();
  });
});

test.describe('dashboard', () => {
  test('shows totals and tracked companies', async ({ page, context, request }) => {
    await signIn(context, request);
    await control(request, 'row', { ref: 'ref-ada', key: 'p:ai:101', value: 'done', rev: 1 });
    await control(request, 'row', { ref: 'ref-ada', key: 'p:ai:102', value: 'revisit', rev: 1 });
    await control(request, 'row', { ref: 'ref-ada', key: 'c:acme', value: true, rev: 1 });
    await page.goto(`${ON}/dashboard`);
    await expect(page.getByRole('heading', { name: 'My preparation' })).toBeVisible();
    await expect(page.getByLabel('AI questions: 1 of 2 done')).toBeVisible();
    await expect(page.getByText('1 to revisit')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Acme' })).toHaveAttribute('href', '/c/acme');
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test('a failing dashboard offers a retry and says progress is safe', async ({ page, context, request }) => {
    await signIn(context, request);
    await control(request, 'config', { dataStatus: 503 });
    await page.goto(`${ON}/dashboard`);
    await expect(page.getByText('temporarily unavailable. Your progress is safe')).toBeVisible();
    await control(request, 'config', { dataStatus: 0 });
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByLabel('AI questions: 0 of 2 done')).toBeVisible();
  });

  test('while self-service deletion is off, it explains how to ask and shows the reference, with no delete button', async ({ page, context, request }) => {
    await signIn(context, request);
    await page.goto(`${ON}/dashboard`);
    await expect(page.getByText('Self-service deletion is not available yet')).toContainText('ref-ada');
    await expect(page.getByRole('button', { name: /Delete my account/ })).toHaveCount(0);
  });

  test('deletion (when the server allows it): confirm with Google, type the phrase, everything is erased locally', async ({ page, context, request }) => {
    await signIn(context, request);
    await control(request, 'config', { canDelete: true });
    await control(request, 'row', { ref: 'ref-ada', key: 'p:ai:101', value: 'done', rev: 1 });
    await page.route('https://accounts.google.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: 'google' }));
    await page.goto(`${ON}/prep/ai`); // saves a local copy first
    await expect(doneButton(page, 'How does attention work?')).toHaveAttribute('data-status', 'done');
    await page.goto(`${ON}/dashboard`);
    await page.getByRole('button', { name: 'Delete my account…' }).click();
    await page.waitForURL('https://accounts.google.com/**');
    await control(request, 'config', { reauthFresh: true });
    await page.goto(`${ON}/dashboard?reauth=1`);
    const confirm = page.getByRole('button', { name: 'Permanently delete my account' });
    await expect(confirm).toBeDisabled();
    await page.getByLabel(/Type “delete my account”/).fill('delete my account');
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.getByRole('heading', { name: 'Your account has been deleted' })).toBeVisible();
    expect((await state(request)).deleted).toEqual(['ref-ada']);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('isx-u:')))).toEqual([]);
    await page.goto(`${ON}/prep/ai`);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('deletion without a fresh Google confirmation is refused and asks again; nothing is deleted', async ({ page, context, request }) => {
    await signIn(context, request);
    await control(request, 'config', { canDelete: true, reauthFresh: false });
    await page.goto(`${ON}/dashboard?reauth=1`);
    await page.getByLabel(/Type “delete my account”/).fill('delete my account');
    await page.getByRole('button', { name: 'Permanently delete my account' }).click();
    await expect(page.getByText('confirm with Google again')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete my account…' })).toBeVisible();
    expect((await state(request)).deleted).toEqual([]);
  });
});

test.describe('privacy page', () => {
  test('is reachable signed out and says that deleted data can persist in backups', async ({ page }) => {
    await page.goto(`${ON}/privacy`);
    await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();
    await expect(page.getByText('deleted data can persist in those backups until they expire')).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
  });
});

test('the browser never sends our proxy key or a body it should not, and every private response is no-store', async ({ page, context, request }) => {
  await signIn(context, request);
  const responses = [];
  page.on('response', (r) => { const p = new URL(r.url()).pathname; if (p === '/me' || p.startsWith('/me/') || p.startsWith('/auth/')) responses.push(r); });
  await page.goto(`${ON}/prep/ai`);
  await doneButton(page, 'How does attention work?').click();
  await expect.poll(async () => (await state(request)).rows['ref-ada|p:ai:101']?.value).toBe('done');
  expect(responses.length).toBeGreaterThan(2);
  for (const r of responses) {
    expect(r.headers()['cache-control']).toBe('private, no-store');
    expect(r.request().headers()['x-api-key']).toBeUndefined();
  }
  const calls = (await state(request)).calls;
  expect(calls.every((c) => c.hadKey)).toBe(true);
  expect(calls.filter((c) => c.method === 'PUT').every((c) => c.origin === ON)).toBe(true);
});
