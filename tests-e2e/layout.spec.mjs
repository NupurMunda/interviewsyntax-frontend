import { expect, test } from '@playwright/test';

const ON = 'http://127.0.0.1:8801';
const WIDTHS = [320, 360, 375, 390, 414, 768];

test.setTimeout(120_000); // each test visits several pages

test.beforeEach(async ({ request, context }, info) => {
  await context.route(/fonts.(googleapis|gstatic).com/, (route) => route.abort()); // never depend on the public internet

  test.skip(info.project.name !== 'desktop', 'sizes are set explicitly below, so one project is enough');
  await request.post(`${ON}/__test/reset`);
  await request.post(`${ON}/__test/session`, { data: { token: 'tok-ada-0001', ref: 'ref-ada', name: 'Ada Lovelace', email: 'ada.lovelace.with.a.long.address@example.com' } });
});

const overlaps = (a, b) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

for (const width of WIDTHS) {
  test.describe(`${width}px wide`, () => {
    async function open(browser, signedIn, path) {
      const context = await browser.newContext({ viewport: { width, height: 700 }, hasTouch: width < 768, isMobile: width < 768 });
      await context.route(/fonts.(googleapis|gstatic).com/, (route) => route.abort());
      if (signedIn) await context.addCookies([{ name: 'sid', value: 'tok-ada-0001', url: ON }]);
      const page = await context.newPage();
      await page.goto(`${ON}${path}`);
      await expect(page.getByRole('button', { name: signedIn ? /Account menu/ : 'Sign in' })).toBeVisible();
      if (signedIn && /^\/(prep|c|q)\//.test(path)) await expect(page.locator('.prog[aria-busy="false"]').first()).toBeVisible();
      return { context, page };
    }

    for (const signedIn of [false, true]) {
      test(`${signedIn ? 'signed in' : 'signed out'}: no sideways scroll, header controls do not overlap, targets are big enough`, async ({ browser }) => {
        for (const path of ['/prep/ai', '/c/acme', '/q/101', '/dashboard', '/privacy']) {
          const { context, page } = await open(browser, signedIn, path);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${path}: horizontal scroll`).toBe(true);
          const boxes = await page.locator('header.top > :visible').evaluateAll((nodes) => nodes.map((n) => { const r = n.getBoundingClientRect(); return { name: n.id || n.className, x: r.x, y: r.y, width: r.width, height: r.height }; }));
          for (let i = 0; i < boxes.length; i += 1) {
            expect(boxes[i].x, `${path}: ${boxes[i].name} inside the screen`).toBeGreaterThanOrEqual(-0.5);
            expect(boxes[i].x + boxes[i].width, `${path}: ${boxes[i].name} inside the screen`).toBeLessThanOrEqual(width + 0.5);
            for (let j = i + 1; j < boxes.length; j += 1) expect(overlaps(boxes[i], boxes[j]), `${path}: ${boxes[i].name} overlaps ${boxes[j].name}`).toBe(false);
          }
          const logo = await page.locator('.logo:visible').first().boundingBox();
          expect(logo.height, `${path}: logo is not squeezed`).toBeGreaterThanOrEqual(26);
          const small = await page.locator('.acct-btn, #signin-open, .prog-btn, #theme').evaluateAll((nodes) => nodes.filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && (r.width < 32 || r.height < 32); }).map((n) => n.className || n.id));
          expect(small, `${path}: targets under 32px`).toEqual([]);
          await context.close();
        }
      });
    }

    test('the account menu stays fully on screen, does not scroll the page, and closes with Escape', async ({ browser }) => {
      const { context, page } = await open(browser, true, '/prep/ai');
      await page.getByRole('button', { name: /Account menu/ }).click();
      const panel = page.locator('#acct-panel');
      await expect(panel).toBeVisible();
      const box = await panel.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(15);
      expect(box.x + box.width).toBeLessThanOrEqual(width - 15);
      expect(box.y + box.height).toBeLessThanOrEqual(700);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await expect(panel.getByText('ada.lovelace.with.a.long.address@example.com')).toBeVisible(); // long email wraps, not clipped
      const email = await panel.locator('.acct-email').boundingBox();
      expect(email.x + email.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
      await context.close();
    });

    test('the Google button keeps its fixed size and the sign-in dialog fits the screen', async ({ browser }) => {
      const { context, page } = await open(browser, false, '/prep/ai');
      await page.getByRole('button', { name: 'Done' }).first().click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const d = await dialog.boundingBox();
      expect(d.x).toBeGreaterThanOrEqual(0);
      expect(d.x + d.width).toBeLessThanOrEqual(width);
      const g = await page.locator('.gbtn img:visible').boundingBox();
      expect(Math.round(g.height)).toBe(40);
      expect(Math.round(g.width)).toBe(180);
      await context.close();
    });
  });
}
