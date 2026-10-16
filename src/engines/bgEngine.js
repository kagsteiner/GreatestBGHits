'use strict';

// HTTP client for the DarkBGHelmet engine (pm2 app `bgengine`), which listens
// on a VPS-local port only. See CLIENT_GUIDE.md for the API.

const BackgammonBoard = require('../board');
const { moveNotationToParts } = require('./moveUtils');

const ENGINE_ID = 'darkbghelmet';

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getConfig(overrides = {}) {
    const plies = positiveInteger(overrides.plies ?? process.env.BG_ENGINE_PLIES, 3);
    const deepPlies = positiveInteger(overrides.deepPlies ?? process.env.BG_ENGINE_DEEP_PLIES, 5);
    for (const [label, value] of [['BG_ENGINE_PLIES', plies], ['BG_ENGINE_DEEP_PLIES', deepPlies]]) {
        if (value > 7) throw new Error(`${label} must be between 1 and 7`);
    }
    return {
        url: String(overrides.url || process.env.BG_ENGINE_URL || 'http://127.0.0.1:3050').replace(/\/+$/, ''),
        plies,
        deepPlies,
        timeoutMs: positiveInteger(overrides.timeoutMs ?? process.env.BG_ENGINE_TIMEOUT_MS, 60000),
        deepTimeoutMs: positiveInteger(overrides.deepTimeoutMs ?? process.env.BG_ENGINE_DEEP_TIMEOUT_MS, 300000),
        maxPending: positiveInteger(overrides.maxPending ?? process.env.BG_ENGINE_MAX_PENDING, 8),
        retryDelayMs: Number.isFinite(overrides.retryDelayMs) ? overrides.retryDelayMs : 2000
    };
}

class EngineRequestError extends Error {
    constructor(path, status, message) {
        super(`Engine ${path} rejected the request: ${message}`);
        this.name = 'EngineRequestError';
        this.status = status;
        this.engineMessage = message;
    }
}

class PlayedMoveNotLegalError extends Error {
    constructor(move, message) {
        super(`The engine did not accept played move '${move}': ${message}`);
        this.name = 'PlayedMoveNotLegalError';
        this.code = 'QUIZ_MOVE_NOT_RECOGNIZED';
    }
}

/**
 * Convert a stored OGID into the engine's `points` array and `match` object,
 * both seen from the player on roll.
 */
function toEnginePosition(ogid, onRoll = null) {
    const board = BackgammonBoard.fromOgid(ogid);
    const me = onRoll === 'player1' || onRoll === 'player2' ? onRoll : board.turn;
    const opp = me === 'player1' ? 'player2' : 'player1';
    const mine = board.points[me];
    const theirs = board.points[opp];

    const points = new Array(26).fill(0);
    for (let point = 1; point <= 24; point++) {
        // Both sides store points from their own view: my point n is the
        // opponent's point 25 - n.
        points[point] = (mine[point] || 0) - (theirs[25 - point] || 0);
    }
    points[25] = mine[25] || 0;
    points[0] = theirs[25] || 0;

    const length = Number.isFinite(board.matchLength) ? board.matchLength : 0;
    const cube = Math.max(1, Number(board.cube) || 1);
    let owner = 'center';
    if (cube > 1 && board.cubeOwner) owner = board.cubeOwner === me ? 'onroll' : 'opponent';
    const match = {
        length,
        score: [Number(board.score[me]) || 0, Number(board.score[opp]) || 0],
        cube,
        owner,
        crawford: length > 0 && board.ogidMetadata?.crawford === true
    };
    if (length === 0) {
        // DailyGammon money sessions use neither the Jacoby rule nor beavers.
        match.jacoby = false;
        match.beavers = false;
    }
    return { board, onRoll: me, position: { points }, match };
}

/** Translate the app's move notation (25 = bar, 0 = off) into engine notation. */
function toEngineMove(moveText) {
    return moveNotationToParts(moveText)
        .map((part) => {
            const from = part.from === 25 ? 'bar' : String(part.from);
            const to = part.to === 0 ? 'off' : String(part.to);
            return `${from}/${to}${part.hit ? '*' : ''}`;
        })
        .join(' ');
}

/**
 * Convert an engine `position_after` XGID (seen from the opponent, who is on
 * roll next) back into the `points` format seen from the player who moved:
 * points[1..24] are signed (own checkers positive), points[25] is the own bar
 * and points[0] the opponent's bar.
 */
function afterXgidToPoints(xgid) {
    const field = String(xgid || '').replace(/^XGID=/, '').split(':')[0];
    if (!/^[-a-oA-O]{26}$/.test(field)) throw new Error(`Invalid XGID position '${xgid}'`);
    const count = (character) => (character === '-' ? 0 : (character.toLowerCase().charCodeAt(0) - 96));
    const points = new Array(26).fill(0);
    for (let index = 1; index <= 24; index++) {
        const character = field[index];
        if (character === '-') continue;
        // Lowercase is the player who moved; their point p is index 25 - p.
        const isMover = character === character.toLowerCase();
        points[25 - index] = isMover ? count(character) : -count(character);
    }
    points[25] = count(field[0]);
    points[0] = count(field[25]);
    return points;
}

function toEvaluation(probabilities) {
    if (!probabilities) return null;
    return {
        win: probabilities.win,
        gammonWin: probabilities.win_gammon,
        backgammonWin: probabilities.win_backgammon,
        gammonLoss: probabilities.lose_gammon,
        backgammonLoss: probabilities.lose_backgammon
    };
}

function isConnectionError(error) {
    const code = error?.cause?.code || error?.code;
    return ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(code);
}

class BgEngineClient {
    constructor(config = {}) {
        this.config = getConfig(config);
        this.queue = Promise.resolve();
        this.pending = 0;
        this.info = null;
        this.lastError = null;
    }

    /**
     * Run requests one at a time: the engine processes them sequentially
     * anyway, and queueing here keeps timeouts from covering waiting time.
     */
    enqueue(task) {
        if (this.pending >= this.config.maxPending) {
            return Promise.reject(new Error(`Engine queue is full (${this.config.maxPending} pending requests)`));
        }
        this.pending += 1;
        const run = this.queue.then(task, task);
        this.queue = run.catch(() => {});
        return run.finally(() => { this.pending -= 1; });
    }

    async fetchJson(path, body, timeoutMs) {
        const options = body === undefined
            ? { method: 'GET' }
            : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
        let response;
        for (let attempt = 0; ; attempt++) {
            try {
                response = await fetch(this.config.url + path, {
                    ...options,
                    signal: AbortSignal.timeout(timeoutMs || this.config.timeoutMs)
                });
                break;
            } catch (error) {
                // The engine restarts within seconds after an update; retry once.
                if (attempt === 0 && isConnectionError(error)) {
                    await new Promise((resolve) => setTimeout(resolve, this.config.retryDelayMs));
                    continue;
                }
                const message = error?.name === 'TimeoutError'
                    ? `Engine ${path} timed out after ${timeoutMs || this.config.timeoutMs}ms`
                    : `Engine at ${this.config.url} is unreachable: ${error?.cause?.code || error.message}`;
                this.lastError = message;
                throw new Error(message);
            }
        }
        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
            const message = json?.error || `HTTP ${response.status}`;
            if (response.status >= 500) this.lastError = message;
            throw new EngineRequestError(path, response.status, message);
        }
        this.lastError = null;
        return json;
    }

    request(path, body, timeoutMs) {
        return this.enqueue(() => this.fetchJson(path, body, timeoutMs));
    }

    async getInfo() {
        if (!this.info) {
            const info = await this.request('/v1/info');
            this.info = { name: info.name || null, version: info.version || null, network: info.network || null };
        }
        return this.info;
    }

    timeoutFor(plies) {
        return plies > this.config.plies ? this.config.deepTimeoutMs : this.config.timeoutMs;
    }

    /**
     * Rank the checker plays for a position and, optionally, judge the play
     * actually made. The played move is always searched at full depth.
     *
     * @param {{ ogid: string, dice?: {die1:number,die2:number}, played?: string, plies?: number, maxMoves?: number }} params
     */
    async analyzeChecker(params) {
        const ogid = params?.ogid;
        if (typeof ogid !== 'string' || !ogid) throw new TypeError('Checker analysis requires an OGID');
        const { position, match, board } = toEnginePosition(ogid);
        const dice = params.dice || board.dice;
        const d1 = Number(dice?.die1);
        const d2 = Number(dice?.die2);
        if (![d1, d2].every((die) => Number.isInteger(die) && die >= 1 && die <= 6)) {
            throw new Error('Checker analysis requires two dice in the range 1..6');
        }
        const plies = positiveInteger(params.plies, this.config.plies);
        const played = typeof params.played === 'string' && params.played.trim()
            ? toEngineMove(params.played)
            : null;
        const body = {
            position,
            match,
            dice: [d1, d2],
            options: { plies, max_moves: positiveInteger(params.maxMoves, 20) }
        };
        if (played) body.played = played;

        const metadata = await this.getInfo();
        let raw;
        try {
            raw = await this.request('/v1/move', body, this.timeoutFor(plies));
        } catch (error) {
            if (played && error instanceof EngineRequestError && error.status === 400
                && /played/i.test(error.engineMessage)) {
                throw new PlayedMoveNotLegalError(params.played, error.engineMessage);
            }
            throw error;
        }

        const moves = (Array.isArray(raw.moves) ? raw.moves : []).map((move) => ({
            move: move.move === '(no move)' ? '' : move.move,
            equity: move.equity,
            diff: move.diff,
            mwc: move.mwc ?? null,
            ply: move.plies ?? null,
            evaluation: toEvaluation(move.probabilities)
        }));
        let playedResult = null;
        if (raw.played) {
            const listed = moves.find((move) => move.move === raw.played.move);
            playedResult = {
                move: raw.played.move === '(no move)' ? '' : raw.played.move,
                rank: raw.played.rank,
                equity: raw.played.equity,
                diff: raw.played.diff,
                mwc: raw.played.mwc ?? null,
                mwcDiff: raw.played.mwc_diff ?? null,
                ply: raw.played.plies ?? null,
                isBest: raw.played.is_best === true,
                evaluation: listed?.ply === raw.played.plies ? listed.evaluation : null
            };
        }
        return {
            engine: ENGINE_ID,
            ogid,
            plies: raw.plies ?? plies,
            legalMoves: raw.legal_moves ?? moves.length,
            moves,
            played: playedResult,
            durationMs: raw.time_ms ?? null,
            engineMetadata: { ...metadata, plies: raw.plies ?? plies }
        };
    }

    /**
     * Every legal play for the dice with the position it leads to, from the
     * view of the player on roll. Ranked at 1-ply only: the list is used to
     * check checker moves made on the board, not to judge them.
     *
     * @param {{ ogid: string, dice?: {die1:number,die2:number} }} params
     * @returns {Promise<{ position: number[], dice: number[], plays: Array<{ move: string, points: number[] }> }>}
     */
    async listLegalPlays(params) {
        const ogid = params?.ogid;
        if (typeof ogid !== 'string' || !ogid) throw new TypeError('Legal plays require an OGID');
        const { position, match, board } = toEnginePosition(ogid);
        const dice = params.dice || board.dice;
        const d1 = Number(dice?.die1);
        const d2 = Number(dice?.die2);
        if (![d1, d2].every((die) => Number.isInteger(die) && die >= 1 && die <= 6)) {
            throw new Error('Legal plays require two dice in the range 1..6');
        }
        const raw = await this.request('/v1/move', {
            position,
            match,
            dice: [d1, d2],
            // The engine has no limit on the list; doubles can have hundreds of plays.
            options: { plies: 1, max_moves: 100000 }
        });
        const moves = Array.isArray(raw.moves) ? raw.moves : [];
        return {
            position: position.points,
            dice: [d1, d2],
            plays: moves.map((move) => ({
                move: move.move === '(no move)' ? '' : move.move,
                points: afterXgidToPoints(move.position_after?.xgid)
            }))
        };
    }

    /**
     * Cube decision of the player on roll, before rolling. Equities are from
     * the doubler's view and money-equivalent in match play.
     *
     * @param {{ ogid: string, player?: 'player1'|'player2', plies?: number }} params
     */
    async analyzeCube(params) {
        const ogid = params?.ogid;
        if (typeof ogid !== 'string' || !ogid) throw new TypeError('Cube analysis requires an OGID');
        const { position, match } = toEnginePosition(ogid, params.player);
        const plies = positiveInteger(params.plies, this.config.plies);
        const metadata = await this.getInfo();
        const raw = await this.request('/v1/cube', {
            position,
            match,
            options: { plies, cube_plies: plies }
        }, this.timeoutFor(plies));
        return {
            engine: ENGINE_ID,
            ogid,
            available: raw.cube_available !== false,
            decision: raw.decision || null,
            take: raw.take || null,
            noDoubleEquity: raw.equity?.no_double,
            doubleTakeEquity: raw.equity?.double_take,
            doublePassEquity: raw.equity?.double_pass,
            mwc: raw.mwc ? {
                noDouble: raw.mwc.no_double,
                doubleTake: raw.mwc.double_take,
                doublePass: raw.mwc.double_pass
            } : null,
            evaluation: toEvaluation(raw.probabilities),
            cubeEfficiency: raw.cube_efficiency ?? null,
            plies: raw.plies ?? plies,
            durationMs: raw.time_ms ?? null,
            engineMetadata: { ...metadata, plies: raw.plies ?? plies }
        };
    }

    getStatus() {
        return {
            engine: ENGINE_ID,
            url: this.config.url,
            pending: this.pending,
            info: this.info,
            lastError: this.lastError,
            plies: this.config.plies,
            deepPlies: this.config.deepPlies,
            timeoutMs: this.config.timeoutMs,
            deepTimeoutMs: this.config.deepTimeoutMs,
            maxPending: this.config.maxPending
        };
    }
}

let sharedClient = null;

function getClient() {
    if (!sharedClient) sharedClient = new BgEngineClient();
    return sharedClient;
}

module.exports = {
    ENGINE_ID,
    BgEngineClient,
    EngineRequestError,
    PlayedMoveNotLegalError,
    afterXgidToPoints,
    getClient,
    getConfig,
    toEngineMove,
    toEnginePosition
};
