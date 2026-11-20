import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const ON = 'http://127.0.0.1:8801';
const OFF = 'http://127.0.0.1:8802';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

test.setTimeout(120_000); // each test visits several pages

test.beforeEach(async ({ request, context }) => {
  await request.post(`${ON}/__test/reset`);
  await context.route(/fonts.(googleapis|gstatic).com/, (route) => route.abort()); // never depend on the public internet
});

async function signIn(context, request) {
  await request.post(`${ON}/__test/session`, { data: { token: 'tok-ada-0001', ref: 'ref-ada', name: 'Ada Lovelace', email: 'ada@example.com' } });
  await context.addCookies([{ name: 'sid', value: 'tok-ada-0001', url: ON }]);
}

// Every violation is reported; only critical and serious ones fail the test (moderate and minor are listed in the output).
async function audit(page, label) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const summary = violations.map((v) => `${v.impact} ${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  if (summary.length) console.log(`[axe] ${label}\n  ${summary.join('\n  ')}`);
  const blocking = violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(blocking.map((v) => `${v.id}: ${v.help}`), label).toEqual([]);
  return violations;
}

for (const scheme of ['light', 'dark']) {
  test.describe(`${scheme} theme`, () => {
    test.beforeEach(async ({ page }) => { await page.emulateMedia({ colorScheme: scheme }); });

    test('public pages with sign-in off', async ({ page }) => {
      for (const path of ['/', '/prep/ai', '/c/acme', '/q/101', '/privacy']) {
        await page.goto(`${OFF}${path}`);
        await page.waitForLoadState('networkidle');
        await audit(page, `off ${path}`);
      }
    });

    test('signed out with sign-in on, including the dialog', async ({ page }) => {
      for (const path of ['/prep/ai', '/prep/system-design', '/c/acme', '/q/101', '/dashboard']) {
        await page.goto(`${ON}${path}`);
        await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
        await page.waitForLoadState('networkidle');
        await audit(page, `signed out ${path}`);
      }
      await page.goto(`${ON}/prep/ai`);
      await page.getByRole('button', { name: 'Done' }).first().click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await audit(page, 'sign-in dialog');
    });

    test('signed in: lists, pressed selectors, open menu, dashboard and deletion', async ({ page, context, request }) => {
      await signIn(context, request);
      await request.post(`${ON}/__test/config`, { data: { canDelete: true } });
      await request.post(`${ON}/__test/row`, { data: { ref: 'ref-ada', key: 'p:ai:101', value: 'done', rev: 1 } });
      await request.post(`${ON}/__test/row`, { data: { ref: 'ref-ada', key: 'p:ai:102', value: 'revisit', rev: 1 } });
      await request.post(`${ON}/__test/row`, { data: { ref: 'ref-ada', key: 'c:acme', value: true, rev: 1 } });
      for (const path of ['/prep/ai', '/prep/system-design', '/c/acme', '/q/101']) {
        await page.goto(`${ON}${path}`);
        await expect(page.getByRole('button', { name: 'Account menu for Ada Lovelace' })).toBeVisible();
        await expect(page.locator('.prog[aria-busy="false"]').first()).toBeVisible();
        await audit(page, `signed in ${path}`);
      }
      await page.getByRole('button', { name: 'Account menu for Ada Lovelace' }).click();
      await expect(page.getByText('Signed in as Ada Lovelace')).toBeVisible();
      await audit(page, 'account menu open');
      await page.goto(`${ON}/dashboard`);
      await expect(page.getByLabel('AI questions: 1 of 2 done')).toBeVisible();
      await audit(page, 'dashboard');
      await page.goto(`${ON}/dashboard?reauth=1`);
      await expect(page.getByLabel(/Type “delete my account”/)).toBeVisible();
      await audit(page, 'deletion confirmation');
    });
  });
}
