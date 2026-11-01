(function exposeEngineBudget(root, factory) {
    const engineBudget = factory();
    if (typeof module === 'object' && module.exports) module.exports = engineBudget;
    else root.engineBudget = engineBudget;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createEngineBudget() {
    'use strict';

    // What the engine in a browser can do in reasonable time. The page times
    // one standard position (SPEED_CHECK) and reports it as its speed
    // { benchMs, threads }; the costs below, measured on stored quiz positions,
    // turn that into an estimate for every request. From the estimates:
    //   - analyses (quiz panel, match review, friend history) up to about a
    //     minute, rollouts (started on purpose) up to about three: deeper
    //     depths and slower rollout modes are not offered;
    //   - play against the engine about 5 s per engine turn, which takes up to
    //     four requests (rating the player's cube and play, the engine's cube
    //     and play): slower levels are not offered;
    //   - friend matches rate decisions at a shallower depth on a slow device.
    // A request that overruns its estimate by far is stopped (jobBudgetMs).
    // With "maximum performance", chosen on the device (speed.max), the page
    // uses all its cores and analyses and rollouts may take far longer.

    const ANALYSIS_MS = 60000;
    const ROLLOUT_MS = 180000;
    const MAX = { analysisMs: 300000, rolloutMs: 900000, searchStopMs: 600000, rolloutStopMs: 1800000 };
    const NORMAL = { analysisMs: ANALYSIS_MS, rolloutMs: ROLLOUT_MS, searchStopMs: 120000, rolloutStopMs: 240000 };
    const TURN_MS = 5000;

    // The standard position: a middle game with contact, at 3-ply.
    const SPEED_CHECK = {
        position: { points: [0, -1, 0, 0, 2, 0, 3, 0, 3, 0, -1, 1, -4, 4, 0, 0, 0, -4, 0, -5, 0, 0, 1, 0, 1, 0] },
        match: { length: 11, score: [0, 0], cube: 1, owner: 'center', crawford: false },
        dice: [6, 1],
        options: { plies: 3, max_moves: 10 }
    };

    // Cost of a request in units of the speed check, at the 90th percentile of
    // the measured positions (so most requests finish within the estimate), by
    // depth (index 1 to 7). "move": a checker analysis listing plays;
    // "engineMove": the engine choosing (or rating) one play; "cube": a cube
    // decision. "rollout": one position by mode (1,296 trials; with variance
    // reduction; 5,184 trials with it). Measured in Chrome, each request in a
    // fresh engine, on 30 checker and 12 cube positions of stored quizzes
    // (fewer at 5- and 6-ply); 7-ply is extrapolated from 5- and 6-ply. With
    // more threads the deep searches gain more than the speed check does.
    const COSTS = {
        multi: {
            move: [0, 0.01, 0.11, 1.46, 18.2, 111, 642, 3850],
            engineMove: [0, 0.01, 0.10, 1.31, 14.6, 129, 446, 2230],
            cube: [0, 0.01, 0.04, 0.16, 3.49, 31.1, 149, 745],
            rollout: { quick: 10.5, precise: 288, deep: 2810 }
        },
        // Fewer positions; beyond 5-ply (4-ply for engineMove, and the deep
        // rollout) scaled from the multi-threaded costs.
        single: {
            move: [0, 0.01, 0.11, 1.58, 18.7, 160, 925, 5540],
            engineMove: [0, 0.01, 0.27, 1.70, 15.4, 168, 580, 2900],
            cube: [0, 0.005, 0.01, 0.25, 3.14, 39.2, 188, 940],
            rollout: { quick: 12.0, precise: 314, deep: 3090 }
        }
    };
    const MAX_PLIES = 7;
    const ROLLOUT_MODES = {
        quick: { trials: 1296 },
        precise: { trials: 1296, variance_reduction: true },
        deep: { trials: 5184, variance_reduction: true }
    };
    // Plays a move rollout covers (the review's top 5, a quiz's answers) and
    // the rollouts of a cube rollout (no double, double/take).
    const ROLLOUT_PLAYS = 5;
    const CUBE_ROLLOUTS = 2;

    function valid(speed) {
        return Boolean(speed) && Number.isFinite(speed.benchMs) && speed.benchMs > 0;
    }

    function budgets(speed) {
        return speed && speed.max ? MAX : NORMAL;
    }

    function costs(speed) {
        return Number(speed.threads) > 1 ? COSTS.multi : COSTS.single;
    }

    /** Estimated milliseconds of one search of `kind` ('move', 'engineMove', 'cube') at `plies`. */
    function searchMs(speed, kind, plies) {
        const table = costs(speed)[kind];
        return speed.benchMs * table[Math.min(Math.max(1, plies), MAX_PLIES)];
    }

    /** Estimated milliseconds of rolling out one position with `options` ({ trials, variance_reduction }). */
    function rolloutMs(speed, options = ROLLOUT_MODES.quick) {
        const { rollout } = costs(speed);
        const trials = Number(options.trials) || 1296;
        if (!options.variance_reduction) return speed.benchMs * rollout.quick * (trials / 1296);
        return speed.benchMs * (trials <= 1296 ? rollout.precise * (trials / 1296) : rollout.deep * (trials / 5184));
    }

    /** Estimated milliseconds of a rollout mode for the analysis views: five plays, or a cube decision. */
    function rolloutModeMs(speed, mode, cube = false) {
        return rolloutMs(speed, ROLLOUT_MODES[mode]) * (cube ? CUBE_ROLLOUTS : ROLLOUT_PLAYS);
    }

    /** Estimated milliseconds of an engine request (path and body as sent to the engine). */
    function requestMs(speed, path, body = {}) {
        const options = body.options || {};
        if (path === '/v1/rollout') {
            const positions = body.dice ? Math.max(1, Number(options.candidates) || 4) : 1;
            return rolloutMs(speed, options) * positions;
        }
        const plies = Number(options.plies) || 1;
        if (path === '/v1/cube') return searchMs(speed, 'cube', plies);
        if (path === '/v1/analyze') return searchMs(speed, 'cube', plies) + searchMs(speed, 'move', plies);
        if (path === '/v1/move') {
            const listing = (Number(options.max_moves) || 20) > 1;
            return searchMs(speed, listing ? 'move' : 'engineMove', plies);
        }
        return searchMs(speed, 'engineMove', 1);
    }

    /**
     * How long a page lets a request run before it stops the engine: well
     * past its estimate, so only a position far harder than usual is stopped,
     * but never longer than two minutes (four for a rollout; ten and thirty
     * with maximum performance).
     */
    function jobBudgetMs(speed, path, body) {
        const { searchStopMs, rolloutStopMs } = budgets(speed);
        const maxMs = path === '/v1/rollout' ? rolloutStopMs : searchStopMs;
        if (!valid(speed)) return maxMs;
        return Math.round(Math.min(maxMs, Math.max(20000, 3 * requestMs(speed, path, body))));
    }

    /** One engine turn in play at `plies`: both cube decisions and both plays. */
    function turnMs(speed, plies) {
        return 2 * searchMs(speed, 'cube', plies) + 2 * searchMs(speed, 'engineMove', plies);
    }

    /**
     * What a browser with this speed may do: analysis depths, rollout modes
     * for plays and for cube decisions (with their estimates), play levels,
     * and the depth for rating friend matches. Null without a valid speed.
     */
    function limits(speed, { maxPlies = MAX_PLIES, levels = [1, 2, 3, 4], ratingPlies = 3 } = {}) {
        if (!valid(speed)) return null;
        const { analysisMs, rolloutMs: rolloutLimitMs } = budgets(speed);
        const estimates = {};
        let analysisPlies = 1;
        for (let plies = 1; plies <= maxPlies; plies++) {
            const ms = Math.max(searchMs(speed, 'move', plies), searchMs(speed, 'cube', plies));
            estimates[plies] = Math.round(ms);
            if (ms <= analysisMs) analysisPlies = plies;
        }
        const rollouts = {};
        const cubeRollouts = {};
        for (const mode of Object.keys(ROLLOUT_MODES)) {
            rollouts[mode] = Math.round(rolloutModeMs(speed, mode));
            cubeRollouts[mode] = Math.round(rolloutModeMs(speed, mode, true));
        }
        const fitting = (estimates) => Object.keys(estimates).filter((mode) => estimates[mode] <= rolloutLimitMs);
        const fastLevels = levels.filter((plies) => plies === 1 || turnMs(speed, plies) <= TURN_MS);
        let rating = 1;
        for (let plies = 1; plies <= ratingPlies; plies++) {
            if (searchMs(speed, 'cube', plies) + searchMs(speed, 'move', plies) <= TURN_MS) rating = plies;
        }
        return {
            maxPlies: analysisPlies,
            estimates,
            rollouts: fitting(rollouts),
            rolloutEstimates: rollouts,
            cubeRollouts: fitting(cubeRollouts),
            cubeRolloutEstimates: cubeRollouts,
            levels: fastLevels,
            ratingPlies: rating
        };
    }

    /**
     * "up to 45 s", "up to 2 min" for an estimate worth mentioning (from 3 s),
     * else ''. Estimates are near the worst case: most requests take less.
     */
    function label(ms) {
        if (!(ms >= 3000)) return '';
        if (ms < 90000) return `up to ${Math.ceil(ms / 5000) * 5} s`;
        return `up to ${Math.ceil(ms / 60000)} min`;
    }

    return {
        ANALYSIS_MS, ROLLOUT_MS, MAX, TURN_MS, SPEED_CHECK, ROLLOUT_MODES,
        jobBudgetMs, label, limits, requestMs, rolloutModeMs, searchMs, turnMs, valid
    };
}));
