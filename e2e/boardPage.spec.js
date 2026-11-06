'use strict';

// The handle, board only and the settings, the same on every page.

const { test, expect } = require('@playwright/test');
const { PAGES, SIZES, fixtures, logIn, measure, watchErrors } = require('./helpers');

async function dragHandle(page, { dx = 0, dy = 0 }) {
    const box = await page.locator('.split-handle').boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 4 });
    await page.mouse.up();
}

for (const pageName of Object.keys(PAGES)) {
    test.describe(`${pageName} page`, () => {
        test.beforeEach(async ({ context, request }) => {
            await logIn(context, await fixtures(request));
        });

        test.describe('in landscape', () => {
            test.use(SIZES.desktop);

            test('the handle moves the split, which is remembered and can be reset', async ({ page, request }) => {
                await PAGES[pageName](page, request, await fixtures(request));
                const before = await measure(page);
                await dragHandle(page, { dx: -300 });
                const smaller = await measure(page);
                expect(smaller.area.width).toBeLessThan(before.area.width - 200);
                expect(smaller.panel.width).toBeGreaterThan(before.panel.width + 200);

                await page.reload();
                await expect(page.locator('#board .point').first()).toBeVisible();
                expect((await measure(page)).area.width).toBeCloseTo(smaller.area.width, -1);

                await page.locator('.split-handle').dblclick();
                expect((await measure(page)).area.width).toBeCloseTo(before.area.width, -1);
            });

            test('the arrow keys move the handle', async ({ page, request }) => {
                await PAGES[pageName](page, request, await fixtures(request));
                const before = await measure(page);
                await page.locator('.split-handle').focus();
                await page.keyboard.press('ArrowLeft');
                await page.keyboard.press('ArrowLeft');
                expect((await measure(page)).area.width).toBeLessThan(before.area.width);
            });

            test('board only gives the board the room and comes back', async ({ page, request }) => {
                const errors = watchErrors(page);
                await PAGES[pageName](page, request, await fixtures(request));
                const before = await measure(page);
                await page.locator('#maximizeBtn').click();
                await expect(page.locator('.app-header')).toBeHidden();
                await expect(page.locator('.split-handle')).toBeHidden();
                await expect(page.locator('.board-only-bar')).toBeVisible();
                const big = await measure(page);
                expect(big.board.width).toBeGreaterThan(before.board.width);
                expect(big.board.bottom).toBeLessThanOrEqual(big.view.height);
                expect(big.board.height).toBeGreaterThan(big.view.height - 20);

                await page.locator('.board-only-bar button').click();
                await expect(page.locator('.app-header')).toBeVisible();
                expect((await measure(page)).board.width).toBeCloseTo(before.board.width, 0);

                // As fast as a person: WebKit takes Esc for itself, once it is really fullscreen.
                await page.waitForTimeout(600);
                await page.keyboard.press('z');
                await expect(page.locator('.app-header')).toBeHidden();
                await page.waitForTimeout(600);
                await page.keyboard.press('Escape');
                await expect(page.locator('.app-header')).toBeVisible();
                expect(errors).toEqual([]);
            });

            test('the settings open, switch the theme and close', async ({ page, request }) => {
                const errors = watchErrors(page);
                await PAGES[pageName](page, request, await fixtures(request));
                const menu = page.locator('#settingsPanel');
                await expect(menu).toBeHidden();
                await page.locator('#settingsBtn').click();
                await expect(menu).toBeVisible();
                await page.screenshot({ path: `test-results/screens/settings-${pageName}.png` });
                await page.locator('#themeBtn').click();
                await expect(page.locator('html')).toHaveAttribute('data-theme', 'classic');
                await expect(page.locator('#themeBtn')).toHaveText('Theme: classic board');
                await page.keyboard.press('Escape');
                await expect(menu).toBeHidden();
                await page.reload();
                await expect(page.locator('html')).toHaveAttribute('data-theme', 'classic');
                expect(errors).toEqual([]);
            });
        });

        test.describe('in portrait', () => {
            test.use(SIZES['tablet portrait']);

            test('the handle moves the split up and down', async ({ page, request }) => {
                await PAGES[pageName](page, request, await fixtures(request));
                const before = await measure(page);
                await dragHandle(page, { dy: -200 });
                const smaller = await measure(page);
                expect(smaller.area.height).toBeLessThan(before.area.height - 100);
                expect(smaller.panel.height).toBeGreaterThan(before.panel.height + 100);
            });
        });

        for (const sizeName of ['phone portrait', 'phone landscape']) {
            test.describe(`on a ${sizeName}`, () => {
                test.use(SIZES[sizeName]);

                test('board only keeps the whole board on the screen', async ({ page, request }) => {
                    await PAGES[pageName](page, request, await fixtures(request));
                    const before = await measure(page);
                    await page.evaluate(() => document.querySelector('#maximizeBtn').click());
                    await expect(page.locator('.app-header')).toBeHidden();
                    const big = await measure(page);
                    expect(big.board.width).toBeGreaterThanOrEqual(before.board.width);
                    expect(big.board.bottom).toBeLessThanOrEqual(big.view.height);
                    expect(big.scroll.height).toBeLessThanOrEqual(big.view.height);
                    expect(big.panel.bottom).toBeLessThanOrEqual(big.view.height);
                    await page.screenshot({ path: `test-results/screens/board-only-${pageName}-${sizeName.replace(' ', '-')}.png` });
                });
            });
        }
    });
}

test('a split chosen on one page applies on the others', async ({ page, context, request }) => {
    const data = await fixtures(request);
    await logIn(context, data);
    await page.setViewportSize(SIZES.desktop.viewport);
    await PAGES.play(page, request, data);
    await dragHandle(page, { dx: -300 });
    const chosen = await measure(page);
    await PAGES.review(page, request, data);
    expect((await measure(page)).area.width).toBeCloseTo(chosen.area.width, -1);
});
