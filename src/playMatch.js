'use strict';

// Matches against the DarkBGHelmet engine. The human is player1 and the
// engine player2. The server rolls the dice, plays the engine's moves and cube
// decisions, and grades the human's decisions at the same depth. Matches live
// in memory only: a server restart ends them.

const crypto = require('crypto');
const { getBridges } = require('./engineBridge');
const checkerPlay = require('../shared/checkerPlay');
const { withoutOpenDouble } = require('./matchReview');
const {
    DEFAULT_LEVEL, MatchCore, MatchError, countDecision, cubeErrors, grade, performanceRating, setPosition
} = require('./matchCore');

const HUMAN = 'player1';
const ENGINE = 'player2';
const MATCH_LENGTHS = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 25];
// Engine levels are search depths. The human's decisions are graded at the
// same depth, so a deep level keeps the shared engine busy for every turn:
// 4-ply is the most a small server should offer. PLAY_MAX_PLIES raises the
// limit (up to 6-ply, which can take a minute per turn) for a fast machine.
// Slow actions run in the background and the page polls for progress.
const DEFAULT_MAX_LEVEL = 4;
const HIGHEST_LEVEL = 6;

/** The levels offered, 1-ply up to PLAY_MAX_PLIES (default 4, at most 6). */
function playLevels(maxPlies = process.env.PLAY_MAX_PLIES) {
    const parsed = Number.parseInt(maxPlies, 10);
    const max = Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, HIGHEST_LEVEL) : DEFAULT_MAX_LEVEL;
    return Array.from({ length: max }, (_, index) => index + 1);
}

function defaultLevel(levels) {
    return Math.min(DEFAULT_LEVEL, levels[levels.length - 1]);
}
const IDLE_LIMIT_MS = 24 * 60 * 60 * 1000;

class PlayMatches extends MatchCore {
    /** @param {{ maxPlies?: number, store?: { saveMatch(record: object): void } }} [options] the store saves the matches of logged-in players */
    constructor(options = {}) {
        super(options);
        this.maxPlies = options.maxPlies ?? null;
        this.matches = new Map();
    }

    /**
     * The levels offered; for a page with its engine ready, those its browser
     * plays in about 5 s per engine turn (shared/engineBudget.js).
     */
    get levels() {
        const all = playLevels(this.maxPlies ?? undefined);
        const own = getBridges().currentLimits({ levels: all });
        return own ? own.levels : all;
    }

    get defaultLevel() {
        return defaultLevel(this.levels);
    }

    purgeIdle(now = Date.now()) {
        for (const [key, match] of this.matches) {
            if (now - match.updatedAt > IDLE_LIMIT_MS && !match.busy) {
                this.abandon(match);
                this.matches.delete(key);
            }
        }
    }

    /** Mark an unfinished match as abandoned in the history. */
    abandon(match) {
        if (match.phase !== 'match-over') this.persist(match, 'abandoned');
    }

    /**
     * Move a match to another key, e.g. from a browser's anonymous id to the
     * account that just logged in there, which from now on owns it.
     */
    adopt(fromKey, toKey, owner) {
        const match = this.matches.get(fromKey);
        if (!match || this.matches.has(toKey)) return false;
        this.matches.delete(fromKey);
        match.owner = owner;
        this.matches.set(toKey, match);
        this.persist(match);
        return true;
    }

    /** The stored form of a match (see playStore.saveMatch). */
    record(match, status) {
        return {
            id: match.id,
            userId: match.owner.id,
            startedAt: match.startedAt,
            finishedAt: status === 'finished' ? new Date().toISOString() : null,
            status,
            length: match.length,
            plies: match.plies,
            score: this.scoreBySide(match),
            games: match.games,
            stats: { ...match.stats, pr: performanceRating(match.stats) },
            opponent: 'DarkBGHelmet'
        };
    }

    persist(match, status = match.phase === 'match-over' ? 'finished' : 'in-progress') {
        if (!this.store || !match.owner) return;
        try {
            this.store.saveMatch(this.record(match, status));
        } catch (error) {
            // Playing goes on even if the history cannot be written.
            // eslint-disable-next-line no-console
            console.error(`Could not save match ${match.id}: ${error.message}`);
        }
    }

    state(userKey) {
        this.purgeIdle();
        const match = this.matches.get(userKey);
        return match ? this.snapshot(match) : null;
    }

    /** The player's match as it stands, for reviewing the decisions made so far; null without one. */
    runningReview(userKey) {
        this.purgeIdle();
        const match = this.matches.get(userKey);
        if (!match) return null;
        return {
            id: match.id,
            startedAt: match.startedAt,
            status: match.phase === 'match-over' ? 'finished' : 'running',
            length: match.length,
            plies: match.plies,
            score: this.scoreBySide(match),
            pr: performanceRating(match.stats)?.value ?? null,
            games: match.phase === 'respond' ? withoutOpenDouble(match.games) : match.games
        };
    }

    /**
     * @param {{ id: number, name: string }|null} [owner] the logged-in player whose history records the match
     */
    async start(userKey, length, plies = this.defaultLevel, owner = null) {
        if (!MATCH_LENGTHS.includes(length)) throw new MatchError(`Match length must be one of ${MATCH_LENGTHS.join(', ')}`);
        const levels = this.levels;
        if (!levels.includes(plies)) throw new MatchError(`Engine level must be one of ${levels.join(', ')} plies`);
        const existing = this.matches.get(userKey);
        if (existing?.busy) throw new MatchError('The previous match is still busy', 409);
        if (existing) this.abandon(existing);
        const match = {
            id: crypto.randomUUID(),
            owner,
            startedAt: new Date().toISOString(),
            games: [],
            length,
            plies,
            score: { [HUMAN]: 0, [ENGINE]: 0 },
            crawford: false,
            crawfordDone: false,
            nextCrawford: false,
            gameNumber: 0,
            board: null,
            phase: 'starting',
            legal: null,
            turnCube: null,
            offer: null,
            result: null,
            feedback: [],
            stats: { decisions: 0, rated: 0, totalLoss: 0, flagged: 0, equityLost: 0 },
            busy: false,
            actionId: 0,
            events: [],
            error: null,
            updatedAt: Date.now()
        };
        this.matches.set(userKey, match);
        await this.run(match, (events) => this.newGame(match, events));
        return this.snapshot(match);
    }

    /**
     * Apply a human action: roll, double, take, pass, move (with `key`, the
     * final position of the play) or next-game.
     */
    async act(userKey, action) {
        const match = this.matches.get(userKey);
        if (!match) throw new MatchError('No match in progress', 404);
        await this.perform(match, HUMAN, action);
        return this.snapshot(match);
    }

    /** Record a graded decision of the human. */
    recordDecision(match, _seat, item) {
        countDecision(match.stats, item);
        const game = this.currentGame(match);
        // An id per decision, so the player can mark it for the review.
        if (game) item.id = `${game.number}:${game.log.length}`;
        match.feedback.push(item);
        game?.log.push({ type: 'grade', ...item });
        return item;
    }

    /** Mark (or unmark) a graded decision of the current match for the review. */
    mark(userKey, decisionId, marked) {
        const match = this.matches.get(userKey);
        if (!match) throw new MatchError('No match in progress', 404);
        const entry = match.games.flatMap((game) => game.log)
            .find((logged) => logged.type === 'grade' && logged.id === decisionId);
        if (!entry) throw new MatchError('That decision is not part of the current match', 404);
        entry.marked = Boolean(marked);
        this.persist(match);
        return { id: decisionId, marked: entry.marked };
    }

    /** An event for the page, also kept in the game's log for the history. */
    emit(match, events, event) {
        events.push(event);
        this.currentGame(match)?.log.push(event);
    }

    side(seat) {
        return seat === HUMAN ? 'you' : 'engine';
    }

    scoreBySide(match) {
        return { you: match.score[HUMAN], engine: match.score[ENGINE] };
    }

    actionStarting(match) {
        match.actionId += 1;
        match.feedback = [];
        match.events = [];
    }

    actionFailed(match) {
        match.feedback = [];
    }

    actionFinished(match, failure) {
        match.updatedAt = Date.now();
        if (!failure) this.persist(match);
    }

    openingEvent(you, engine) {
        return { type: 'opening', you, engine };
    }

    /** The opening roll has no event of its own here. */
    async rollDetails(_match, _seat, _dice, opening) {
        return opening ? null : {};
    }

    /** The engine's turn: it may double; a double of the human's turn stays with the core. */
    async startTurn(match, seat, events) {
        if (seat === HUMAN) return super.startTurn(match, seat, events);
        const { board } = match;
        board.turn = ENGINE;
        board.dice = null;
        if (this.canDouble(match, ENGINE)) {
            const cube = await this.engine.analyzeCube({ ogid: this.ogid(match), player: ENGINE, plies: match.plies });
            if (cube.available && /^(re)?double/i.test(cube.decision || '')) {
                match.offer = { by: ENGINE, to: HUMAN, analysis: cube, ogid: this.ogid(match) };
                match.phase = 'respond';
                this.emit(match, events, { type: 'double', who: 'engine', cube: board.cube * 2 });
                return undefined;
            }
        }
        return this.rollFor(match, ENGINE, events);
    }

    async startMove(match, seat, dice, events) {
        if (seat === HUMAN) return super.startMove(match, seat, dice, events);
        const { board } = match;
        const result = await this.engine.analyzeChecker({ ogid: this.ogid(match), plies: match.plies, maxMoves: 1 });
        const best = result.moves[0];
        let points = best?.points;
        if (!points) {
            points = checkerPlay.applyMoveText(checkerPlay.positionFromBoard(board, ENGINE), best?.move || '');
            if (!points) throw new Error(`Could not apply the engine's move '${best?.move}'`);
        }
        setPosition(board, ENGINE, points);
        this.emit(match, events, { type: 'move', who: 'engine', move: best?.move || '', dice, ogid: this.ogid(match) });
        return this.moved(match, ENGINE, events);
    }

    /** The engine answers a double of the human at once. */
    async doubles(match, seat, events) {
        const cube = match.turnCube;
        const { board } = match;
        const loss = cubeErrors(cube).ifDoubled;
        this.recordDecision(match, seat, { kind: 'cube', action: 'Double', loss, grade: grade(loss), best: cube.decision });
        match.turnCube = null;
        this.emit(match, events, { type: 'double', who: 'you', cube: board.cube * 2 });
        if (cube.take === 'pass') {
            this.emit(match, events, { type: 'pass', who: 'engine' });
            this.endGame(match, HUMAN, board.cube, 'pass', events);
            return;
        }
        this.emit(match, events, { type: 'take', who: 'engine' });
        board.cube *= 2;
        board.cubeOwner = ENGINE;
        await this.rollFor(match, HUMAN, events);
    }

    snapshot(match) {
        const { board } = match;
        return {
            actionId: match.actionId,
            busy: match.busy,
            error: match.error,
            length: match.length,
            score: this.scoreBySide(match),
            crawford: match.crawford,
            nextCrawford: match.phase === 'game-over' ? match.nextCrawford : false,
            gameNumber: match.gameNumber,
            phase: match.busy ? 'thinking' : match.phase,
            ogid: board ? this.ogid(match) : null,
            cube: board?.cube ?? 1,
            cubeOwner: board?.cubeOwner === HUMAN ? 'you' : (board?.cubeOwner === ENGINE ? 'engine' : null),
            offeredCube: match.phase === 'respond' ? board.cube * 2 : null,
            legal: !match.busy && match.phase === 'move' && match.legal ? this.legalForPage(match) : null,
            result: match.result,
            feedback: match.feedback,
            stats: {
                decisions: match.stats.decisions,
                rated: match.stats.rated,
                flagged: match.stats.flagged,
                equityLost: Math.round(match.stats.equityLost * 1000) / 1000,
                totalLoss: Math.round(match.stats.totalLoss * 1000) / 1000,
                pr: performanceRating(match.stats)
            },
            plies: match.plies,
            events: match.events.slice()
        };
    }
}

let shared = null;

function getPlayMatches() {
    // Requests answer after 4 s at most; slow levels continue in the background
    // and the page polls for progress.
    if (!shared) shared = new PlayMatches({ waitMs: 4000 });
    return shared;
}

module.exports = {
    HUMAN,
    ENGINE,
    MATCH_LENGTHS,
    PlayMatches,
    getPlayMatches,
    playLevels
};
