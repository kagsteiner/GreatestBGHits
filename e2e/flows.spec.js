'use strict';

// Each part of the app still does its job on the shared page.

const { test, expect } = require('@playwright/test');
const { SIZES, fixtures, logIn, startFriendMatch, watchErrors } = require('./helpers');

test.use(SIZES.desktop);

async function moveChecker(page, from, to) {
    await page.locator(`#board [data-mp="${from}"]`).click();
    await page.locator(`#board [data-mp="${to}"]`).click();
}

test.describe('quiz', () => {
    test.beforeEach(async ({ context, request }) => {
        await logIn(context, await fixtures(request));
    });

    test('answer, feedback, and analysis offered only then', async ({ page }) => {
        const errors = watchErrors(page);
        await page.goto('/quiz.html');
        await expect(page.locator('#quizQuestion')).toHaveText('Choose the best checker play');
        await expect(page.locator('#toMove')).toHaveText('blue to move');
        await expect(page.locator('#analysisBtn')).toBeHidden();
        await page.getByText('13/8 6/5', { exact: true }).click();
        await page.locator('#rateBtn').click();
        await expect(page.locator('#feedback .result')).toBeVisible();
        await expect(page.locator('#analysisBtn')).toBeVisible();
        await expect(page.locator('#nextBtn')).toBeVisible();
        expect(errors).toEqual([]);
    });

    test('the theme changes the color named in the title', async ({ page }) => {
        await page.goto('/quiz.html');
        await expect(page.locator('#toMove')).toHaveText('blue to move');
        await page.locator('#settingsBtn').click();
        await page.locator('#themeBtn').click();
        await expect(page.locator('#toMove')).toHaveText('black to move');
    });

    test('flip, lock and mirror still turn the board', async ({ page }) => {
        const errors = watchErrors(page);
        await page.goto('/quiz.html');
        await expect(page.locator('#options .option').first()).toBeVisible();
        const firstTop = () => page.locator('#points-top .point').first().getAttribute('data-abs');
        const top = await firstTop();
        await page.locator('#mirrorBoardBtn').click();
        expect(await firstTop()).not.toBe(top);
        await page.locator('#settingsBtn').click();
        await expect(page.locator('#lockBoardBtn')).toHaveAttribute('aria-pressed', 'true');
        await page.locator('#flipBoardBtn').click();
        await expect(page.locator('#lockBoardBtn')).toHaveAttribute('aria-pressed', 'false');
        expect(errors).toEqual([]);
    });

    test('the links on the statistics page open their quiz', async ({ page }) => {
        const errors = watchErrors(page);
        await page.goto('/quiz.html?id=quiz-checker');
        await expect(page.locator('#options .option').first()).toBeVisible();
        expect(errors).toEqual([]);
    });

    test('a link to a quiz that is gone gives the next one', async ({ page }) => {
        const errors = watchErrors(page);
        await page.goto('/quiz.html?id=no-such-quiz');
        await expect(page.locator('#options .option').first()).toBeVisible();
        expect(errors).toEqual([]);
    });

    test('checkers can be moved on the board with the engine in the page', async ({ page, browserName }) => {
        test.skip(browserName !== 'chromium', 'one browser is enough for the engine');
        test.setTimeout(60000);
        await page.goto('/quiz.html');
        await expect(page.locator('#boardPlayStatus')).toHaveText('Or move the checkers on the board.', { timeout: 45000 });
        await moveChecker(page, 13, 8);
        await expect(page.locator('#boardPlayStatus')).toContainText('Dice left');
        await page.locator('#boardUndoBtn').click();
        await expect(page.locator('#boardPlayStatus')).toHaveText('Or move the checkers on the board.');
    });
});

test.describe('play', () => {
    test.beforeEach(async ({ context, request }) => {
        await logIn(context, await fixtures(request));
    });

    test('a match starts and a move can be made, history opens', async ({ page, browserName }) => {
        test.skip(browserName !== 'chromium', 'one browser is enough for the engine');
        test.setTimeout(60000);
        const errors = watchErrors(page);
        await page.goto('/play.html');
        await expect(page.locator('#startBtn')).toBeVisible({ timeout: 45000 });
        await page.locator('#startBtn').click();
        await expect(page.locator('#playStatus')).toContainText('Your roll');
        await moveChecker(page, 13, 8);
        await moveChecker(page, 6, 5);
        await expect(page.locator('#doneBtn')).toBeEnabled();
        await page.keyboard.press('Enter');
        await expect(page.locator('#playLog')).toContainText('You (5-1): 13/8 6/5');
        await page.locator('#historyBtn').click();
        await expect(page.locator('#historyView')).toBeVisible();
        await expect(page.locator('#historyRows tr').first()).toBeVisible();
        expect(errors).toEqual([]);
    });
});

test.describe('review', () => {
    test('steps through the match, with the way back in the header', async ({ page, context, request }) => {
        const data = await fixtures(request);
        await logIn(context, data);
        const errors = watchErrors(page);
        await page.goto(`/review.html?id=${data.matchId}`);
        await expect(page.locator('#stepTitle')).toContainText('13/8 6/5');
        await expect(page.locator('.back-button')).toHaveAttribute('href', 'play.html');
        await page.locator('#nextBtn').click();
        await expect(page.locator('#stepMeta')).toContainText('Step 2 of');
        await page.keyboard.press('ArrowRight');
        await expect(page.locator('#stepMeta')).toContainText('Step 3 of');
        await page.locator('#nextMarkedBtn').click();
        await expect(page.locator('#stepGrade')).toContainText('You marked this');
        expect(errors).toEqual([]);
    });
});

test.describe('friend', () => {
    test('the other player watches the move, and both see it finished', async ({ page, browser, context, request }) => {
        const data = await fixtures(request);
        await logIn(context, data);
        const errors = watchErrors(page);
        await startFriendMatch(page, request, data);

        const fredContext = await browser.newContext({ viewport: SIZES.desktop.viewport });
        // Fred's browser, under the id the helper sat down with.
        await logIn(fredContext, data, 'Fred');
        await fredContext.addInitScript(() => localStorage.setItem('bgPlayPlayer', 'e2e-fred-browser'));
        const fred = await fredContext.newPage();
        await fred.goto('/friend.html');
        await expect(fred.locator('#playStatus')).toContainText('rolled 5-1 and is moving');

        await moveChecker(page, 13, 8);
        await expect(fred.locator('#board')).toHaveClass(/previewing/);
        await moveChecker(page, 6, 5);
        await page.keyboard.press('Enter');
        await expect(page.locator('#playLog')).toContainText('13/8 6/5');
        await expect(fred.locator('#playLog')).toContainText('13/8 6/5');
        await expect(fred.locator('#board')).not.toHaveClass(/previewing/);
        await expect(fred.locator('#playStatus')).toContainText('Your');
        await fredContext.close();
        expect(errors).toEqual([]);
    });
});

test.describe('moving checkers', () => {
    test('by dragging, with a checker of the board\'s size in the hand', async ({ page, context, request }) => {
        const data = await fixtures(request);
        await logIn(context, data);
        await startFriendMatch(page, request, data);
        const from = await page.locator('#board [data-mp="13"]').boundingBox();
        const to = await page.locator('#board [data-mp="8"]').boundingBox();
        await page.mouse.move(from.x + from.width / 2, from.y + 40);
        await page.mouse.down();
        await page.mouse.move(to.x + to.width / 2, to.y + 40, { steps: 6 });
        const sizes = await page.evaluate(() => [
            document.querySelector('.drag-ghost').offsetWidth,
            document.querySelector('#board .checker').offsetWidth
        ]);
        expect(sizes[0]).toBe(sizes[1]);
        await page.mouse.up();
        await expect(page.locator('#playStatus')).toContainText('Dice left: 1');
    });

    test('with fast moves, the choice is remembered', async ({ page, context, request }) => {
        const data = await fixtures(request);
        await logIn(context, data);
        await startFriendMatch(page, request, data);
        await page.locator('#settingsBtn').click();
        await page.locator('#fastMoveToggle').check();
        await page.keyboard.press('Escape');
        await page.locator('#board [data-mp="13"]').click();
        await expect(page.locator('#playStatus')).toContainText('Dice left: 1');
        await page.reload();
        await expect(page.locator('#playStatus')).toContainText('Your roll');
        await page.locator('#settingsBtn').click();
        await expect(page.locator('#fastMoveToggle')).toBeChecked();
        await page.locator('#fastMoveToggle').uncheck();
    });
});

test.describe('on a phone', () => {
    test.use(SIZES['small phone']);

    test('checkers move by tapping', async ({ page, context, request }) => {
        const data = await fixtures(request);
        await logIn(context, data);
        await startFriendMatch(page, request, data);
        await page.locator('#board [data-mp="13"]').tap();
        await page.locator('#board [data-mp="8"]').tap();
        await expect(page.locator('#playStatus')).toContainText('Dice left: 1');
        await page.locator('#board [data-mp="6"]').tap();
        await page.locator('#board [data-mp="5"]').tap();
        await expect(page.locator('#doneBtn')).toBeEnabled();
        await page.locator('#doneBtn').tap();
        await expect(page.locator('#playLog')).toContainText('13/8 6/5');
    });

    test('the title says who is on roll, and the filter stays on the screen', async ({ page, context, request }) => {
        await logIn(context, await fixtures(request));
        await page.goto('/quiz.html');
        await expect(page.locator('#options .option').first()).toBeVisible();
        const title = await page.locator('.app-header h1').evaluate((h1) => h1.scrollWidth <= h1.clientWidth);
        expect(title).toBe(true);
        await expect(page.locator('#toMove')).toBeVisible();
        await page.locator('#filterBtn').tap();
        const box = await page.locator('#filterPanel').boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(360);
    });

    test('someone new sees the login, which fits the screen', async ({ page }) => {
        await page.goto('/quiz.html');
        const dialog = page.locator('.dg-auth-modal');
        await expect(dialog).toBeVisible();
        const box = await dialog.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(360);
        await page.screenshot({ path: 'test-results/screens/quiz-login-small-phone.png' });
    });
});

test('the classic theme on the shared board', async ({ page, context, request }) => {
    const data = await fixtures(request);
    await logIn(context, data);
    await context.addInitScript(() => localStorage.setItem('sr-theme', 'classic'));
    await startFriendMatch(page, request, data);
    await page.screenshot({ path: 'test-results/screens/friend-classic.png' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'classic');
});
