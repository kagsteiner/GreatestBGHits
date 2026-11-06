'use strict';

// A friendly match between two people at one table: the first two browsers
// that open the friend page take the two seats. There is only ever one table.
// The server rolls the dice and grades every decision of both players with
// the engine, as in the match against the engine, and measures each player's
// luck. A player's name is who they are: during a match their seat stays theirs,
// and they get it back from any browser by sitting down under that name. The
// running match is kept in the store after every action, so it survives both
// players leaving (and a server restart): it goes on when both are back.
// Finished matches are saved to the history, with every game to review it.

const crypto = require('crypto');
const BackgammonBoard = require('./board');
const bgEngine = require('./engines/bgEngine');
const { getBridges } = require('./engineBridge');
const checkerPlay = require('../shared/checkerPlay');
const {
    DEFAULT_LEVEL, cubeErrors, gameValue, grade, performanceRating, ratesNoDouble, setPosition
} = require('./playMatch');

const SEATS = ['player1', 'player2'];
const FRIEND_LENGTHS = [3, 5, 7];
const NAME_MAX = 20;
// A browser that has not asked for the state for this long counts as gone: its
// player shows as offline, and outside a match another player can take the seat.
const STALE_SEAT_MS = 2 * 60 * 1000;
// Luck is measured with the engine's fastest search (a static evaluation).
const LUCK_PLIES = 1;

/** The 21 different rolls with their chances; the opening roll has no doubles. */
function rollsWithChances(opening) {
    const rolls = [];
    for (let die1 = 6; die1 >= 1; die1--) {
        for (let die2 = die1; die2 >= 1; die2--) {
            if (opening && die1 === die2) continue;
            const ways = die1 === die2 ? 1 : 2;
            rolls.push({ die1, die2, chance: ways / (opening ? 30 : 36) });
        }
    }
    return rolls;
}

class FriendError extends Error {
    /** @param {{ takeOver?: boolean }} [details] takeOver: the request can be repeated to take over the seat */
    constructor(message, status = 400, details = {}) {
        super(message);
        this.name = 'FriendError';
        this.status = status;
        this.takeOver = Boolean(details.takeOver);
    }
}

function other(seat) {
    return seat === 'player1' ? 'player2' : 'player1';
}

function cleanName(name) {
    const text = String(name || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
    if (!text) throw new FriendError('Please enter your name');
    return text;
}

function sameName(a, b) {
    return a.toLowerCase() === b.toLowerCase();
}

function emptyStats() {
    return { decisions: 0, rated: 0, totalLoss: 0, flagged: 0, equityLost: 0, luck: 0, rolls: 0, awesome: 0, bestAwesome: 0 };
}

const round3 = (value) => Math.round(value * 1000) / 1000;

/** The grade of a decision for its line in the move list: nothing unless it was a mistake. */
function flagOf(decision) {
    return decision?.grade ? { grade: decision.grade, loss: round3(decision.loss) } : {};
}

// Equities closer than this count as equal (the engine reports 4-6 decimals).
const SAME_EQUITY = 1e-6;
// Plays the engine ranks for a checker decision; enough to see whether the roll left a real choice.
const RANKED_PLAYS = 20;

/**
 * The "awesome" streak: best checker plays in a row over the whole match, and
 * the longest such streak. Only real choices count: a move where every play
 * has the same value (or a forced one, which is never graded) leaves the
 * streak as it is. Cube decisions do not count either.
 * @returns {boolean} whether this was a best play that counts (the pages then say "awesome")
 */
function countAwesome(stats, rating, loss) {
    const equities = rating.moves.map((move) => move.equity).filter((equity) => Number.isFinite(equity));
    const choice = equities.length > 1 && Math.max(...equities) - Math.min(...equities) > SAME_EQUITY;
    if (!choice) return false;
    const best = loss <= SAME_EQUITY;
    stats.awesome = best ? stats.awesome + 1 : 0;
    stats.bestAwesome = Math.max(stats.bestAwesome, stats.awesome);
    return best;
}

/** A running match as plain data for the store (see restoreMatch). */
function matchToSaved(match) {
    const { board, decisions, marked, recent, busy, error, saved, resumed, tentative, ...rest } = match;
    return {
        ...rest,
        board: board ? {
            points: board.points, turn: board.turn, cube: board.cube, cubeOwner: board.cubeOwner,
            score: board.score, matchLength: board.matchLength, dice: board.dice, ogid: board.ogidMetadata
        } : null,
        decisions: [...decisions.values()],
        marked: [...marked],
        recent: { player1: recent.player1.map((item) => item.id), player2: recent.player2.map((item) => item.id) }
    };
}

function restoreMatch(saved) {
    const decisions = new Map(saved.decisions.map((item) => [item.id, item]));
    return {
        ...saved,
        board: saved.board ? new BackgammonBoard(saved.board) : null,
        decisions,
        marked: new Set(saved.marked),
        recent: {
            player1: saved.recent.player1.map((id) => decisions.get(id)),
            player2: saved.recent.player2.map((id) => decisions.get(id))
        },
        busy: false,
        error: null,
        saved: false,
        // The page plays no sounds for what happened before.
        resumed: true
    };
}

class FriendTable {
    /**
     * @param {{ engine?: object, randomInt?: (min: number, max: number) => number, waitMs?: number,
     *   store?: { saveMatch(record: object): void, markDecisions(id: string, marked: object[]): void,
     *     saveOpenMatch(open: object): void, deleteOpenMatch(id: string): void,
     *     listOpenMatches(): object[], getOpenMatch(id: string): object|null },
     *   now?: () => number }} [options]
     */
    constructor(options = {}) {
        this.engineOverride = options.engine || null;
        this.randomInt = options.randomInt || crypto.randomInt;
        this.waitMs = options.waitMs ?? Infinity;
        this.store = options.store || null;
        this.now = options.now || Date.now;
        this.plies = DEFAULT_LEVEL;
        // seat -> { browser, name, lastSeen, wantLength }
        this.seats = { player1: null, player2: null };
        this.match = null;
        // Something both players should read in the lobby, e.g. that a match was aborted.
        this.notice = null;
    }

    get engine() {
        return this.engineOverride || bgEngine.getClient();
    }

    seatOf(browser) {
        if (!browser) return null;
        return SEATS.find((seat) => this.seats[seat]?.browser === browser) || null;
    }

    /** Is a match going on (a finished one stays on the board until the next one)? */
    get running() {
        return Boolean(this.match && this.match.phase !== 'match-over');
    }

    /** No browser of this player is at the table: they left, or closed the page. */
    isAway(seat) {
        const taken = this.seats[seat];
        return !taken?.browser || this.now() - taken.lastSeen > STALE_SEAT_MS;
    }

    requireSeat(browser) {
        const seat = this.seatOf(browser);
        if (!seat) throw new FriendError('Please join the table first', 403);
        this.seats[seat].lastSeen = this.now();
        return seat;
    }

    /**
     * Rename yourself; come back to your seat under your name, from any browser
     * (`takeOver` if that seat still seems to be in use elsewhere); or take a
     * free seat. When both players of an adjourned match sit, it goes on.
     */
    join(browser, name, { takeOver = false } = {}) {
        const clean = cleanName(name);
        const named = SEATS.find((s) => this.seats[s] && sameName(this.seats[s].name, clean));
        let seat = this.seatOf(browser);
        if (seat) {
            if (named && named !== seat) throw new FriendError(`${this.seats[named].name} is already at the table, please choose another name`, 409);
        } else if (named) {
            if (!this.isAway(named) && !takeOver) {
                throw new FriendError(`${this.seats[named].name} is at the table in another browser`, 409, { takeOver: true });
            }
            // The name was only the check: it stays as it was written first.
            this.seats[named].browser = browser;
            this.seats[named].lastSeen = this.now();
            return this.state(browser);
        } else {
            this.adjournIfEveryoneIsAway();
            if (this.running) {
                const { player1, player2 } = this.match.names;
                throw new FriendError(`${player1} and ${player2} are playing. To continue your match here, enter your name as you play under it`, 409);
            }
            const stale = (s) => this.seats[s] && this.isAway(s);
            seat = SEATS.find((s) => !this.seats[s]) || SEATS.find(stale);
            if (!seat) throw new FriendError('Two players are already at the table', 409);
            this.seats[seat] = { browser, name: clean, lastSeen: this.now(), wantLength: null };
        }
        this.seats[seat].name = clean;
        this.seats[seat].lastSeen = this.now();
        if (this.match) this.match.names[seat] = clean;
        if (this.running) this.keepOpen(this.match);
        this.resumeAdjourned();
        return this.state(browser);
    }

    /**
     * Leave the table. A running match stays, with the seat kept for the player;
     * when both have left, only the store keeps it until they are back.
     */
    leave(browser) {
        const seat = this.seatOf(browser);
        if (!seat) return this.state(browser);
        if (this.match?.busy) throw new FriendError('Please wait until the current action is finished', 409);
        if (this.running) {
            this.seats[seat].browser = null;
            if (SEATS.every((s) => !this.seats[s].browser)) this.adjourn();
            return this.state(browser);
        }
        this.seats[seat] = null;
        for (const s of SEATS) if (this.seats[s]) this.seats[s].wantLength = null;
        return this.state(browser);
    }

    /** The match leaves the table; it is in the store from its latest action on. */
    adjourn() {
        this.match = null;
        this.seats = { player1: null, player2: null };
    }

    /** Someone new sits down while both players of a match are gone. */
    adjournIfEveryoneIsAway() {
        if (this.running && !this.match.busy && SEATS.every((s) => this.isAway(s))) this.adjourn();
    }

    /** Both players of an adjourned match are seated: it goes on, each on their own side. */
    resumeAdjourned() {
        const [one, two] = SEATS.map((s) => this.seats[s]);
        if (this.running || !one || !two || !this.store) return;
        const same = (open, a, b) => sameName(open.names.player1, a.name) && sameName(open.names.player2, b.name);
        const open = this.openMatches().find((item) => same(item, one, two) || same(item, two, one));
        if (!open) return;
        const saved = this.store.getOpenMatch(open.id);
        if (!saved) return;
        if (same(open, two, one)) this.seats = { player1: two, player2: one };
        this.match = restoreMatch(saved);
        this.notice = null;
        for (const s of SEATS) {
            this.seats[s].wantLength = null;
            this.seats[s].name = this.match.names[s];
        }
    }

    /** The matches in the store, newest first; the page polls this, so never an error. */
    openMatches() {
        if (!this.store) return [];
        try {
            return this.store.listOpenMatches();
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error(`Could not list the open friend matches: ${error.message}`);
            return [];
        }
    }

    /** Keep the running match in the store. Playing goes on even if that fails. */
    keepOpen(match) {
        if (!this.store) return;
        try {
            this.store.saveOpenMatch({
                id: match.id,
                updatedAt: new Date(this.now()).toISOString(),
                length: match.length,
                names: match.names,
                score: match.score,
                state: matchToSaved(match)
            });
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error(`Could not keep friend match ${match.id}: ${error.message}`);
        }
    }

    closeOpen(match) {
        if (!this.store) return;
        try {
            this.store.deleteOpenMatch(match.id);
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error(`Could not remove friend match ${match.id}: ${error.message}`);
        }
    }

    /** End the running match for both players without saving it; either player may. */
    abort(browser) {
        const seat = this.requireSeat(browser);
        const match = this.match;
        if (!match || match.phase === 'match-over') throw new FriendError('No match is running', 404);
        if (match.busy) throw new FriendError('Please wait until the current action is finished', 409);
        this.closeOpen(match);
        this.match = null;
        for (const s of SEATS) {
            // A player who had left no longer has a seat to come back to.
            if (this.seats[s] && !this.seats[s].browser) this.seats[s] = null;
            if (this.seats[s]) this.seats[s].wantLength = null;
        }
        this.notice = { by: seat, text: `${this.seats[seat].name} aborted the match.` };
        return this.state(browser);
    }

    /** Choose a match length; the match starts once both players chose the same one. */
    async chooseLength(browser, length) {
        const seat = this.requireSeat(browser);
        if (!FRIEND_LENGTHS.includes(length)) throw new FriendError(`Match length must be one of ${FRIEND_LENGTHS.join(', ')}`);
        if (this.match && this.match.phase !== 'match-over') throw new FriendError('A match is already running', 409);
        this.seats[seat].wantLength = length;
        const [a, b] = SEATS.map((s) => this.seats[s]);
        if (a && b && a.wantLength === length && b.wantLength === length) {
            a.wantLength = null;
            b.wantLength = null;
            this.startMatch(length);
            await this.run(this.match, (events) => this.newGame(this.match, events));
        }
        return this.state(browser);
    }

    startMatch(length) {
        this.notice = null;
        this.match = {
            id: crypto.randomUUID(),
            startedAt: new Date(this.now()).toISOString(),
            length,
            names: { player1: this.seats.player1.name, player2: this.seats.player2.name },
            score: { player1: 0, player2: 0 },
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
            // The checkers of the player on move so far, for the other player to watch.
            tentative: null,
            stats: { player1: emptyStats(), player2: emptyStats() },
            // Each player's graded decisions of their latest turn (cube and move together, so a
            // missed double stays in view after the move), and every one of the match (for marking).
            recent: { player1: [], player2: [] },
            decisions: new Map(),
            marked: new Set(),
            events: [],
            eventSeq: 0,
            // Every game with its log, for the review (never sent during play: see src/matchReview.js).
            games: [],
            busy: false,
            error: null,
            saved: false
        };
    }

    /**
     * An action of the player in `browser`: roll, double, take, pass, move
     * (with `key`, the final position of the play) or next-game.
     */
    async act(browser, action) {
        const seat = this.requireSeat(browser);
        const match = this.match;
        if (!match) throw new FriendError('No match is running', 404);
        const type = action?.type;
        const allowed = {
            roll: match.phase === 'turn' && match.board.turn === seat,
            double: match.phase === 'turn' && match.board.turn === seat,
            move: match.phase === 'move' && match.board.turn === seat,
            take: match.phase === 'respond' && match.offer?.to === seat,
            pass: match.phase === 'respond' && match.offer?.to === seat,
            'next-game': match.phase === 'game-over'
        };
        if (!(type in allowed)) throw new FriendError(`Unknown action '${type}'`);
        if (!allowed[type]) throw new FriendError(`'${type}' is not possible now`, 409);
        await this.run(match, (events) => {
            switch (type) {
            case 'roll': return this.rolls(match, seat, events);
            case 'double': return this.doubles(match, seat, events);
            case 'take': return this.takes(match, seat, events);
            case 'pass': return this.passes(match, seat, events);
            case 'move': return this.moves(match, seat, action.key, events);
            default: return this.nextGame(match, events);
            }
        });
        return this.state(browser);
    }

    /** Mark (or unmark) a graded decision of the match to look at it later. */
    mark(browser, decisionId, marked) {
        this.requireSeat(browser);
        const match = this.match;
        const decision = match?.decisions.get(decisionId);
        if (!decision) throw new FriendError('That decision is not part of the current match', 404);
        if (marked) match.marked.add(decisionId);
        else match.marked.delete(decisionId);
        decision.marked = Boolean(marked);
        if (match.saved && this.store) this.store.markDecisions(match.id, this.markedList(match));
        else if (this.running) this.keepOpen(match);
        return { id: decisionId, marked: decision.marked };
    }

    /**
     * Where the player on move has put their checkers so far ({ points } in the
     * window.checkerPlay format, `moved` of them), for the other player to watch.
     * It only ever goes on the other player's screen, so it is not checked against the
     * roll and not stored. One sent too late for this move (`seq` is the page's
     * latest event) is ignored.
     */
    tentative(browser, { seq, points, moved } = {}) {
        const seat = this.requireSeat(browser);
        const valid = Array.isArray(points) && points.length === 26
            && points.every((count) => Number.isInteger(count) && Math.abs(count) <= 15)
            && Number.isInteger(moved) && moved >= 0 && moved <= 4;
        if (!valid) throw new FriendError('That is not a position');
        const match = this.match;
        const current = match && !match.busy && match.phase === 'move' && match.board.turn === seat && seq === match.eventSeq;
        if (current) match.tentative = moved > 0 ? { points, moved } : null;
        return { shown: Boolean(current) };
    }

    /**
     * Run an action. A failure (e.g. the engine is unreachable) leaves the
     * match as it was, so the action can be repeated. A request that stops
     * waiting (see waitMs) sees the rest of the action by polling the state.
     */
    async run(match, step) {
        if (match.busy) throw new FriendError('Still working on the previous action', 409);
        match.busy = true;
        match.error = null;
        const fields = ['phase', 'legal', 'turnCube', 'offer', 'result', 'gameNumber', 'crawford', 'crawfordDone',
            'nextCrawford', 'eventSeq'];
        const before = Object.fromEntries(fields.map((field) => [field, match[field]]));
        before.board = match.board ? match.board.clone() : null;
        before.score = { ...match.score };
        before.stats = structuredClone(match.stats);
        before.recent = { player1: match.recent.player1.slice(), player2: match.recent.player2.slice() };
        before.events = match.events.slice();
        before.decisions = new Map(match.decisions);
        before.games = structuredClone(match.games);
        let failure = null;
        const job = (async () => {
            try {
                await step(match.events);
            } catch (error) {
                Object.assign(match, before);
                // The player's page starts the move over.
                match.tentative = null;
                match.error = error.message;
                failure = error;
            } finally {
                match.busy = false;
            }
            if (failure) return;
            if (match.phase === 'match-over') {
                this.save(match);
                this.closeOpen(match);
            } else {
                this.keepOpen(match);
            }
        })();
        let timer = null;
        const waited = Number.isFinite(this.waitMs)
            ? new Promise((resolve) => { timer = setTimeout(resolve, this.waitMs); })
            : new Promise(() => {});
        await Promise.race([job, waited]);
        clearTimeout(timer);
        if (failure) throw failure;
    }

    markedList(match) {
        return [...match.marked].map((id) => match.decisions.get(id)).filter(Boolean).map((item) => ({
            id: item.id,
            seat: item.seat,
            name: match.names[item.seat],
            kind: item.kind,
            ogid: item.ogid,
            action: item.action,
            best: item.best,
            loss: round3(item.loss)
        }));
    }

    /** The finished match for the history: result, PR and luck of both players. */
    record(match) {
        const side = (seat) => ({
            name: match.names[seat],
            score: match.score[seat],
            pr: performanceRating(match.stats[seat])?.value ?? null,
            luck: round3(match.stats[seat].luck)
        });
        return {
            id: match.id,
            startedAt: match.startedAt,
            finishedAt: new Date(this.now()).toISOString(),
            length: match.length,
            player1: side('player1'),
            player2: side('player2'),
            marked: this.markedList(match),
            games: match.games
        };
    }

    save(match) {
        if (match.saved || !this.store) return;
        try {
            this.store.saveMatch(this.record(match));
            match.saved = true;
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error(`Could not save friend match ${match.id}: ${error.message}`);
        }
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

    /** An event for the pages, also kept in the game's log for the review. */
    emit(match, events, event) {
        match.eventSeq += 1;
        const entry = { seq: match.eventSeq, game: match.gameNumber, ...event };
        events.push(entry);
        this.currentGame(match).log.push(entry);
    }

    /**
     * Record a graded decision of `seat`; `item.rated` false keeps it out of the PR.
     * In the game's log it goes before the action it grades: by default the next one.
     */
    recordDecision(match, seat, item, ogid, logAt = this.currentGame(match).log.length) {
        const stats = match.stats[seat];
        stats.decisions += 1;
        if (item.rated !== false) {
            stats.rated += 1;
            stats.totalLoss += item.loss;
        }
        if (item.grade) {
            stats.flagged += 1;
            stats.equityLost += item.loss;
        }
        const decision = { ...item, seat, ogid, id: `${match.gameNumber}:${match.decisions.size + 1}`, marked: false };
        match.decisions.set(decision.id, decision);
        match.recent[seat].push(decision);
        const { id, kind, action, loss, grade: mistake, best } = decision;
        this.currentGame(match).log.splice(logAt, 0, { type: 'grade', who: seat, id, kind, action, loss, grade: mistake, best });
        return decision;
    }

    /**
     * Luck of a roll: the equity after the best play with this roll, minus the
     * average of that over all rolls, from the roller's view. Measured with a
     * static evaluation, so it is quick: 21 small requests (15 for the opening).
     */
    async luckOf(match, seat, dice, { opening = false } = {}) {
        const ogid = this.ogid(match);
        const rolls = rollsWithChances(opening);
        // One after the other: the engine client queues its requests anyway, and only a few.
        const equities = [];
        for (const roll of rolls) {
            const result = await this.engine.analyzeChecker({
                ogid, dice: { die1: roll.die1, die2: roll.die2 }, plies: LUCK_PLIES, maxMoves: 1
            });
            equities.push(result.moves[0]?.equity ?? 0);
        }
        const average = rolls.reduce((sum, roll, index) => sum + roll.chance * equities[index], 0);
        const high = Math.max(dice.die1, dice.die2);
        const low = Math.min(dice.die1, dice.die2);
        const index = rolls.findIndex((roll) => roll.die1 === high && roll.die2 === low);
        const luck = equities[index] - average;
        match.stats[seat].luck += luck;
        match.stats[seat].rolls += 1;
        return luck;
    }

    async newGame(match, events) {
        match.gameNumber += 1;
        match.phase = 'playing';
        match.result = null;
        match.legal = null;
        match.turnCube = null;
        match.offer = null;
        match.recent = { player1: [], player2: [] };
        if (match.crawford) match.crawfordDone = true;
        const board = BackgammonBoard.starting();
        board.matchLength = match.length;
        board.score = { ...match.score };
        match.board = board;
        match.games.push({ number: match.gameNumber, score: { ...match.score }, crawford: match.crawford, log: [] });

        let one;
        let two;
        do {
            one = this.randomInt(1, 7);
            two = this.randomInt(1, 7);
        } while (one === two);
        const starter = one > two ? 'player1' : 'player2';
        this.emit(match, events, { type: 'opening', dice: { player1: one, player2: two }, starter });
        const dice = { die1: Math.max(one, two), die2: Math.min(one, two) };
        board.turn = starter;
        board.dice = null;
        const luck = await this.luckOf(match, starter, dice, { opening: true });
        await this.startMove(match, starter, dice, luck, events);
    }

    async nextGame(match, events) {
        match.crawford = match.nextCrawford;
        match.nextCrawford = false;
        await this.newGame(match, events);
    }

    canDouble(match, seat) {
        const { board } = match;
        const away = match.length - match.score[seat];
        return !match.crawford
            && (board.cubeOwner === null || board.cubeOwner === seat)
            && away > board.cube;
    }

    /**
     * The depth decisions are rated at: the table's, or less when the browser
     * computing this request would need more than a few seconds for it
     * (shared/engineBudget.js).
     */
    ratingPlies() {
        const own = getBridges().currentLimits({ ratingPlies: this.plies });
        return own ? own.ratingPlies : this.plies;
    }

    /** Before `seat` rolls: offer the cube if it is available, else roll. */
    async startTurn(match, seat, events) {
        const { board } = match;
        match.recent[seat] = [];
        board.turn = seat;
        board.dice = null;
        match.turnCube = null;
        if (this.canDouble(match, seat)) {
            const cube = await this.engine.analyzeCube({ ogid: this.ogid(match), player: seat, plies: this.ratingPlies() });
            if (cube.available) {
                match.turnCube = cube;
                match.phase = 'turn';
                return;
            }
        }
        await this.rollFor(match, seat, events);
    }

    async rollFor(match, seat, events) {
        const dice = this.roll();
        const luck = await this.luckOf(match, seat, dice);
        await this.startMove(match, seat, dice, luck, events);
    }

    async startMove(match, seat, dice, luck, events) {
        const { board } = match;
        board.turn = seat;
        board.dice = dice;
        this.emit(match, events, { type: 'roll', who: seat, dice, luck: round3(luck) });
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
            this.emit(match, events, { type: 'move', who: seat, move: only.move, dice, forced: true, ogid: this.ogid(match) });
            if (!this.checkGameOver(match, seat, events)) await this.startTurn(match, other(seat), events);
            return;
        }
        match.legal = { position: legal.position, dice: legal.dice, plays };
        match.phase = 'move';
    }

    async rolls(match, seat, events) {
        const cube = match.turnCube;
        if (cube) {
            const loss = cubeErrors(cube).ifNotDoubled;
            const decision = this.recordDecision(match, seat, {
                kind: 'cube', action: 'No double', loss, grade: grade(loss), best: cube.decision, rated: ratesNoDouble(cube)
            }, this.ogid(match));
            // A missed double has no line of its own in the move list unless it was a mistake.
            if (decision.grade) this.emit(match, events, { type: 'no-double', who: seat, ...flagOf(decision) });
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
        match.offer = { by: seat, to: other(seat), cube: board.cube * 2, analysis: cube, ogid: this.ogid(match), double };
        match.phase = 'respond';
        this.emit(match, events, { type: 'double', who: seat, cube: board.cube * 2 });
    }

    /** The double was answered: now it counts, and a wrong one gets its line in the move list. */
    settleDouble(match, events) {
        const { by, ogid, double } = match.offer;
        // In the log it goes before the double, which is the latest line there.
        const decision = this.recordDecision(match, by, double, ogid, this.currentGame(match).log.length - 1);
        if (decision.grade) this.emit(match, events, { type: 'double-graded', who: by, ...flagOf(decision) });
    }

    async takes(match, seat, events) {
        const { analysis, by, ogid } = match.offer;
        const { board } = match;
        this.settleDouble(match, events);
        const loss = cubeErrors(analysis).ifTaken;
        // Answering a double happens in the other player's turn: it starts a new list.
        match.recent[seat] = [];
        const decision = this.recordDecision(match, seat, {
            kind: 'take', action: 'Take', loss, grade: grade(loss), best: analysis.take === 'pass' ? 'Pass' : 'Take'
        }, ogid);
        this.emit(match, events, { type: 'take', who: seat, ...flagOf(decision) });
        board.cube *= 2;
        board.cubeOwner = seat;
        match.offer = null;
        await this.rollFor(match, by, events);
    }

    async passes(match, seat, events) {
        const { analysis, by, ogid } = match.offer;
        this.settleDouble(match, events);
        const loss = cubeErrors(analysis).ifPassed;
        match.recent[seat] = [];
        const decision = this.recordDecision(match, seat, {
            kind: 'take', action: 'Pass', loss, grade: grade(loss), best: analysis.take === 'pass' ? 'Pass' : 'Take'
        }, ogid);
        this.emit(match, events, { type: 'pass', who: seat, ...flagOf(decision) });
        match.offer = null;
        this.endGame(match, by, match.board.cube, 'pass', events);
    }

    async moves(match, seat, key, events) {
        const play = match.legal?.plays.find((entry) => entry.key === key);
        if (!play) throw new FriendError('That is not a legal play for this roll');
        const ogid = this.ogid(match);
        const rating = await this.engine.analyzeChecker({ ogid, played: play.move, plies: this.ratingPlies(), maxMoves: RANKED_PLAYS });
        const loss = Math.max(0, -(rating.played?.diff ?? 0));
        const awesome = countAwesome(match.stats[seat], rating, loss);
        const decision = this.recordDecision(match, seat, {
            kind: 'move', action: play.move, loss, grade: grade(loss), best: rating.moves[0]?.move ?? null
        }, ogid);
        const { dice } = match.board;
        setPosition(match.board, seat, play.points);
        match.legal = null;
        match.tentative = null;
        this.emit(match, events, {
            type: 'move', who: seat, move: play.move, dice, ogid: this.ogid(match), ...flagOf(decision), ...(awesome ? { awesome: true } : {})
        });
        if (!this.checkGameOver(match, seat, events)) await this.startTurn(match, other(seat), events);
    }

    checkGameOver(match, mover, events) {
        if (match.board.points[mover][0] < 15) return false;
        const { multiplier, kind } = gameValue(match.board, mover);
        this.endGame(match, mover, match.board.cube * multiplier, kind, events);
        return true;
    }

    endGame(match, winner, points, kind, events) {
        const loser = other(winner);
        match.score[winner] += points;
        match.board.score = { ...match.score };
        match.board.dice = null;
        match.legal = null;
        match.turnCube = null;
        match.offer = null;
        match.result = { winner, points, kind };
        this.emit(match, events, { type: 'game-over', ...match.result });
        if (match.score[winner] >= match.length) {
            match.phase = 'match-over';
            return;
        }
        match.nextCrawford = !match.crawfordDone
            && match.score[winner] === match.length - 1
            && match.score[loser] < match.length - 1;
        match.phase = 'game-over';
    }

    /** What the player in `browser` sees. Seats are 'player1'/'player2'; `you` names theirs. */
    state(browser) {
        const you = this.seatOf(browser);
        if (you) this.seats[you].lastSeen = this.now();
        const seats = Object.fromEntries(SEATS.map((seat) => {
            const taken = this.seats[seat];
            return [seat, taken ? {
                name: taken.name,
                wantLength: taken.wantLength,
                online: !this.isAway(seat)
            } : null];
        }));
        return {
            you, seats, lengths: FRIEND_LENGTHS, plies: this.plies, notice: this.notice,
            adjourned: this.openMatches().filter((open) => open.id !== this.match?.id),
            match: this.match ? this.snapshot(this.match, you) : null
        };
    }

    snapshot(match, you) {
        const { board } = match;
        const decision = (item) => ({
            id: item.id, seat: item.seat, kind: item.kind, action: item.action, best: item.best,
            loss: round3(item.loss), grade: item.grade, marked: item.marked
        });
        const stats = (seat) => {
            const s = match.stats[seat];
            return {
                decisions: s.decisions,
                rated: s.rated,
                flagged: s.flagged,
                pr: performanceRating(s),
                luck: round3(s.luck),
                rolls: s.rolls,
                awesome: s.awesome,
                bestAwesome: s.bestAwesome
            };
        };
        const onTurn = board?.turn ?? null;
        return {
            id: match.id,
            resumed: Boolean(match.resumed),
            seq: match.eventSeq,
            busy: match.busy,
            error: match.error,
            length: match.length,
            names: { ...match.names },
            score: { ...match.score },
            crawford: match.crawford,
            nextCrawford: match.phase === 'game-over' ? match.nextCrawford : false,
            gameNumber: match.gameNumber,
            phase: match.busy ? 'thinking' : match.phase,
            onTurn,
            ogid: board ? this.ogid(match) : null,
            dice: board?.dice ?? null,
            offer: match.offer ? { by: match.offer.by, to: match.offer.to, cube: match.offer.cube } : null,
            legal: !match.busy && match.phase === 'move' && onTurn === you && match.legal
                ? {
                    position: match.legal.position,
                    dice: match.legal.dice,
                    plays: match.legal.plays.map((play) => ({ move: play.move, key: play.key }))
                }
                : null,
            tentative: onTurn !== you ? match.tentative ?? null : null,
            result: match.result,
            recent: { player1: match.recent.player1.map(decision), player2: match.recent.player2.map(decision) },
            stats: { player1: stats('player1'), player2: stats('player2') },
            events: match.events.filter((event) => event.game === match.gameNumber)
        };
    }
}

let shared = null;

function getFriendTable() {
    if (!shared) shared = new FriendTable({ waitMs: 4000 });
    return shared;
}

module.exports = {
    FRIEND_LENGTHS,
    FriendError,
    FriendTable,
    getFriendTable,
    rollsWithChances
};
