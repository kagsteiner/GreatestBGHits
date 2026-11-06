'use strict';

// The pages without a board share the theme of the site with those that have one.

const { test, expect } = require('@playwright/test');
const { SIZES, fixtures, logIn, watchErrors } = require('./helpers');

const PAGES = ['index', 'help', 'documentation', 'sitestats', 'progress', 'statistics'];

for (const name of PAGES) {
    test.describe(`${name} page`, () => {
        test.use(SIZES.desktop);

        test('the button switches the theme, which stays and reaches the board pages', async ({ page, context, request }) => {
            await logIn(context, await fixtures(request));
            const errors = watchErrors(page);
            const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundImage + getComputedStyle(document.body).backgroundColor);
            await page.goto(`/${name}.html`);
            const toggle = page.locator('.theme-toggle');
            await expect(toggle.locator('.icon-sun')).toBeVisible();
            const dark = await background();

            await toggle.click();
            await expect(page.locator('html')).toHaveAttribute('data-theme', 'classic');
            await expect(toggle.locator('.icon-board')).toBeVisible();
            await expect(toggle.locator('.icon-sun')).toBeHidden();
            expect(await background()).not.toBe(dark);

            await page.reload();
            await expect(page.locator('html')).toHaveAttribute('data-theme', 'classic');
            const board = await context.newPage();
            await board.goto('/review.html?id=e2e-match');
            await expect(board.locator('html')).toHaveAttribute('data-theme', 'classic');
            await board.close();

            await page.locator('.theme-toggle').click();
            await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'classic');
            expect(await background()).toBe(dark);
            expect(errors).toEqual([]);
        });
    });
}
