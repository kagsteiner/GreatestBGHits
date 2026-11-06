'use strict';

// What the two pages where a match is played share: the access key, the
// clickable dice and cube, and how a mistake is told and marked.

const { test, expect } = require('@playwright/test');
const { SIZES, fixtures, logIn, startFriendMatch, watchErrors } = require('./helpers');

test.use(SIZES.desktop);

async function moveChecker(page, from, to) {
    await page.locator(`#board [data-mp="${from}"]`).click();
    await page.locator(`#board [data-mp="${to}"]`).click();
}

/** The fake engine calls this play a blunder. */
async function playBlunder(page) {
    await moveChecker(page, 24, 23);
    await moveChecker(page, 13, 8);
    await expect(page.locator('#playStatus')).toContainText('Your move:');
    await page.locator('#dice').click();
}

for (const [name, panel] of [['play', '#playPanel'], ['friend', '#friendPanel']]) {
    test(`the access key is asked for on the ${name} page, and again if it is wrong`, async ({ page, request }) => {
        const data = await fixtures(request);
        const errors = watchErrors(page);
        await page.goto(`/${name}.html`);
        const form = page.locator('#keyForm');
        await expect(form.locator('label')).toHaveText('Access key');
        await expect(page.locator(panel)).toBeHidden();
        await page.locator('#keyInput').fill('not-the-key');
        await page.keyboard.press('Enter');
        await expect(form.locator('label')).toHaveText('The access key was not accepted.');
        await page.locator('#keyInput').fill(data.playKey);
        await form.getByRole('button', { name: 'Continue' }).click();
        await expect(form).toBeHidden();
        await expect(name === 'play' ? page.locator(panel) : page.locator('#joinForm')).toBeVisible();
        expect(errors).toEqual([]);
    });
}

test('against the engine: dice and cube can be clicked, a mistake can be marked', async ({ page, context, request, browserName }) => {
    test.skip(browserName !== 'chromium', 'one browser is enough for the engine');
    test.setTimeout(60000);
    await logIn(context, await fixtures(request));
    await request.post('/__e2e/reset');
    const errors = watchErrors(page);
    await page.goto('/play.html');
    await expect(page.locator('#startBtn')).toBeVisible({ timeout: 45000 });
    await page.locator('#startBtn').click();
    await expect(page.locator('#playStatus')).toContainText('Your roll');
    await expect(page.locator('#matchInfo')).toContainText('Match to 7 points, 0 : 0');

    await playBlunder(page);
    const flag = page.locator('#playFeedback .play-flag');
    await expect(flag.locator('strong')).toContainText('(−0.200)');
    await expect(flag).toContainText('You played 24/23 13/8. Best: 13/8 6/5.');
    const mark = flag.locator('.mark-button');
    await expect(mark).toHaveText('☆ Mark for review');
    await mark.click();
    await expect(mark).toHaveText('★ Marked for review');
    await expect(mark).toHaveAttribute('aria-pressed', 'true');

    await expect(page.locator('#rollBtn')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#dice .die.ready')).toHaveCount(2);
    await expect(page.locator('#cube')).toHaveAttribute('title', 'Double to 2');
    await page.locator('#cube').click();
    await expect(page.locator('#playLog')).toContainText('You double to 2.');
    expect(errors).toEqual([]);
});

test('between friends: dice and cube can be clicked, a mistake can be marked', async ({ page, browser, context, request }) => {
    const data = await fixtures(request);
    await logIn(context, data);
    const errors = watchErrors(page);
    await startFriendMatch(page, request, data);
    await expect(page.locator('#matchInfo')).toContainText('Match to 3 points, 0 : 0');

    const fredContext = await browser.newContext({ viewport: SIZES.desktop.viewport });
    await logIn(fredContext, data, 'Fred');
    await fredContext.addInitScript(() => localStorage.setItem('bgPlayPlayer', 'e2e-fred-browser'));
    const fred = await fredContext.newPage();
    await fred.goto('/friend.html');

    await playBlunder(page);
    const flag = page.locator('#playFeedback .play-flag');
    await expect(flag.locator('strong')).toContainText('You: ');
    await expect(flag).toContainText('Played 24/23 13/8. Best: 13/8 6/5.');
    const mark = flag.locator('.mark-button');
    await expect(mark).toHaveText('☆ Mark');
    await mark.click();
    await expect(mark).toHaveText('★ Marked');
    await expect(fred.locator('#playFeedback .play-flag strong')).toContainText('Karl: ');

    await expect(fred.locator('#rollBtn')).toBeVisible();
    await expect(fred.locator('#dice .die.ready')).toHaveCount(2);
    await expect(fred.locator('#cube')).toHaveAttribute('title', 'Double to 2');
    await fred.locator('#cube').click();
    await expect(page.locator('#playStatus')).toContainText('Fred doubles to 2. Take or pass?');
    await page.locator('#passBtn').click();
    await expect(page.locator('#playStatus')).toContainText('You pass. Fred wins 1 point.');
    await fredContext.close();
    expect(errors).toEqual([]);
});
