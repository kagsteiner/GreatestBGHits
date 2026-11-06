'use strict';

// What every match has in common, against the engine or between friends: how a
// decision is graded, and the course of a game with people in the seats. The
// server rolls the dice; a player doubles or rolls, moves, and answers a double.
// src/playMatch.js puts the engine in the second seat, src/friendMatch.js a
// friend, and both keep their matches and tell their pages in their own way.
//
// Phases of a match: 'starting' and 'playing' until there is something to
// decide, 'turn' (roll or double), 'move', 'respond' (take or pass),
// 'game-over' and 'match-over'.

const crypto = require('crypto');
const BackgammonBoard = require('./board');
const bgEngine = require('./engines/bgEngine');
const checkerPlay = require('../shared/checkerPlay');

const DEFAULT_LEVEL = 3;

// Performance rating as in eXtreme Gammon: 500 × average equity loss per
// decision. Forced moves are not decisions, and neither are obvious "no
// double" turns, so they do not dilute the rating: a "no double" counts only
// if not doubling was a mistake, or if doubling would have cost less than
// CLOSE_CUBE_LIMIT while the player was at least a MIN_DOUBLER_WIN favourite.
// (Without the second condition, a hopeless position in match play counts:
// redoubling costs little when the match is lost either way.)
const CLOSE_CUBE_LIMIT = 0.2;
const MIN_DOUBLER_WIN = 0.5;

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

// Equity loss thresholds (XG / gnubg style, see CLIENT_GUIDE.md §7).
const GRADES = [
    { name: 'blunder', above: 0.08 },
    { name: 'error', above: 0.04 },
    { name: 'doubtful', above: 0.02 }
];

/** Something a player asked for that cannot be done; the routes answer with its status. */
class MatchError extends Error {
    /** @param {{ takeOver?: boolean }} [details] takeOver: the request can be repeated to take over a seat */
    constructor(message, status = 400, details = {}) {
        super(message);
        this.name = 'MatchError';
        this.status = status;
        this.takeOver = Boolean(details.takeOver);
    }
}

function performanceRating(stats) {
    if (!stats.rated) return null;
    const value = (PR_SCALE * stats.totalLoss) / stats.rated;
    return { value: Math.round(value * 10) / 10, label: PR_RATINGS.find((entry) => value < entry.below).label };
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

/** Whether a "no double" decision counts for the PR (see above). */
function ratesNoDouble(cube) {
    const errors = cubeErrors(cube);
    return errors.ifNotDoubled > 0
        || (errors.ifDoubled < CLOSE_CUBE_LIMIT && (cube.evaluation?.win ?? 0) >= MIN_DOUBLER_WIN);
}

/** A graded decision in a player's numbers; `item.rated` false keeps it out of the PR. */
function countDecision(stats, item) {
    stats.decisions += 1;
    if (item.rated !== false) {
        stats.rated += 1;
        stats.totalLoss += item.loss;
    }
    if (item.grade) {
        stats.flagged += 1;
        stats.equityLost += item.loss;
    }
}

function otherSeat(seat) {
    return seat === 'player1' ? 'player2' : 'player1';
}

/** Replace the mover's and the opponent's checkers with a position seen from the mover. */
function setPosition(board, mover, points) {
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
    board.points[otherSeat(mover)] = theirs;
}

/** Points won by `winner`, who has just borne off the last checker. */
function gameValue(board, winner) {
    const loser = board.points[otherSeat(winner)];
    if (loser[0] > 0) return { multiplier: 1, kind: 'single' };
    // Checkers on the bar or in the winner's home board (the loser's 19..24).
    let backgammon = loser[25] > 0;
    for (let point = 19; point <= 24; point++) if (loser[point] > 0) backgammon = true;
    return backgammon ? { multiplier: 3, kind: 'backgammon' } : { multiplier: 2, kind: 'gammon' };
}

/**
 * The course of a game. A subclass must add emit (an event for the page) and
 * recordDecision (a graded decision), and may change what its methods below the
 * line "what a subclass may change" do.
 */
class MatchCore {
    /**
     * @param {{ engine?: object, randomInt?: (min: number, max: number) => number, waitMs?: number, store?: object }} [options]
     *   waitMs: how long a request waits for an action before answering with
     *   the progress so far (the action then continues in the background)
     */
    constructor(options = {}) {
        this.engineOverride = options.engine || null;
        this.randomInt = options.randomInt || crypto.randomInt;
        this.waitMs = options.waitMs ?? Infinity;
        this.store = options.store || null;
    }

    get engine() {
        return this.engineOverride || bgEngine.getClient();
    }

    ogid(match) {
        return match.board.toOgid({ crawford: match.crawford });
    }

    roll() {
        return { die1: this.randomInt(1, 7), die2: this.randomInt(1, 7) };
    }

    currentGame(match) {
        return match.games[match.games.length - 1];
    }

    /**
     * Run an action. A failure (e.g. the engine is unreachable) leaves the
     * match as it was, so the action can be repeated. A request that stops
     * waiting (see waitMs) sees the rest of the action by polling the state.
     */
    async run(match, step) {
        if (match.busy) throw new MatchError('Still working on the previous action', 409);
        match.busy = true;
        match.error = null;
        this.actionStarting(match);
        const before = this.restorePoint(match);
        let failure = null;
        const job = (async () => {
            try {
                await step(match.events);
            } catch (error) {
                Object.assign(match, before);
                this.actionFailed(match);
                match.error = error.message;
                failure = error;
            } finally {
                match.busy = false;
            }
            this.actionFinished(match, failure);
        })();
        let timer = null;
        const waited = Number.isFinite(this.waitMs)
            ? new Promise((resolve) => { timer = setTimeout(resolve, this.waitMs); })
            : new Promise(() => {});
        await Promise.race([job, waited]);
        clearTimeout(timer);
        if (failure) throw failure;
    }

    /**
     * Run an action of `seat`: roll, double, take, pass, move (with `key`, the
     * final position of the play) or next-game.
     */
    perform(match, seat, action) {
        const type = action?.type;
        const { phase, board, offer } = match;
        const allowed = {
            roll: phase === 'turn' && board.turn === seat,
            double: phase === 'turn' && board.turn === seat,
            move: phase === 'move' && board.turn === seat,
            take: phase === 'respond' && offer?.to === seat,
            pass: phase === 'respond' && offer?.to === seat,
            'next-game': phase === 'game-over'
        };
        if (!Object.hasOwn(allowed, type)) throw new MatchError(`Unknown action '${type}'`);
        if (!allowed[type]) throw new MatchError(`'${type}' is not possible now`, 409);
        return this.run(match, (events) => {
            switch (type) {
            case 'roll': return this.rolls(match, seat, events);
            case 'double': return this.doubles(match, seat, events);
            case 'take': return this.takes(match, seat, events);
            case 'pass': return this.passes(match, seat, events);
            case 'move': return this.moves(match, seat, action.key, events);
            default: return this.nextGame(match, events);
            }
        });
    }

    async newGame(match, events) {
        match.gameNumber += 1;
        match.phase = 'playing';
        match.result = null;
        match.legal = null;
        match.turnCube = null;
        match.offer = null;
        if (match.crawford) match.crawfordDone = true;
        this.gameStarting(match);
        const board = BackgammonBoard.starting();
        board.matchLength = match.length;
        board.score = { ...match.score };
        match.board = board;
        match.games.push({ number: match.gameNumber, score: this.scoreBySide(match), crawford: match.crawford, log: [] });

        let one;
        let two;
        do {
            one = this.randomInt(1, 7);
            two = this.randomInt(1, 7);
        } while (one === two);
        const starter = one > two ? 'player1' : 'player2';
        this.emit(match, events, this.openingEvent(one, two, starter));
        board.turn = starter;
        board.dice = null;
        await this.rolled(match, starter, { die1: Math.max(one, two), die2: Math.min(one, two) }, events, true);
    }

    async nextGame(match, events) {
        match.crawford = match.nextCrawford;
        match.nextCrawford = false;
        await this.newGame(match, events);
    }

    canDouble(match, seat) {
        const { board } = match;
        // A player who wins the match by winning this game at the current cube
        // value gains nothing by doubling (e.g. in every 1-point match), so the
        // engine is not asked; at deep levels that saves a long search.
        const away = match.length - match.score[seat];
        return !match.crawford
            && (board.cubeOwner === null || board.cubeOwner === seat)
            && away > board.cube;
    }

    /** Before `seat` rolls: offer the cube if it is available, else roll. */
    async startTurn(match, seat, events) {
        const { board } = match;
        this.turnStarting(match, seat);
        board.turn = seat;
        board.dice = null;
        match.turnCube = null;
        if (this.canDouble(match, seat)) {
            const cube = await this.engine.analyzeCube({ ogid: this.ogid(match), player: seat, plies: this.ratingPlies(match) });
            if (cube.available) {
                match.turnCube = cube;
                match.phase = 'turn';
                return;
            }
        }
        await this.rollFor(match, seat, events);
    }

    async rollFor(match, seat, events) {
        await this.rolled(match, seat, this.roll(), events);
    }

    async rolled(match, seat, dice, events, opening = false) {
        const details = await this.rollDetails(match, seat, dice, opening);
        match.board.turn = seat;
        match.board.dice = dice;
        if (details) this.emit(match, events, { type: 'roll', who: this.side(seat), dice, ...details });
        await this.startMove(match, seat, dice, events);
    }

    async startMove(match, seat, dice, events) {
        const { board } = match;
        const legal = await this.engine.listLegalPlays({ ogid: this.ogid(match) });
        const plays = legal.plays.map((play) => ({
            move: play.move,
            key: checkerPlay.positionKey(play.points),
            points: play.points
        }));
        if (plays.length === 1) {
            // No choice: a forced play (or no move at all) is made for the player.
            const [only] = plays;
            setPosition(board, seat, only.points);
            this.emit(match, events, { type: 'move', who: this.side(seat), move: only.move, dice, forced: true, ogid: this.ogid(match) });
            await this.moved(match, seat, events);
            return;
        }
        match.legal = { position: legal.position, dice: legal.dice, plays };
        match.phase = 'move';
    }

    /** `seat` has moved: the game is over, or the other player goes on. */
    async moved(match, seat, events) {
        if (!this.checkGameOver(match, seat, events)) await this.startTurn(match, otherSeat(seat), events);
    }

    async rolls(match, seat, events) {
        const cube = match.turnCube;
        if (cube) {
            const loss = cubeErrors(cube).ifNotDoubled;
            const decision = this.recordDecision(match, seat, {
                kind: 'cube', action: 'No double', loss, grade: grade(loss), best: cube.decision, rated: ratesNoDouble(cube)
            }, this.ogid(match));
            this.noDoubleRecorded(match, seat, decision, events);
        }
        match.turnCube = null;
        await this.rollFor(match, seat, events);
    }

    async doubles(match, seat, events) {
        const cube = match.turnCube;
        const { board } = match;
        const loss = cubeErrors(cube).ifDoubled;
        // The grade of a double tells the other player how to answer it (a wrong one is either
        // too good or too bad), so it is only recorded once the double was answered.
        const double = { kind: 'cube', action: 'Double', loss, grade: grade(loss), best: cube.decision };
        match.turnCube = null;
        match.offer = { by: seat, to: otherSeat(seat), cube: board.cube * 2, analysis: cube, ogid: this.ogid(match), double };
        match.phase = 'respond';
        this.emit(match, events, { type: 'double', who: this.side(seat), cube: board.cube * 2 });
    }

    /** The double was answered: now it counts, and a wrong one gets its line in the move list. */
    settleDouble(match, events) {
        const { by, ogid, double } = match.offer;
        if (!double) return;
        // In the log it goes before the double, which is the latest line there.
        const decision = this.recordDecision(match, by, double, ogid, this.currentGame(match).log.length - 1);
        if (decision.grade) this.emit(match, events, { type: 'double-graded', who: this.side(by), ...this.decisionDetails(decision) });
    }

    answerDouble(match, seat, action, events) {
        const { analysis, ogid } = match.offer;
        this.settleDouble(match, events);
        const errors = cubeErrors(analysis);
        const loss = action === 'Take' ? errors.ifTaken : errors.ifPassed;
        this.answering(match, seat);
        const decision = this.recordDecision(match, seat, {
            kind: 'take', action, loss, grade: grade(loss), best: analysis.take === 'pass' ? 'Pass' : 'Take'
        }, ogid);
        this.emit(match, events, { type: action.toLowerCase(), who: this.side(seat), ...this.decisionDetails(decision) });
    }

    async takes(match, seat, events) {
        const { by } = match.offer;
        const { board } = match;
        this.answerDouble(match, seat, 'Take', events);
        board.cube *= 2;
        board.cubeOwner = seat;
        match.offer = null;
        await this.rollFor(match, by, events);
    }

    async passes(match, seat, events) {
        const { by } = match.offer;
        this.answerDouble(match, seat, 'Pass', events);
        match.offer = null;
        this.endGame(match, by, match.board.cube, 'pass', events);
    }

    async moves(match, seat, key, events) {
        const play = match.legal?.plays.find((entry) => entry.key === key);
        if (!play) throw new MatchError('That is not a legal play for this roll');
        const ogid = this.ogid(match);
        const rating = await this.engine.analyzeChecker({
            ogid, played: play.move, plies: this.ratingPlies(match), maxMoves: this.rankedPlays
        });
        const loss = Math.max(0, -(rating.played?.diff ?? 0));
        const decision = this.recordDecision(match, seat, {
            kind: 'move', action: play.move, loss, grade: grade(loss), best: rating.moves[0]?.move ?? null
        }, ogid);
        const details = this.moveDetails(match, seat, decision, rating);
        const { dice } = match.board;
        setPosition(match.board, seat, play.points);
        match.legal = null;
        match.tentative = null;
        this.emit(match, events, { type: 'move', who: this.side(seat), move: play.move, dice, ogid: this.ogid(match), ...details });
        await this.moved(match, seat, events);
    }

    checkGameOver(match, mover, events) {
        if (match.board.points[mover][0] < 15) return false;
        const { multiplier, kind } = gameValue(match.board, mover);
        this.endGame(match, mover, match.board.cube * multiplier, kind, events);
        return true;
    }

    endGame(match, winner, points, kind, events) {
        const loser = otherSeat(winner);
        match.score[winner] += points;
        match.board.score = { ...match.score };
        match.board.dice = null;
        match.legal = null;
        match.turnCube = null;
        match.offer = null;
        match.result = { winner: this.side(winner), points, kind };
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

    /** The legal plays as a page gets them, for the player who is to move. */
    legalForPage(match) {
        return {
            position: match.legal.position,
            dice: match.legal.dice,
            plays: match.legal.plays.map((play) => ({ move: play.move, key: play.key }))
        };
    }

    // --- What a subclass may change ---

    /** How many plays the engine ranks when it rates a move. */
    get rankedPlays() {
        return 1;
    }

    /** What a seat is called in events and results. */
    side(seat) {
        return seat;
    }

    /** The score as it is kept with a game. */
    scoreBySide(match) {
        return { ...match.score };
    }

    /** The depth decisions are rated at. */
    ratingPlies(match) {
        return match.plies;
    }

    /** What goes back on a failed action. */
    restorePoint(match) {
        const fields = ['phase', 'legal', 'turnCube', 'offer', 'result', 'gameNumber', 'crawford', 'crawfordDone', 'nextCrawford'];
        return {
            ...Object.fromEntries(fields.map((field) => [field, match[field]])),
            board: match.board ? match.board.clone() : null,
            score: { ...match.score },
            stats: structuredClone(match.stats),
            games: structuredClone(match.games)
        };
    }

    actionStarting() {}

    actionFailed() {}

    /** An action has finished; `failure` is its error, if it failed. */
    actionFinished() {}

    gameStarting() {}

    turnStarting() {}

    /** A player is about to answer a double. */
    answering() {}

    /** What goes into the event of a roll; null for no event. */
    async rollDetails() {
        return {};
    }

    /** A player rolled instead of doubling. */
    noDoubleRecorded() {}

    /** What the event of a decision says about its grade. */
    decisionDetails() {
        return {};
    }

    /** What the event of a move says about its decision. */
    moveDetails() {
        return {};
    }
}

module.exports = {
    DEFAULT_LEVEL,
    MatchCore,
    MatchError,
    countDecision,
    cubeErrors,
    gameValue,
    grade,
    otherSeat,
    performanceRating,
    ratesNoDouble,
    setPosition
};
