import { expect, test } from '@playwright/test';
import { SITE, clean, prepare, signInThroughUi, sql } from './helpers.mjs';

test.beforeEach(async ({ context, request }) => { await prepare(context); await clean(request); });

test('an expired session is rejected at once, and the real scheduled run (cron) then deletes it', async ({ page, context, request }) => {
  await page.goto(`${SITE}/prep/ai`);
  await signInThroughUi(page, 'Ada Lovelace');
  const sessions = async () => Number((await sql(request, 'users', 'SELECT COUNT(*) AS n FROM sessions'))[0].n);
  expect(await sessions()).toBe(1);

  await sql(request, 'users', 'UPDATE sessions SET expires_at = ?', [Date.now() - 1000]); // expire it, as time passing would
  const me = await context.request.get(`${SITE}/me`);
  expect(me.status()).toBe(401); // rejected immediately: cleanup has not run
  expect(await sessions()).toBe(1);

  const run = await request.get(`${SITE}/__test/scheduled`); // wrangler's --test-scheduled endpoint: the real scheduled() handler
  expect(run.ok()).toBe(true);
  await expect.poll(sessions).toBe(0);
});
