'use strict';

// Matches against the DarkBGHelmet engine. The human is player1 and the
// engine player2. The server rolls the dice, plays the engine's moves and cube
// decisions, and grades the human's decisions at the same depth. Matches live
// in memory only: a server restart ends them.

const crypto = require('crypto');
const BackgammonBoard = require('./board');
const bgEngine = require('./engines/bgEngine');
const checkerPlay = require('../shared/checkerPlay');

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
const DEFAULT_LEVEL = 3;

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

// Performance rating as in eXtreme Gammon: 500 × average equity loss per
// decision. Forced moves are not decisions, and neither are obvious "no
// double" turns, so they do not dilute the rating: a "no double" counts only
// if not doubling was a mistake, or if doubling would have cost less than
// CLOSE_CUBE_LIMIT while the player was at least a MIN_DOUBLER_WIN favourite.
// (Without the second condition, a hopeless position in match play counts:
// redoubling costs little when the match is lost either way.)
const CLOSE_CUBE_LIMIT = 0.2;
const MIN_DOUBLER_WIN = 0.5;

/** Whether a "no double" decision counts for the PR (see above). */
function ratesNoDouble(cube) {
    const errors = cubeErrors(cube);
    return errors.ifNotDoubled > 0
        || (errors.ifDoubled < CLOSE_CUBE_LIMIT && (cube.evaluation?.win ?? 0) >= MIN_DOUBLER_WIN);
}
const PR_SCALE = 500;
const PR_RATINGS = [
    { below: 2.5, label: 'Extraterrestrial' },
    { below: 5, label: 'World class' },
    { below: 7.5, label: 'Expert' },
    { below: 12.5, label: 'Advanced' },
    { below: 17.5, label: 'Intermediate' },
    { below: 22.5, label: 'Casual player' },
    { below: 30, label: 'Beginner' },
    { below: Infinity, label: 'Awful' }
];

function performanceRating(stats) {
    if (!stats.rated) return null;
    const value = (PR_SCALE * stats.totalLoss) / stats.rated;
    return { value: Math.round(value * 10) / 10, label: PR_RATINGS.find((entry) => value < entry.below).label };
}

// Equity loss thresholds (XG / gnubg style, see CLIENT_GUIDE.md §7).
const GRADES = [
    { name: 'blunder', above: 0.08 },
    { name: 'error', above: 0.04 },
    { name: 'doubtful', above: 0.02 }
];

class PlayError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = 'PlayError';
        this.status = status;
    }
}

function isGameOver(match) {
    return match.phase === 'game-over' || match.phase === 'match-over';
}

function opponentOf(player) {
    return player === HUMAN ? ENGINE : HUMAN;
}

function grade(loss) {
    const found = GRADES.find((entry) => loss > entry.above);
    return found ? found.name : null;
}

/** Equity errors of the cube decisions from one /v1/cube result (doubler's view). */
function cubeErrors(cube) {
    const nd = cube.noDoubleEquity;
    const dt = cube.doubleTakeEquity;
    const dp = cube.doublePassEquity;
    const doubled = Math.min(dt, dp);
    const correctDouble = doubled > nd;
    return {
        ifDoubled: correctDouble ? 0 : nd - doubled,
        ifNotDoubled: correctDouble ? doubled - nd : 0,
        ifTaken: dt > dp ? dt - dp : 0,
        ifPassed: dt < dp ? dp - dt : 0
    };
}

/** Replace the mover's and the opponent's checkers with a position seen from the mover. */
function setPosition(board, mover, points) {
    const opp = opponentOf(mover);
    const mine = new Array(26).fill(0);
    const theirs = new Array(26).fill(0);
    for (let point = 1; point <= 24; point++) {
        if (points[point] > 0) mine[point] = points[point];
        else if (points[point] < 0) theirs[25 - point] = -points[point];
    }
    mine[25] = points[25];
    theirs[25] = points[0];
    const onBoard = (side) => side.slice(1).reduce((sum, count) => sum + count, 0);
    mine[0] = 15 - onBoard(mine);
    theirs[0] = 15 - onBoard(theirs);
    board.points[mover] = mine;
    board.points[opp] = theirs;
}

/** Points won by `winner`, who has just borne off the last checker. */
function gameValue(board, winner) {
    const loser = board.points[opponentOf(winner)];
    if (loser[0] > 0) return { multiplier: 1, kind: 'single' };
    // Checkers on the bar or in the winner's home board (the loser's 19..24).
    let backgammon = loser[25] > 0;
    for (let point = 19; point <= 24; point++) if (loser[point] > 0) backgammon = true;
    return backgammon ? { multiplier: 3, kind: 'backgammon' } : { multiplier: 2, kind: 'gammon' };
}

class PlayMatches {
    /**
     * @param {{ engine?: object, randomInt?: (min: number, max: number) => number, waitMs?: number }} [options]
     *   waitMs: how long a request waits for an action before answering with
     *   the progress so far (the action then continues in the background)
     */
    constructor(options = {}) {
        this.engineOverride = options.engine || null;
        this.maxPlies = options.maxPlies ?? null;
        this.randomInt = options.randomInt || crypto.randomInt;
        this.waitMs = options.waitMs ?? Infinity;
        // Saves the matches of logged-in players: { saveMatch(record) }.
        this.store = options.store || null;
        this.matches = new Map();
    }

    get engine() {
        return this.engineOverride || bgEngine.getClient();
    }

    get levels() {
        return playLevels(this.maxPlies ?? undefined);
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
            score: { you: match.score[HUMAN], engine: match.score[ENGINE] },
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

    /**
     * @param {{ id: number, name: string }|null} [owner] the logged-in player whose history records the match
     */
    async start(userKey, length, plies = this.defaultLevel, owner = null) {
        if (!MATCH_LENGTHS.includes(length)) throw new PlayError(`Match length must be one of ${MATCH_LENGTHS.join(', ')}`);
        const levels = this.levels;
        if (!levels.includes(plies)) throw new PlayError(`Engine level must be one of ${levels.join(', ')} plies`);
        const existing = this.matches.get(userKey);
        if (existing?.busy) throw new PlayError('The previous match is still busy', 409);
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
            humanCube: null,
            engineCube: null,
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
        return this.run(match, (events) => this.newGame(match, events));
    }

    /**
     * Apply a human action: roll, double, take, pass, move (with `key`, the
     * final position of the play) or next-game.
     */
    async act(userKey, action) {
        const match = this.matches.get(userKey);
        if (!match) throw new PlayError('No match in progress', 404);
        const type = action?.type;
        const expected = {
            roll: 'human-turn',
            double: 'human-turn',
            take: 'human-respond',
            pass: 'human-respond',
            move: 'human-move',
            'next-game': 'game-over'
        }[type];
        if (!expected) throw new PlayError(`Unknown action '${type}'`);
        if (match.phase !== expected) throw new PlayError(`'${type}' is not possible now`, 409);
        return this.run(match, (events) => {
            switch (type) {
            case 'roll': return this.humanRolls(match, events);
            case 'double': return this.humanDoubles(match, events);
            case 'take': return this.humanTakes(match, events);
            case 'pass': return this.humanPasses(match, events);
            case 'move': return this.humanMoves(match, action.key, events);
            default: return this.nextGame(match, events);
            }
        });
    }

    /**
     * Run an action. Its events are collected on the match, so a request that
     * stops waiting (see waitMs) and later polls of the state see the progress.
     */
    async run(match, step) {
        if (match.busy) throw new PlayError('Still working on the previous action', 409);
        match.busy = true;
        match.actionId += 1;
        match.feedback = [];
        match.events = [];
        match.error = null;
        const events = match.events;
        const restorable = ['phase', 'legal', 'humanCube', 'engineCube', 'result', 'gameNumber',
            'crawford', 'crawfordDone', 'nextCrawford'];
        const before = Object.fromEntries(restorable.map((field) => [field, match[field]]));
        before.board = match.board ? match.board.clone() : null;
        before.score = { ...match.score };
        before.stats = { ...match.stats };
        before.games = structuredClone(match.games);
        let failure = null;
        const job = (async () => {
            try {
                await step(events);
            } catch (error) {
                // Leave the match as it was (e.g. when the engine is unreachable),
                // so the action can be repeated.
                Object.assign(match, before);
                match.feedback = [];
                match.error = error.message;
                failure = error;
            } finally {
                match.busy = false;
                match.updatedAt = Date.now();
            }
            if (!failure) this.persist(match);
        })();
        let timer = null;
        const waited = Number.isFinite(this.waitMs)
            ? new Promise((resolve) => { timer = setTimeout(resolve, this.waitMs); })
            : new Promise(() => {});
        await Promise.race([job, waited]);
        clearTimeout(timer);
        if (failure) throw failure;
        return this.snapshot(match);
    }

    ogid(match) {
        return match.board.toOgid({ crawford: match.crawford });
    }

    roll() {
        return { die1: this.randomInt(1, 7), die2: this.randomInt(1, 7) };
    }

    /** Record a graded human decision; `item.rated` false keeps it out of the PR. */
    recordDecision(match, item) {
        match.stats.decisions += 1;
        if (item.rated !== false) {
            match.stats.rated += 1;
            match.stats.totalLoss += item.loss;
        }
        if (item.grade) {
            match.stats.flagged += 1;
            match.stats.equityLost += item.loss;
        }
        match.feedback.push(item);
        this.currentGame(match)?.log.push({ type: 'grade', ...item });
    }

    currentGame(match) {
        return match.games[match.games.length - 1];
    }

    /** An event for the page, also kept in the game's log for the history. */
    emit(match, events, event) {
        events.push(event);
        this.currentGame(match)?.log.push(event);
    }

    async newGame(match, events) {
        match.gameNumber += 1;
        match.phase = 'playing';
        match.result = null;
        match.legal = null;
        match.humanCube = null;
        match.engineCube = null;
        if (match.crawford) match.crawfordDone = true;
        const board = BackgammonBoard.starting();
        board.matchLength = match.length;
        board.score = { ...match.score };
        match.board = board;
        match.games.push({
            number: match.gameNumber,
            score: { you: match.score[HUMAN], engine: match.score[ENGINE] },
            crawford: match.crawford,
            log: []
        });

        let human;
        let engine;
        do {
            human = this.randomInt(1, 7);
            engine = this.randomInt(1, 7);
        } while (human === engine);
        this.emit(match, events, { type: 'opening', you: human, engine });
        const dice = { die1: Math.max(human, engine), die2: Math.min(human, engine) };
        if (human > engine) {
            await this.startHumanMove(match, dice, events);
        } else {
            await this.engineMoves(match, dice, events);
            if (!isGameOver(match)) await this.startHumanTurn(match, events);
        }
    }

    async nextGame(match, events) {
        match.crawford = match.nextCrawford;
        match.nextCrawford = false;
        await this.newGame(match, events);
    }

    canDouble(match, player) {
        const { board } = match;
        // A player who wins the match by winning this game at the current cube
        // value gains nothing by doubling (e.g. in every 1-point match), so the
        // engine is not asked; at deep levels that saves a long search.
        const away = match.length - match.score[player];
        return !match.crawford
            && (board.cubeOwner === null || board.cubeOwner === player)
            && away > board.cube;
    }

    /** Before the human rolls: offer the cube if it is available, else roll. */
    async startHumanTurn(match, events) {
        const { board } = match;
        board.turn = HUMAN;
        board.dice = null;
        match.humanCube = null;
        if (this.canDouble(match, HUMAN)) {
            const cube = await this.engine.analyzeCube({ ogid: this.ogid(match), player: HUMAN, plies: match.plies });
            if (cube.available) {
                match.humanCube = cube;
                match.phase = 'human-turn';
                return;
            }
        }
        await this.rollForHuman(match, events);
    }

    async rollForHuman(match, events) {
        const dice = this.roll();
        this.emit(match, events, { type: 'roll', who: 'you', dice });
        await this.startHumanMove(match, dice, events);
    }

    async startHumanMove(match, dice, events) {
        const { board } = match;
        board.turn = HUMAN;
        board.dice = dice;
        const legal = await this.engine.listLegalPlays({ ogid: this.ogid(match) });
        const plays = legal.plays.map((play) => ({
            move: play.move,
            key: checkerPlay.positionKey(play.points),
            points: play.points
        }));
        if (plays.length === 1) {
            // No choice: a forced play (or no move at all) is made for the human.
            const [only] = plays;
            setPosition(board, HUMAN, only.points);
            this.emit(match, events, { type: 'move', who: 'you', move: only.move, dice, forced: true, ogid: this.ogid(match) });
            if (!this.checkGameOver(match, HUMAN, events)) await this.engineTurn(match, events);
            return;
        }
        match.legal = { position: legal.position, dice: legal.dice, plays };
        match.phase = 'human-move';
    }

    async humanRolls(match, events) {
        const cube = match.humanCube;
        if (cube) {
            const loss = cubeErrors(cube).ifNotDoubled;
            this.recordDecision(match, {
                kind: 'cube', action: 'No double', loss, grade: grade(loss),
                best: cube.decision,
                rated: ratesNoDouble(cube)
            });
        }
        await this.rollForHuman(match, events);
    }

    async humanDoubles(match, events) {
        const cube = match.humanCube;
        const { board } = match;
        const loss = cubeErrors(cube).ifDoubled;
        this.recordDecision(match, { kind: 'cube', action: 'Double', loss, grade: grade(loss), best: cube.decision });
        this.emit(match, events, { type: 'double', who: 'you', cube: board.cube * 2 });
        if (cube.take === 'pass') {
            this.emit(match, events, { type: 'pass', who: 'engine' });
            this.endGame(match, HUMAN, board.cube, 'pass', events);
            return;
        }
        this.emit(match, events, { type: 'take', who: 'engine' });
        board.cube *= 2;
        board.cubeOwner = ENGINE;
        await this.rollForHuman(match, events);
    }

    async humanTakes(match, events) {
        const cube = match.engineCube;
        const { board } = match;
        const loss = cubeErrors(cube).ifTaken;
        this.recordDecision(match, { kind: 'take', action: 'Take', loss, grade: grade(loss), best: cube.take === 'pass' ? 'Pass' : 'Take' });
        this.emit(match, events, { type: 'take', who: 'you' });
        board.cube *= 2;
        board.cubeOwner = HUMAN;
        match.engineCube = null;
        const dice = this.roll();
        this.emit(match, events, { type: 'roll', who: 'engine', dice });
        await this.engineMoves(match, dice, events);
        if (!isGameOver(match)) await this.startHumanTurn(match, events);
    }

    humanPasses(match, events) {
        const cube = match.engineCube;
        const loss = cubeErrors(cube).ifPassed;
        this.recordDecision(match, { kind: 'take', action: 'Pass', loss, grade: grade(loss), best: cube.take === 'pass' ? 'Pass' : 'Take' });
        this.emit(match, events, { type: 'pass', who: 'you' });
        match.engineCube = null;
        this.endGame(match, ENGINE, match.board.cube, 'pass', events);
    }

    async humanMoves(match, key, events) {
        const play = match.legal?.plays.find((entry) => entry.key === key);
        if (!play) throw new PlayError('That is not a legal play for this roll');
        const rating = await this.engine.analyzeChecker({
            ogid: this.ogid(match), played: play.move, plies: match.plies, maxMoves: 1
        });
        const loss = Math.max(0, -(rating.played?.diff ?? 0));
        this.recordDecision(match, {
            kind: 'move', action: play.move, loss, grade: grade(loss), best: rating.moves[0]?.move ?? null
        });
        const dice = match.board.dice;
        setPosition(match.board, HUMAN, play.points);
        match.legal = null;
        this.emit(match, events, { type: 'move', who: 'you', move: play.move, dice, ogid: this.ogid(match) });
        if (!this.checkGameOver(match, HUMAN, events)) await this.engineTurn(match, events);
    }

    /** The engine's turn: double, or roll and move. */
    async engineTurn(match, events) {
        const { board } = match;
        board.turn = ENGINE;
        board.dice = null;
        if (this.canDouble(match, ENGINE)) {
            const cube = await this.engine.analyzeCube({ ogid: this.ogid(match), player: ENGINE, plies: match.plies });
            if (cube.available && /^(re)?double/i.test(cube.decision || '')) {
                match.engineCube = cube;
                match.phase = 'human-respond';
                this.emit(match, events, { type: 'double', who: 'engine', cube: board.cube * 2 });
                return;
            }
        }
        const dice = this.roll();
        this.emit(match, events, { type: 'roll', who: 'engine', dice });
        await this.engineMoves(match, dice, events);
        if (!isGameOver(match)) await this.startHumanTurn(match, events);
    }

    async engineMoves(match, dice, events) {
        const { board } = match;
        board.turn = ENGINE;
        board.dice = dice;
        const result = await this.engine.analyzeChecker({ ogid: this.ogid(match), plies: match.plies, maxMoves: 1 });
        const best = result.moves[0];
        let points = best?.points;
        if (!points) {
            points = checkerPlay.applyMoveText(checkerPlay.positionFromBoard(board, ENGINE), best?.move || '');
            if (!points) throw new Error(`Could not apply the engine's move '${best?.move}'`);
        }
        setPosition(board, ENGINE, points);
        this.emit(match, events, { type: 'move', who: 'engine', move: best?.move || '', dice, ogid: this.ogid(match) });
        this.checkGameOver(match, ENGINE, events);
    }

    checkGameOver(match, mover, events) {
        if (match.board.points[mover][0] < 15) return false;
        const { multiplier, kind } = gameValue(match.board, mover);
        this.endGame(match, mover, match.board.cube * multiplier, kind, events);
        return true;
    }

    endGame(match, winner, points, kind, events) {
        const loser = opponentOf(winner);
        match.score[winner] += points;
        match.board.score = { ...match.score };
        match.board.dice = null;
        match.legal = null;
        match.humanCube = null;
        match.engineCube = null;
        match.result = { winner: winner === HUMAN ? 'you' : 'engine', points, kind };
        this.emit(match, events, { type: 'game-over', ...match.result });
        if (match.score[winner] >= match.length) {
            match.phase = 'match-over';
            return;
        }
        // The game after a player first reaches match point is the Crawford game.
        match.nextCrawford = !match.crawfordDone
            && match.score[winner] === match.length - 1
            && match.score[loser] < match.length - 1;
        match.phase = 'game-over';
    }

    snapshot(match) {
        const { board } = match;
        return {
            actionId: match.actionId,
            busy: match.busy,
            error: match.error,
            length: match.length,
            score: { you: match.score[HUMAN], engine: match.score[ENGINE] },
            crawford: match.crawford,
            nextCrawford: match.phase === 'game-over' ? match.nextCrawford : false,
            gameNumber: match.gameNumber,
            phase: match.busy ? 'thinking' : match.phase,
            ogid: board ? this.ogid(match) : null,
            cube: board?.cube ?? 1,
            cubeOwner: board?.cubeOwner === HUMAN ? 'you' : (board?.cubeOwner === ENGINE ? 'engine' : null),
            offeredCube: match.phase === 'human-respond' ? board.cube * 2 : null,
            legal: !match.busy && match.phase === 'human-move' && match.legal
                ? {
                    position: match.legal.position,
                    dice: match.legal.dice,
                    plays: match.legal.plays.map((play) => ({ move: play.move, key: play.key }))
                }
                : null,
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
    DEFAULT_LEVEL,
    HUMAN,
    ENGINE,
    MATCH_LENGTHS,
    PlayError,
    PlayMatches,
    cubeErrors,
    gameValue,
    getPlayMatches,
    grade,
    performanceRating,
    playLevels,
    ratesNoDouble,
    setPosition
};
