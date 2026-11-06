'use strict';

const { expect } = require('@playwright/test');

const SIZES = {
    'small phone': { viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true },
    'phone portrait': { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    'phone landscape': { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true },
    'tablet portrait': { viewport: { width: 820, height: 1180 }, hasTouch: true },
    'tablet landscape': { viewport: { width: 1180, height: 820 }, hasTouch: true },
    desktop: { viewport: { width: 1440, height: 900 } }
};

async function fixtures(request) {
    return (await request.get('/__e2e/fixtures')).json();
}

/** Be logged in to everything in this browser, under `name` at the friend table. */
async function logIn(context, data, name = 'Karl') {
    await context.addInitScript(([info, player]) => {
        localStorage.setItem('dgCredentials', JSON.stringify({ username: info.quizUser, password: 'not-a-real-password', userId: '1' }));
        localStorage.setItem('bgPlayKey', info.playKey);
        localStorage.setItem('bgPlaySession', info.token);
        localStorage.setItem('bgFriendName', player);
    }, [data, name]);
}

/** Uncaught errors of the page, to check at the end of a test. */
function watchErrors(page) {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    return errors;
}

/** Fred sits down and wants a 3-point match; the browser's player then starts it. */
async function startFriendMatch(page, request, data) {
    const headers = { 'X-Play-Key': data.playKey, 'X-Play-Player': 'e2e-fred-browser' };
    await request.post('/__e2e/reset');
    await page.goto('/friend.html');
    await expect(page.locator('#friendPanel')).toBeVisible();
    await request.post('/friend/join', { headers, data: { name: 'Fred' } });
    await request.post('/friend/length', { headers, data: { length: 3 } });
    await page.getByRole('button', { name: /^3 points/ }).click();
    await expect(page.locator('#playStatus')).toContainText('Your roll');
}

const PAGES = {
    quiz: async (page) => {
        await page.goto('/quiz.html');
        await expect(page.locator('#options .option').first()).toBeVisible();
    },
    play: async (page, request) => {
        await request.post('/__e2e/reset');
        await page.goto('/play.html');
        await expect(page.locator('#playStatus')).toContainText('Start a match');
    },
    friend: async (page, request, data) => {
        await startFriendMatch(page, request, data);
    },
    review: async (page, _request, data) => {
        await page.goto(`/review.html?id=${data.matchId}`);
        await expect(page.locator('#stepTitle')).not.toBeEmpty();
    }
};

/** Everything measured in the page, to compare in the test. */
function measure(page) {
    return page.evaluate(() => {
        const box = (selector) => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
            return { left, top, right, bottom, width, height };
        };
        const widths = [...document.querySelectorAll('#board .point')].map((point) => point.getBoundingClientRect().width);
        const checkers = [...document.querySelectorAll('#board .point .checker')].map((checker) => checker.getBoundingClientRect());
        return {
            view: { width: window.innerWidth, height: window.innerHeight },
            scroll: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
            header: box('.app-header'),
            board: box('#board'),
            area: box('.board-area'),
            panel: box('.panel'),
            handle: box('.split-handle'),
            numbers: box('.point-numbers-top'),
            points: { min: Math.min(...widths), max: Math.max(...widths), count: widths.length },
            checker: checkers.length ? checkers[0].width : 0,
            lowestChecker: Math.max(...checkers.map((checker) => checker.bottom)),
            highestChecker: Math.min(...checkers.map((checker) => checker.top)),
            buttons: [...document.querySelectorAll('.app-header .icon-button')].filter((button) => button.offsetParent).length
        };
    });
}

module.exports = { PAGES, SIZES, fixtures, logIn, measure, startFriendMatch, watchErrors };
