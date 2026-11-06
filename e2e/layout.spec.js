'use strict';

// The same layout on every page at every screen size.

const path = require('path');
const { test, expect } = require('@playwright/test');
const { PAGES, SIZES, fixtures, logIn, measure, watchErrors } = require('./helpers');

for (const [sizeName, size] of Object.entries(SIZES)) {
    test.describe(sizeName, () => {
        test.use(size);

        for (const [pageName, open] of Object.entries(PAGES)) {
            test(`${pageName} page`, async ({ page, context, request }, testInfo) => {
                const data = await fixtures(request);
                await logIn(context, data);
                const errors = watchErrors(page);
                await open(page, request, data);
                await page.waitForTimeout(150);
                const screens = path.join('test-results', 'screens', testInfo.project.name);
                await page.screenshot({ path: path.join(screens, `${pageName}-${sizeName.replace(' ', '-')}.png`) });

                const seen = await measure(page);
                const { view, scroll, header, board, area, panel, handle, numbers, points } = seen;
                // The page itself never scrolls.
                expect(scroll.width).toBeLessThanOrEqual(view.width);
                expect(scroll.height).toBeLessThanOrEqual(view.height);
                // A slim header with the same buttons.
                expect(header.height).toBeLessThanOrEqual(76);
                expect(seen.buttons).toBeGreaterThanOrEqual(2);
                // The whole board is on the screen and in proportion.
                expect(board.left).toBeGreaterThanOrEqual(0);
                expect(board.right).toBeLessThanOrEqual(view.width);
                expect(board.bottom).toBeLessThanOrEqual(view.height);
                expect(board.width / board.height).toBeCloseTo(4 / 3, 1);
                expect(numbers.width).toBeCloseTo(board.width, 0);
                // All points equally wide, and checkers fit on them and on the board.
                expect(points.count).toBe(24);
                expect(points.max - points.min).toBeLessThan(1);
                expect(seen.checker).toBeLessThanOrEqual(points.min);
                expect(seen.checker).toBeGreaterThan(14);
                expect(seen.lowestChecker).toBeLessThanOrEqual(board.bottom);
                expect(seen.highestChecker).toBeGreaterThanOrEqual(board.top);
                // The panel beside the board in landscape, below it in portrait, with the handle between them.
                if (view.width > view.height) {
                    expect(panel.left).toBeGreaterThanOrEqual(area.right);
                    expect(handle.left).toBeGreaterThanOrEqual(area.right);
                    expect(handle.right).toBeLessThanOrEqual(panel.left);
                    expect(panel.width).toBeGreaterThanOrEqual(200);
                } else {
                    expect(panel.top).toBeGreaterThanOrEqual(area.bottom);
                    expect(handle.top).toBeGreaterThanOrEqual(area.bottom);
                    expect(handle.bottom).toBeLessThanOrEqual(panel.top);
                    expect(panel.height).toBeGreaterThanOrEqual(120);
                }
                expect(panel.right).toBeLessThanOrEqual(view.width);
                expect(panel.bottom).toBeLessThanOrEqual(view.height);
                expect(errors).toEqual([]);
            });
        }
    });
}
