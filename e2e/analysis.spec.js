'use strict';

// The same analysis panel, started from every part of the app.

const path = require('path');
const { test, expect } = require('@playwright/test');
const { SIZES, fixtures, logIn, startFriendMatch, watchErrors } = require('./helpers');

test.use(SIZES.desktop);

const results = (page) => page.locator('#analysisResults .analysis-result');

async function moveChecker(page, from, to) {
    await page.locator(`#board [data-mp="${from}"]`).click();
    await page.locator(`#board [data-mp="${to}"]`).click();
}

async function playFiveOne(page) {
    await moveChecker(page, 13, 8);
    await moveChecker(page, 6, 5);
    await expect(page.locator('#doneBtn')).toBeEnabled();
    await page.keyboard.press('Enter');
}

test.beforeEach(async ({ context, page, request }) => {
    await logIn(context, await fixtures(request));
    // No engine in the page: the depths and rollouts on offer are the server's, at once.
    await page.route('**/engine/**', (route) => route.abort());
});

test.describe('in the review', () => {
    test('results of a step stack up, the latest on top, and stay when stepping away', async ({ page, request }) => {
        const data = await fixtures(request);
        const errors = watchErrors(page);
        await page.goto(`/review.html?id=${data.matchId}`);
        await expect(page.locator('#analyseBtn')).toHaveText('Analyse plays');
        await expect(page.locator('#depthSelect')).toHaveValue('3');

        await page.locator('#analyseBtn').click();
        await expect(results(page)).toHaveCount(1);
        await expect(results(page).first()).toContainText('◀ played');
        await expect(results(page).first()).toContainText('3-ply');

        await page.locator('#depthSelect').selectOption('5');
        await page.locator('#analyseBtn').click();
        await expect(results(page)).toHaveCount(2);
        await expect(results(page).first()).toContainText('5-ply, 3 legal plays');

        // The same request again brings its result back to the top.
        await page.locator('#depthSelect').selectOption('3');
        await page.locator('#analyseBtn').click();
        await expect(results(page)).toHaveCount(2);
        await expect(results(page).first()).toContainText('3-ply, 3 legal plays');

        await page.locator('#rolloutSelect').selectOption('quick');
        await page.locator('#rolloutBtn').click();
        await expect(results(page)).toHaveCount(3);
        await expect(results(page).first()).toContainText('Rollout (quick)');

        await page.locator('#nextBtn').click();
        await expect(results(page)).toHaveCount(0);
        await page.locator('#prevBtn').click();
        await expect(results(page)).toHaveCount(3);
        expect(errors).toEqual([]);
    });

    test('a play in a table shows on the board, and a shallow one can be searched deeper', async ({ page, request }) => {
        const data = await fixtures(request);
        const errors = watchErrors(page);
        await page.goto(`/review.html?id=${data.matchId}`);
        await page.locator('#analyseBtn').click();
        const row = page.locator('#analysisResults tr[data-move="24/23 13/8"]');
        await row.click();
        await expect(page.locator('#board')).toHaveClass(/previewing/);
        await page.keyboard.press('Escape');
        await expect(page.locator('#board')).not.toHaveClass(/previewing/);

        const shallow = page.locator('#analysisResults tr[data-move="8/3 6/5"]');
        await expect(shallow).toHaveClass(/shallow/);
        await shallow.locator('.deepen-button').click();
        await expect(shallow).not.toHaveClass(/shallow/);
        expect(errors).toEqual([]);
    });
});

test.describe('on the quiz', () => {
    test('starts by itself once answered, and a deeper analysis updates the quiz', async ({ page, request }) => {
        const errors = watchErrors(page);
        await request.post('/__e2e/reset');
        await page.goto('/quiz.html');
        await page.getByText('13/8 6/5', { exact: true }).click();
        await page.locator('#rateBtn').click();
        await expect(page.locator('#analysisPanel')).toBeHidden();
        await page.locator('#analysisBtn').click();
        await expect(results(page)).toHaveCount(1);
        await expect(results(page).first()).toContainText('◀ your answer');
        await expect(page.locator('#analyseBtn')).toHaveText('Analyse plays');
        await expect(page.locator('#rolloutBtn')).toHaveText('Roll out the answers');
        await expect(page.locator('#depthSelect option[value="5"]')).toContainText('updates this quiz');

        await page.locator('#depthSelect').selectOption('5');
        await page.locator('#analyseBtn').click();
        await expect(page.locator('#analysisStatus')).toHaveText('Saved: this quiz now uses the 5-ply analysis.');
        await expect(results(page)).toHaveCount(2);
        await expect(page.locator('#depthSelect option[value="5"]')).not.toContainText('updates this quiz');

        await page.locator('#rolloutBtn').click();
        await expect(results(page).first()).toContainText('Rollout');

        // Closed and open again: nothing is lost, nothing runs again.
        await page.locator('#analysisBtn').click();
        await expect(page.locator('#analysisPanel')).toBeHidden();
        await page.locator('#analysisBtn').click();
        await expect(results(page)).toHaveCount(3);
        // The next quiz starts afresh.
        await page.locator('#nextBtn').click();
        await expect(page.locator('#analysisPanel')).toBeHidden();
        await expect(results(page)).toHaveCount(0);
        expect(errors).toEqual([]);
    });
});

test.describe('on a cube quiz', () => {
    test('the cube decision shows, deeper and rolled out too', async ({ browser, request }) => {
        const data = await fixtures(request);
        await request.post('/__e2e/reset');
        const context = await browser.newContext({ viewport: SIZES.desktop.viewport });
        await logIn(context, { ...data, quizUser: data.cubeQuizUser });
        const page = await context.newPage();
        const errors = watchErrors(page);
        await page.goto('/quiz.html');
        await page.getByText('No double', { exact: true }).click();
        await page.locator('#rateBtn').click();
        await page.locator('#analysisBtn').click();
        await expect(results(page)).toHaveCount(1);
        await expect(results(page).first()).toContainText('No double, take');
        await expect(page.locator('#analyseBtn')).toHaveText('Analyse cube');
        await expect(page.locator('#rolloutBtn')).toHaveText('Roll out cube');

        await page.locator('#depthSelect').selectOption('5');
        await page.locator('#analyseBtn').click();
        await expect(results(page)).toHaveCount(2);
        await page.locator('#rolloutBtn').click();
        await expect(results(page)).toHaveCount(3);
        await expect(results(page).first()).toContainText('Rollout');
        await context.close();
        expect(errors).toEqual([]);
    });
});

test.describe('during a match', () => {
    test('against the engine: what was played so far, and back to the match', async ({ page, request }) => {
        const errors = watchErrors(page);
        await request.post('/__e2e/reset');
        await page.goto('/play.html');
        await expect(page.locator('#startBtn')).toBeVisible();
        await expect(page.locator('#analyseLink')).toBeHidden();
        await page.locator('#startBtn').click();
        await expect(page.locator('#playStatus')).toContainText('Your roll');
        await playFiveOne(page);
        await expect(page.locator('#playLog')).toContainText('You (5-1): 13/8 6/5');
        await page.locator('#analyseLink').click();

        await expect(page).toHaveURL(/review\.html\?running=1/);
        await expect(page.locator('#stepList li').first()).toContainText('13/8 6/5');
        await expect(page.locator('.back-button')).toHaveAttribute('href', 'play.html');
        await expect(page.locator('#matBtn')).toBeHidden();
        await page.locator('#analyseBtn').click();
        await expect(results(page)).toHaveCount(1);

        await page.locator('.back-button').click();
        await expect(page.locator('#playStatus')).toContainText('Your');
        await expect(page.locator('#analyseLink')).toBeVisible();
        expect(errors).toEqual([]);
    });

    test('with a friend: the seat is kept, and what the friend plays comes in', async ({ page, request }) => {
        const data = await fixtures(request);
        const errors = watchErrors(page);
        await startFriendMatch(page, request, data);
        await expect(page.locator('#analyseLink')).toBeHidden();
        await playFiveOne(page);
        await expect(page.locator('#playLog')).toContainText('13/8 6/5');
        await page.locator('#analyseLink').click();

        await expect(page).toHaveURL(/review\.html\?friend=running/);
        await expect(page.locator('#stepTitle')).toContainText('You (Blue) play 5-1: 13/8 6/5');
        await expect(page.locator('#stepList li')).toHaveCount(1);
        await expect(page.locator('#runningNote')).toBeHidden();
        await expect(page.locator('.back-button')).toHaveAttribute('href', 'friend.html');
        await page.locator('#analyseBtn').click();
        await expect(results(page)).toHaveCount(1);

        const headers = { 'X-Play-Key': data.playKey, 'X-Play-Player': 'e2e-fred-browser' };
        const act = (body) => request.post('/friend/action', { headers, data: body });
        const state = async () => (await (await request.get('/friend/state', { headers })).json()).match;
        if ((await state()).phase === 'turn') await act({ type: 'roll' });
        await act({ type: 'move', key: (await state()).legal.plays[0].key });

        await expect(page.locator('#stepList li').filter({ hasText: 'Fred' })).not.toHaveCount(0, { timeout: 10000 });
        await expect(page.locator('#runningNote')).toContainText('It is your turn');
        // You stay where you were, with your results.
        await expect(page.locator('#stepTitle')).toContainText('You (Blue) play 5-1: 13/8 6/5');
        await expect(results(page)).toHaveCount(1);
        await page.locator('#runningNote a').click();
        await expect(page.locator('#playStatus')).toContainText('Your');
        expect(errors).toEqual([]);
    });

    test('a marked decision of an earlier friendly match', async ({ page, request }) => {
        const errors = watchErrors(page);
        await request.post('/__e2e/reset');
        await page.goto('/friend.html');
        await page.locator('#historyBtn').click();
        await page.getByRole('button', { name: 'Karl: 24/23 13/8' }).click();
        await expect(page.locator('#markedTitle')).toHaveText('Karl: 24/23 13/8');
        await page.locator('#analyseBtn').click();
        await expect(results(page)).toHaveCount(1);
        await expect(results(page).first()).toContainText('◀ Karl');
        await page.locator('#historyCloseBtn').click();
        await expect(page.locator('#analysisPanel')).toBeHidden();
        expect(errors).toEqual([]);
    });
});

for (const [sizeName, size] of Object.entries(SIZES)) {
    test.describe(`on a ${sizeName}`, () => {
        test.use(size);

        test('the tables fit the panel', async ({ page, request }, testInfo) => {
            const data = await fixtures(request);
            await page.goto(`/review.html?id=${data.matchId}`);
            await page.locator('#analyseBtn').click();
            await expect(results(page)).toHaveCount(1);
            await page.locator('#rolloutBtn').click();
            await expect(results(page)).toHaveCount(2);
            await page.locator('#analysisResults').scrollIntoViewIfNeeded();
            const screens = path.join('test-results', 'screens', testInfo.project.name);
            await page.screenshot({ path: path.join(screens, `analysis-${sizeName.replace(' ', '-')}.png`) });
            const overflow = await page.locator('#analysisResults .analysis-result').evaluateAll((sections) => sections
                .map((section) => section.scrollWidth - section.clientWidth));
            expect(Math.max(...overflow)).toBeLessThanOrEqual(0);
        });
    });
}
