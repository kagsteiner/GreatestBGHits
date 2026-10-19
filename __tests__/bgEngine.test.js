'use strict';

const http = require('http');
const BackgammonBoard = require('../src/board');
const {
    BgEngineClient,
    PlayedMoveNotLegalError,
    afterXgidToPoints,
    getConfig,
    toEngineMove,
    toEnginePosition
} = require('../src/engines/bgEngine');

const START_POINTS = [0, -2, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, -5, 5, 0, 0, 0, -3, 0, -5, 0, 0, 0, 0, 2, 0];

describe('toEnginePosition()', () => {
    it('converts the starting position from either player\'s view', () => {
        for (const turn of ['player1', 'player2']) {
            const { position, match, onRoll } = toEnginePosition(BackgammonBoard.starting(turn).toOgid());
            expect(onRoll).toBe(turn);
            expect(position.points).toEqual(START_POINTS);
            expect(match).toEqual({
                length: 0, score: [0, 0], cube: 1, owner: 'center', crawford: false, jacoby: false, beavers: false
            });
        }
    });

    it('maps bars, borne-off checkers, score, cube ownership, and Crawford relative to the player on roll', () => {
        const board = BackgammonBoard.starting('player2');
        // Player 1 has a checker on the bar; player 2 bore one checker off from point 6.
        board.points.player1[24] = 1;
        board.points.player1[25] = 1;
        board.points.player2[6] = 4;
        board.points.player2[0] = 1;
        board.matchLength = 7;
        board.score = { player1: 2, player2: 6 };
        board.cube = 2;
        board.cubeOwner = 'player1';
        const ogid = board.toOgid({ crawford: true });

        const { position, match } = toEnginePosition(ogid);
        expect(position.points[0]).toBe(1);
        expect(position.points[25]).toBe(0);
        expect(position.points[6]).toBe(4);
        expect(position.points[1]).toBe(-1);
        expect(match).toEqual({ length: 7, score: [6, 2], cube: 2, owner: 'opponent', crawford: true });

        const fromPlayer1 = toEnginePosition(ogid, 'player1');
        expect(fromPlayer1.position.points[25]).toBe(1);
        expect(fromPlayer1.position.points[24]).toBe(1);
        expect(fromPlayer1.match).toMatchObject({ score: [2, 6], owner: 'onroll' });
    });
});

describe('afterXgidToPoints()', () => {
    it('reads a position_after (opponent on roll) back from the mover\'s view', () => {
        // Engine output after bar/24 13/10, where the mover had a checker on the bar.
        const points = afterXgidToPoints('XGID=-b----E-C---dE-a-c-e----A-:0:0:1:00:0:0:3:0:10');
        expect(points[25]).toBe(0);
        expect(points[24]).toBe(2);
        expect(points[13]).toBe(4);
        expect(points[10]).toBe(1);
        expect(points[1]).toBe(-1);
        expect(points[12]).toBe(-5);
        expect(points[0]).toBe(0);
        expect(() => afterXgidToPoints('XGID=nonsense')).toThrow('Invalid XGID');
    });
});

describe('toEngineMove()', () => {
    it('translates bar and off and keeps hit markers', () => {
        expect(toEngineMove('25/20* 6/0')).toBe('bar/20* 6/off');
        expect(toEngineMove('13/7 8/7')).toBe('13/7 8/7');
        expect(toEngineMove('')).toBe('');
    });
});

describe('getConfig()', () => {
    it('reads defaults and rejects depths the engine does not support', () => {
        expect(getConfig({ url: 'http://localhost:9/' })).toMatchObject({
            url: 'http://localhost:9', plies: 3, deepPlies: 4
        });
        expect(() => getConfig({ deepPlies: 8 })).toThrow('BG_ENGINE_DEEP_PLIES must be between 1 and 7');
    });
});

describe('BgEngineClient', () => {
    let server;
    let url;
    let handler;
    const requests = [];

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                const parsed = body ? JSON.parse(body) : null;
                requests.push({ method: req.method, path: req.url, body: parsed });
                const reply = (status, json, delayMs = 0) => setTimeout(() => {
                    res.writeHead(status, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(json));
                }, delayMs);
                if (req.url === '/v1/info') {
                    reply(200, { name: 'DarkBGHelmet', version: '0.1.0', network: 'net-a' });
                    return;
                }
                handler(req.url, parsed, reply);
            });
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        url = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(() => new Promise((resolve) => server.close(resolve)));

    beforeEach(() => {
        requests.length = 0;
    });

    const probabilities = {
        win: 0.55, win_gammon: 0.15, win_backgammon: 0.01, lose: 0.45, lose_gammon: 0.1, lose_backgammon: 0.005
    };
    const opening31 = () => {
        const board = BackgammonBoard.starting('player1');
        board.dice = { die1: 3, die2: 1 };
        return board.toOgid();
    };

    it('ranks checker plays, judges the played move, and caches engine info', async () => {
        handler = (path, body, reply) => reply(200, {
            best: '8/5 6/5',
            legal_moves: 16,
            plies: body.options.plies,
            moves: [
                { move: '8/5 6/5', equity: 0.23, diff: 0, plies: 3, probabilities },
                { move: '13/9', equity: -0.02, diff: -0.25, plies: 3, probabilities },
                { move: '24/23 13/10', equity: 0.0, diff: -0.23, plies: 1, probabilities }
            ],
            played: { move: '13/9', rank: 5, equity: -0.02, diff: -0.25, plies: 3, is_best: false },
            time_ms: 12.5
        });
        const client = new BgEngineClient({ url });

        const result = await client.analyzeChecker({ ogid: opening31(), played: '13/10 10/9' });
        await client.analyzeChecker({ ogid: opening31(), played: '13/10 10/9', plies: 4, maxMoves: 5 });

        expect(requests.filter((request) => request.path === '/v1/info')).toHaveLength(1);
        const [first, second] = requests.filter((request) => request.path === '/v1/move');
        expect(first.body).toEqual({
            position: { points: START_POINTS },
            match: { length: 0, score: [0, 0], cube: 1, owner: 'center', crawford: false, jacoby: false, beavers: false },
            dice: [3, 1],
            options: { plies: 3, max_moves: 20 },
            played: '13/10 10/9'
        });
        expect(second.body.options).toEqual({ plies: 4, max_moves: 5 });
        expect(result).toMatchObject({
            engine: 'darkbghelmet',
            plies: 3,
            legalMoves: 16,
            durationMs: 12.5,
            engineMetadata: { name: 'DarkBGHelmet', version: '0.1.0', network: 'net-a', plies: 3 }
        });
        expect(result.moves[0]).toEqual({
            move: '8/5 6/5',
            equity: 0.23,
            diff: 0,
            mwc: null,
            ply: 3,
            evaluation: { win: 0.55, gammonWin: 0.15, backgammonWin: 0.01, gammonLoss: 0.1, backgammonLoss: 0.005 }
        });
        expect(result.played).toMatchObject({ move: '13/9', rank: 5, diff: -0.25, ply: 3, isBest: false });
        expect(result.played.evaluation.win).toBe(0.55);
    });

    it('reports a closed-out roll as one empty play', async () => {
        handler = (path, body, reply) => reply(200, {
            legal_moves: 1, plies: 3, moves: [{ move: '(no move)', equity: -0.5, diff: 0, plies: 3, probabilities }]
        });
        const result = await new BgEngineClient({ url }).analyzeChecker({ ogid: opening31() });
        expect(result.legalMoves).toBe(1);
        expect(result.moves[0].move).toBe('');
        expect(result.played).toBeNull();
        expect(requests.find((request) => request.path === '/v1/move').body.played).toBeUndefined();
    });

    it('lists every legal play at 1-ply with its final position seen from the mover', async () => {
        handler = (path, body, reply) => reply(200, {
            legal_moves: 2,
            plies: 1,
            moves: [
                { move: '8/5 6/5', equity: 0.2, position_after: { xgid: 'XGID=-b----E-C---eE---b-db---B-:0:0:1:00:0:0:0:0:10' } },
                // Not a real play: an unchanged position checks the orientation.
                { move: '13/10 6/5', equity: 0.1, position_after: { xgid: 'XGID=-b----E-C---eE---c-e----B-:0:0:1:00:0:0:0:0:10' } }
            ]
        });
        const result = await new BgEngineClient({ url }).listLegalPlays({ ogid: opening31() });
        const request = requests.find((entry) => entry.path === '/v1/move');
        expect(request.body.options).toEqual({ plies: 1, max_moves: 100000 });
        expect(request.body.dice).toEqual([3, 1]);
        expect(result.position).toEqual(START_POINTS);
        expect(result.dice).toEqual([3, 1]);
        expect(result.plays.map((play) => play.move)).toEqual(['8/5 6/5', '13/10 6/5']);
        expect(result.plays[0].points).toEqual(Object.assign(START_POINTS.slice(), { 8: 2, 6: 4, 5: 2 }));
        expect(result.plays[1].points).toEqual(START_POINTS);
    });

    it('turns an illegal played move into a recognisable error', async () => {
        handler = (path, body, reply) => reply(400, { error: "'played' is not a legal play for these dice: 24/14" });
        const client = new BgEngineClient({ url });
        const error = await client.analyzeChecker({ ogid: opening31(), played: '24/14' }).catch((caught) => caught);
        expect(error).toBeInstanceOf(PlayedMoveNotLegalError);
        expect(error.code).toBe('QUIZ_MOVE_NOT_RECOGNIZED');

        handler = (path, body, reply) => reply(500, { error: 'network file missing' });
        await expect(client.analyzeChecker({ ogid: opening31() })).rejects.toThrow('network file missing');
        expect(client.getStatus().lastError).toBe('network file missing');
    });

    it('rejects positions without dice before calling the engine', async () => {
        const client = new BgEngineClient({ url });
        await expect(client.analyzeChecker({ ogid: BackgammonBoard.starting().toOgid() }))
            .rejects.toThrow('two dice');
        expect(requests).toHaveLength(0);
    });

    it('maps a cube decision and asks for the cube at the requested depth', async () => {
        handler = (path, body, reply) => reply(200, {
            decision: 'Double, take',
            take: 'take',
            cube_available: true,
            equity: { no_double: 0.787, double_take: 0.96, double_pass: 1 },
            mwc: { no_double: 0.37, double_take: 0.39, double_pass: 0.4 },
            probabilities,
            cube_efficiency: 0.77,
            plies: body.options.plies,
            time_ms: 9
        });
        const board = BackgammonBoard.starting('player2');
        board.matchLength = 7;
        board.score = { player1: 5, player2: 3 };

        const result = await new BgEngineClient({ url }).analyzeCube({ ogid: board.toOgid(), plies: 4 });

        const request = requests.find((entry) => entry.path === '/v1/cube');
        expect(request.body.match).toEqual({ length: 7, score: [3, 5], cube: 1, owner: 'center', crawford: false });
        expect(request.body.options).toEqual({ plies: 4, cube_plies: 4 });
        expect(result).toMatchObject({
            available: true,
            decision: 'Double, take',
            take: 'take',
            noDoubleEquity: 0.787,
            doubleTakeEquity: 0.96,
            doublePassEquity: 1,
            mwc: { noDouble: 0.37, doubleTake: 0.39, doublePass: 0.4 },
            cubeEfficiency: 0.77,
            plies: 4
        });
    });

    it('sends one request at a time and limits the queue', async () => {
        let active = 0;
        let maxActive = 0;
        handler = (path, body, reply) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            setTimeout(() => {
                active -= 1;
                reply(200, { legal_moves: 1, plies: 3, moves: [] });
            }, 20);
        };
        const client = new BgEngineClient({ url, maxPending: 3 });
        await client.getInfo();
        const calls = [1, 2, 3].map(() => client.analyzeChecker({ ogid: opening31() }));
        await expect(client.analyzeChecker({ ogid: opening31() })).rejects.toThrow('queue is full');
        await Promise.all(calls);
        expect(maxActive).toBe(1);
        expect(client.getStatus().pending).toBe(0);
    });

    it('times out slow requests', async () => {
        handler = (path, body, reply) => reply(200, { legal_moves: 1, plies: 3, moves: [] }, 300);
        const client = new BgEngineClient({ url, timeoutMs: 50 });
        await client.getInfo();
        await expect(client.analyzeChecker({ ogid: opening31() })).rejects.toThrow('timed out after 50ms');
    });

    it('retries once when the engine is not reachable, then reports it', async () => {
        const closed = http.createServer();
        await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
        const deadUrl = `http://127.0.0.1:${closed.address().port}`;
        await new Promise((resolve) => closed.close(resolve));

        const client = new BgEngineClient({ url: deadUrl, retryDelayMs: 10 });
        await expect(client.getInfo()).rejects.toThrow(`Engine at ${deadUrl} is unreachable: ECONNREFUSED`);
        expect(client.getStatus().lastError).toMatch('unreachable');
    });
});
