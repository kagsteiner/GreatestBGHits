'use strict';

// The app with throwaway data for the browser tests in e2e/: a quiz user, a
// play account with a finished match, and a fake engine at the friend table,
// in matches against the engine and for analyses, with dice that always give 5-1, so
// matches go the same way every time. POST /__e2e/reset clears the table.

const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'second-roll-e2e-'));
process.env.SECOND_ROLL_DATA_DIR = dataDir;
process.env.PLAY_ACCESS_KEY = 'e2e-key';
process.env.LOCAL_ANALYSIS = '1';

const BackgammonBoard = require('../src/board');
const checkerPlay = require('../shared/checkerPlay');
const bgEngine = require('../src/engines/bgEngine');

// Analyses come from the fake engine too, whatever the browser can do.
const engineForAnalyses = fakeEngine();
bgEngine.getClient = () => engineForAnalyses;

const app = require('../server');
const { database, writeQuizzes } = require('../src/storage');
const { createFriendStore } = require('../src/friendStore');
const { createPlayStore } = require('../src/playStore');
const { getFriendTable } = require('../src/friendMatch');
const { getPlayMatches, setPosition } = require('../src/playMatch');

const QUIZ_USER = 'e2euser';
const PLAY_USER = { name: 'e2eplayer', password: 'e2e-test-password' };

/** Plays that are legal from the start with 5-1 and stay so for a while; the first is the best. */
function fakeEngine() {
    const positionOf = (ogid) => {
        const board = BackgammonBoard.fromOgid(ogid);
        return { board, position: checkerPlay.positionFromBoard(board, board.turn) };
    };
    const evaluation = { win: 0.52, gammonWin: 0.14, backgammonWin: 0.01, gammonLoss: 0.12, backgammonLoss: 0.01 };
    return {
        config: { plies: 3, deepPlies: 5 },
        async listLegalPlays({ ogid, dice: given }) {
            const { board, position } = positionOf(ogid);
            // Quizzes keep their dice apart from the position.
            const dice = given || board.dice;
            const plays = ['13/8 6/5', '13/8 8/7', '24/23 13/8', '8/3 6/5', '8/3 8/7', '6/1 6/5']
                .map((move) => ({ move, points: checkerPlay.applyMoveText(position, move) }))
                .filter((play) => play.points);
            return { position, dice: [dice.die1, dice.die2], plays };
        },
        async analyzeChecker({ played, plies = 3 }) {
            const best = { move: '13/8 6/5', equity: 0, evaluation, ply: plies };
            const other = { move: '24/23 13/8', equity: -0.2, evaluation, ply: plies };
            // The engine's move filter left this one at a shallower depth, unless it is the play asked about.
            const shallow = { move: '8/3 6/5', equity: -0.3, evaluation, ply: played === '8/3 6/5' ? plies : 1 };
            return {
                moves: [best, other, shallow],
                played: played ? { move: played, equity: played === best.move ? 0 : -0.2, diff: played === best.move ? 0 : -0.2, evaluation } : null,
                plies,
                legalMoves: 3,
                durationMs: 1
            };
        },
        async analyzeCube({ plies = 3 } = {}) {
            return {
                available: true, decision: 'No double, take', take: 'take', plies, durationMs: 1,
                noDoubleEquity: 0.1, doubleTakeEquity: 0.05, doublePassEquity: 1, evaluation,
                mwc: { noDouble: 0.55, doubleTake: 0.54, doublePass: 0.7 }
            };
        },
        async rollout() {
            const row = (move, cubefulEquity) => ({ move, cubefulEquity, stdError: { cubeful: 0.01 }, trials: 1296, evaluation });
            return {
                moves: [row('13/8 6/5', 0.02), row('24/23 13/8', -0.18)],
                mwc: { cubeful: 0.55 }, stdError: { cubeful: 0.01 }, evaluation, trials: 1296, durationMs: 1
            };
        },
        async rolloutPlays({ plays }) {
            return {
                moves: plays.map((move, index) => ({ move, cubefulEquity: -index / 10, stdError: { cubeful: 0.01 }, trials: 1296, evaluation })),
                durationMs: 1
            };
        },
        getStatus: () => ({ engine: 'fake' })
    };
}

/** A checker quiz. */
function seedQuizzes() {
    const board = BackgammonBoard.starting('player1');
    board.matchLength = 7;
    board.score = { player1: 3, player2: 2 };
    const analysis = { engine: 'darkbghelmet', plies: 3 };
    const candidate = (move, equity) => ({ move, equity, evaluation: null, ply: 3 });
    const checker = {
        id: 'quiz-checker',
        type: 'move',
        active: true,
        analysis,
        ogid: board.toOgid(),
        context: { equityDiff: 0.3, dice: { die1: 5, die2: 1 } },
        best: candidate('13/8 6/5', 0.05),
        user: { name: QUIZ_USER, ...candidate('24/23 13/8', -0.25) },
        higherSample: candidate('13/8 24/23', -0.1),
        lowerSample: candidate('13/7', -0.4),
        quiz: { playCount: 2, correctAnswers: 1 }
    };
    writeQuizzes(QUIZ_USER, { schemaVersion: 2, threshold: 0.08, positions: [checker] });
}

/** A short finished match against the engine, with a marked blunder. */
function seedPlayMatch() {
    const store = createPlayStore(database);
    const { user } = store.register(PLAY_USER.name, PLAY_USER.password);
    const board = BackgammonBoard.starting('player1');
    board.matchLength = 3;
    board.score = { player1: 0, player2: 0 };
    const seats = { you: 'player1', engine: 'player2' };
    const dice = { die1: 5, die2: 1 };
    const log = [{ type: 'opening', you: 5, engine: 1 }];
    const plays = [['you', '13/8 6/5'], ['engine', '13/8 6/5'], ['you', '13/8 24/23'], ['engine', '24/23 13/8']];
    plays.forEach(([who, move], index) => {
        const player = seats[who];
        board.turn = player;
        const before = checkerPlay.positionFromBoard(board, player);
        setPosition(board, player, checkerPlay.applyMoveText(before, move));
        if (who === 'you') {
            log.push({
                type: 'grade', id: `1:${index}`, kind: 'move', action: move, best: '13/8 6/5',
                loss: index === 2 ? 0.2 : 0, grade: index === 2 ? 'blunder' : null, marked: index === 2
            });
        }
        log.push({ type: 'move', who, dice, move, ogid: board.toOgid() });
    });
    log.push({ type: 'game-over', winner: 'you', points: 3, kind: 'single' });
    const id = 'e2e-match';
    store.saveMatch({
        id,
        userId: user.id,
        startedAt: new Date(Date.now() - 3600000).toISOString(),
        finishedAt: new Date().toISOString(),
        status: 'finished',
        length: 3,
        plies: 3,
        score: { you: 3, engine: 0 },
        stats: { decisions: 2, rated: 2, flagged: 1, totalLoss: 0.2, pr: { value: 10.5 } },
        games: [{ number: 1, score: { you: 0, engine: 0 }, crawford: false, log }],
        opponent: 'engine'
    });
    return { token: store.login(PLAY_USER.name, PLAY_USER.password).token, matchId: id };
}

/** A finished match between friends from before games were kept: only its marked decision can be looked at. */
function seedFriendMatch() {
    const board = BackgammonBoard.starting('player1');
    board.matchLength = 3;
    board.score = { player1: 0, player2: 0 };
    board.dice = { die1: 5, die2: 1 };
    const side = (name, score) => ({ name, score, pr: 5, luck: 0.1 });
    createFriendStore(database).saveMatch({
        id: 'e2e-friend-match',
        startedAt: new Date(Date.now() - 7200000).toISOString(),
        finishedAt: new Date(Date.now() - 3600000).toISOString(),
        length: 3,
        player1: side('Karl', 3),
        player2: side('Fred', 1),
        marked: [{
            id: '1:1', seat: 'player1', name: 'Karl', kind: 'move', ogid: board.toOgid({ gameState: 'R' }),
            action: '24/23 13/8', best: '13/8 6/5', loss: 0.2
        }],
        games: null
    });
}

seedFriendMatch();
const fixtures = { quizUser: QUIZ_USER, playKey: process.env.PLAY_ACCESS_KEY, ...seedPlayMatch() };
seedQuizzes();

const dieFive = () => {
    let next = 5;
    return () => {
        const value = next;
        next = next === 5 ? 1 : 5;
        return value;
    };
};
const table = getFriendTable();
table.engineOverride = fakeEngine();
table.randomInt = dieFive();
table.waitMs = Infinity;
const matches = getPlayMatches();
matches.engineOverride = table.engineOverride;
matches.randomInt = dieFive();

app.get('/__e2e/fixtures', (_req, res) => res.json(fixtures));
app.post('/__e2e/reset', (_req, res) => {
    table.seats = { player1: null, player2: null };
    table.match = null;
    table.notice = null;
    table.randomInt = dieFive();
    for (const open of table.openMatches()) table.closeOpen(open);
    matches.matches.clear();
    // An analysis in a test may have updated the quiz.
    seedQuizzes();
    res.json({ ok: true });
});

const PORT = Number(process.env.PORT) || 3055;
const server = app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Browser test server on http://localhost:${PORT}, data in ${dataDir}`);
});

function stop() {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
