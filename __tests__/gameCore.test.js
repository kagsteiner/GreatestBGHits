'use strict';

jest.mock('../DailyGammonRetriever', () => jest.fn());
jest.mock('../backgammon-parser', () => jest.fn());

const mockStorage = {
    normalizeUsername: jest.fn(u => (typeof u === 'string' ? u.trim().toLowerCase() : '')),
    readQuizzes: jest.fn(),
    writeQuizzes: jest.fn(),
    readAnalyzedMatches: jest.fn(),
    writeAnalyzedMatches: jest.fn(),
    updateUserData: jest.fn(),
    defaultQuizzesPayload: jest.fn(() => ({
        schemaVersion: 2,
        threshold: 0.08,
        positions: []
    })),
};
jest.mock('../src/storage', () => mockStorage);

const mockEngine = {
    config: { plies: 3, deepPlies: 5 },
    analyzeChecker: jest.fn(),
    analyzeCube: jest.fn()
};
jest.mock('../src/engines/bgEngine', () => ({
    ...jest.requireActual('../src/engines/bgEngine'),
    getClient: () => mockEngine
}));
const BackgammonBoard = require('../src/board');

const evaluation = {
    win: 0.55,
    gammonWin: 0.15,
    backgammonWin: 0.02,
    gammonLoss: 0.1,
    backgammonLoss: 0.01
};
const engineMetadata = { name: 'DarkBGHelmet', version: '0.1.0', network: 'net-a', plies: 3 };
const candidate = (move, equity, ply = 3) => ({ move, equity, ply, evaluation });
const checkerResult = (moves, played, extra = {}) => ({
    engine: 'darkbghelmet',
    plies: 3,
    legalMoves: moves.length,
    moves,
    played,
    engineMetadata,
    ...extra
});
const playedResult = (move, equity, bestEquity, rank) => ({
    move, equity, diff: equity - bestEquity, rank, ply: 3, isBest: rank === 1, evaluation
});

const {
    normalizeMoveText,
    getNextQuiz,
    getQuizById,
    recordQuizResult,
    deepAnalyzeQuiz,
    analyzeQuizPosition,
    loadQuizzes,
    saveQuizzes,
    buildGamePositions
} = require('../src/gameCore');

beforeEach(() => {
    jest.clearAllMocks();
});

describe('normalizeMoveText()', () => {
    it('trims whitespace', () => {
        expect(normalizeMoveText('  13/7  ')).toBe('13/7');
    });

    it('collapses multiple spaces', () => {
        expect(normalizeMoveText('13/7   8/7')).toBe('13/7 8/7');
    });

    it('handles tabs and mixed whitespace', () => {
        expect(normalizeMoveText('13/7\t\t8/7')).toBe('13/7 8/7');
    });

    it('returns empty string for non-string', () => {
        expect(normalizeMoveText(null)).toBe('');
        expect(normalizeMoveText(undefined)).toBe('');
        expect(normalizeMoveText(42)).toBe('');
    });

    it('returns empty string for empty input', () => {
        expect(normalizeMoveText('')).toBe('');
    });
});

describe('buildGamePositions()', () => {
    const forcedPassAnalysis = checkerResult([candidate('', 0)], null, { legalMoves: 1 });
    const cubeAnalysis = {
        engine: 'darkbghelmet',
        available: true,
        decision: 'Double, take',
        take: 'take',
        noDoubleEquity: 0.1,
        doubleTakeEquity: 0.3,
        doublePassEquity: 1,
        plies: 3,
        engineMetadata
    };

    it('skips the opening roll and creates a missed-double quiz before a later roll', async () => {
        mockEngine.analyzeChecker.mockResolvedValue(forcedPassAnalysis);
        mockEngine.analyzeCube.mockResolvedValue(cubeAnalysis);
        const match = {
            matchLength: 5,
            players: { player1: 'Alice', player2: 'Bob' },
            games: [{
                gameNumber: 1,
                startingScore: { player1: 0, player2: 0 },
                moves: [{
                    moveNumber: 1,
                    player1: { type: 'move', dice: { die1: 3, die2: 1 }, moves: [] },
                    player2: { type: 'move', dice: { die1: 4, die2: 2 }, moves: [] }
                }]
            }]
        };

        const result = await buildGamePositions(match);

        expect(mockEngine.analyzeCube).toHaveBeenCalledTimes(1);
        const cubeRequest = mockEngine.analyzeCube.mock.calls[0][0];
        expect(cubeRequest.player).toBe('player2');
        const cubeBoard = BackgammonBoard.fromOgid(cubeRequest.ogid);
        expect(cubeBoard).toMatchObject({ turn: 'player2', cube: 1, cubeOwner: null, matchLength: 5, dice: null });
        expect(result.positions).toHaveLength(1);
        expect(result.positions[0]).toMatchObject({
            type: 'cube-offer',
            best: { action: 'double' },
            user: { name: 'Bob', action: 'no-double' },
            analysis: { engine: 'darkbghelmet', network: 'net-a', plies: 3 }
        });
    });

    it('transfers cube ownership after a take before checker analysis continues', async () => {
        mockEngine.analyzeChecker.mockResolvedValue(forcedPassAnalysis);
        mockEngine.analyzeCube.mockResolvedValue(cubeAnalysis);
        const match = {
            matchLength: 7,
            players: { player1: 'Alice', player2: 'Bob' },
            games: [{
                gameNumber: 1,
                startingScore: { player1: 0, player2: 0 },
                moves: [
                    {
                        moveNumber: 1,
                        player1: { type: 'move', dice: { die1: 3, die2: 1 }, moves: [] },
                        player2: { type: 'double', value: 2 }
                    },
                    {
                        moveNumber: 2,
                        player1: { type: 'take' },
                        player2: { type: 'move', dice: { die1: 4, die2: 2 }, moves: [] }
                    }
                ]
            }]
        };

        const result = await buildGamePositions(match);

        const continuedBoard = BackgammonBoard.fromOgid(mockEngine.analyzeChecker.mock.calls[1][0].ogid);
        expect(continuedBoard.cube).toBe(2);
        expect(continuedBoard.cubeOwner).toBe('player1');
        // Doubling was correct, so only Alice's take/pass decision is graded;
        // taking was correct as well.
        expect(result.positions).toEqual([]);
    });

    it('creates a take/pass quiz when the responder passes a take', async () => {
        mockEngine.analyzeChecker.mockResolvedValue(forcedPassAnalysis);
        mockEngine.analyzeCube.mockResolvedValue(cubeAnalysis);
        const match = {
            matchLength: 7,
            players: { player1: 'Alice', player2: 'Bob' },
            games: [{
                gameNumber: 1,
                startingScore: { player1: 0, player2: 0 },
                moves: [
                    {
                        moveNumber: 1,
                        player1: { type: 'move', dice: { die1: 3, die2: 1 }, moves: [] },
                        player2: { type: 'double', value: 2 }
                    },
                    { moveNumber: 2, player1: { type: 'drop' } }
                ]
            }]
        };

        const result = await buildGamePositions(match, { userName: 'Alice' });

        expect(result.positions).toHaveLength(1);
        expect(result.positions[0]).toMatchObject({
            type: 'cube-response',
            best: { action: 'take', equity: -0.3 },
            user: { name: 'Alice', action: 'pass', equity: -1 },
            context: { onRoll: 'player2', offeredBy: 'player2' }
        });
        expect(result.positions[0].context.equityDiff).toBeCloseTo(0.7);
    });

    it('marks Crawford positions and never asks the cube engine in the Crawford game', async () => {
        mockEngine.analyzeChecker.mockResolvedValue(forcedPassAnalysis);
        const match = {
            matchLength: 5,
            players: { player1: 'Alice', player2: 'Bob' },
            games: [{
                gameNumber: 4,
                startingScore: { player1: 4, player2: 2 },
                moves: [{
                    moveNumber: 1,
                    player1: { type: 'move', dice: { die1: 3, die2: 1 }, moves: [] },
                    player2: { type: 'move', dice: { die1: 4, die2: 2 }, moves: [] }
                }]
            }]
        };

        await buildGamePositions(match);

        expect(mockEngine.analyzeCube).not.toHaveBeenCalled();
        expect(mockEngine.analyzeChecker.mock.calls[1][0].ogid.split(':')[8]).toBe('5C');
    });

    it('analyzes and tags Nackgammon positions from the Nack starting board', async () => {
        mockEngine.analyzeChecker.mockImplementation(async ({ played }) => (played === '24/18 18/14'
            ? checkerResult(
                [candidate('13/7 8/2', 0.2), candidate('24/14', 0.0)],
                playedResult('24/14', 0.0, 0.2, 2)
            )
            : checkerResult([candidate(played, 0.1)], playedResult(played, 0.1, 0.1, 1))));
        const match = {
            matchLength: 1,
            variant: 'nackgammon',
            players: { player1: 'Alice', player2: 'Bob' },
            games: [{
                gameNumber: 1,
                variant: 'nackgammon',
                startingScore: { player1: 0, player2: 0 },
                moves: [{
                    moveNumber: 2,
                    player1: {
                        type: 'move',
                        dice: { die1: 6, die2: 4 },
                        moves: [
                            { from: 24, to: 18, hit: false },
                            { from: 18, to: 14, hit: false }
                        ]
                    },
                    player2: { type: 'no_move' }
                }]
            }]
        };

        const result = await buildGamePositions(match, { threshold: 0.08 });
        const request = mockEngine.analyzeChecker.mock.calls[0][0];
        const expectedBoard = BackgammonBoard.startingNackgammon();
        expectedBoard.dice = { die1: 6, die2: 4 };
        expectedBoard.matchLength = 1;

        expect(request).toMatchObject({ ogid: expectedBoard.toOgid(), played: '24/18 18/14' });
        expect(result.positions).toHaveLength(1);
        expect(result.positions[0].variant).toBe('nackgammon');
        expect(result.positions[0].best).toMatchObject({ move: '13/7 8/2', ply: 3 });
        expect(result.positions[0].user).toMatchObject({ name: 'Alice', move: '24/14', rank: 2 });
        expect(result.positions[0].best.evaluation.gammonWin).toBe(0.15);
    });

    it('propagates engine failures instead of silently completing a match', async () => {
        mockEngine.analyzeChecker.mockRejectedValue(new Error('Engine at http://127.0.0.1:3050 is unreachable'));
        const match = {
            matchLength: 1,
            players: { player1: 'Alice', player2: 'Bob' },
            games: [{
                gameNumber: 1,
                startingScore: { player1: 0, player2: 0 },
                moves: [{
                    moveNumber: 1,
                    player1: {
                        type: 'move',
                        dice: { die1: 3, die2: 1 },
                        moves: [{ from: 8, to: 5 }, { from: 6, to: 5 }]
                    },
                    player2: { type: 'no_move' }
                }]
            }]
        };

        await expect(buildGamePositions(match)).rejects.toThrow('unreachable');
    });

    it('recognizes a forced pass and does not create a quiz for it', async () => {
        mockEngine.analyzeChecker.mockResolvedValue(forcedPassAnalysis);
        const match = {
            matchLength: 21,
            players: { player1: 'Alice', player2: 'Bob' },
            games: [{
                gameNumber: 1,
                startingScore: { player1: 0, player2: 0 },
                moves: [{
                    moveNumber: 6,
                    player1: {
                        type: 'move',
                        dice: { die1: 6, die2: 6 },
                        moves: []
                    },
                    player2: { type: 'no_move' }
                }]
            }]
        };

        const result = await buildGamePositions(match, { userName: 'Alice' });

        expect(mockEngine.analyzeChecker).toHaveBeenCalledTimes(1);
        expect(mockEngine.analyzeChecker.mock.calls[0][0].played).toBe('');
        expect(result.positions).toEqual([]);
    });
});

describe('loadQuizzes()', () => {
    it('returns normalized quiz data from storage', async () => {
        mockStorage.readQuizzes.mockReturnValue({
            schemaVersion: 2,
            threshold: 0.08,
            positions: [
                {
                    ogid: 'test:id',
                    context: { equityDiff: 0.2, player: 'player1', gameNumber: 1, plyIndex: 1 },
                    user: { name: 'alice' }
                }
            ]
        });

        const result = await loadQuizzes('alice');
        expect(result.schemaVersion).toBe(2);
        expect(result.threshold).toBe(0.08);
        expect(result.positions).toHaveLength(1);
        expect(result.positions[0].quiz).toBeDefined();
        expect(result.positions[0].quiz.playCount).toBe(0);
        expect(result.positions[0].id).toBeDefined();
    });

    it('refuses data that has not completed the schema migration', async () => {
        mockStorage.readQuizzes.mockReturnValue(null);
        await expect(loadQuizzes('alice')).rejects.toThrow('schema is not version 2');
    });
});

describe('saveQuizzes()', () => {
    it('atomically preserves a concurrently reanalyzed record while adding new quizzes', async () => {
        const reanalyzed = {
            id: 'existing',
            ogid: 'native',
            active: true,
            analysis: { engine: 'darkbghelmet', network: 'net-a' },
            best: { move: '8/5 6/5' },
            quiz: { playCount: 4, correctAnswers: 2 }
        };
        mockStorage.updateUserData.mockImplementation((_key, updater) => updater({
            quizzes: { schemaVersion: 2, threshold: 0.08, positions: [reanalyzed] },
            analyzedMatches: { matches: ['123'] }
        }));

        const saved = await saveQuizzes('alice', {
            schemaVersion: 2,
            threshold: 0.08,
            positions: [
                { id: 'existing', ogid: 'stale', quiz: { playCount: 3, correctAnswers: 1 } },
                { id: 'new', ogid: 'new', quiz: { playCount: 0, correctAnswers: 0 } }
            ]
        });

        expect(saved.positions).toHaveLength(2);
        expect(saved.positions[0]).toMatchObject({
            id: 'existing',
            ogid: 'native',
            best: { move: '8/5 6/5' },
            analysis: { engine: 'darkbghelmet' },
            quiz: { playCount: 4, correctAnswers: 2 }
        });
        expect(saved.positions[1].id).toBe('new');
    });
});

describe('getNextQuiz()', () => {
    it('selects the quiz with highest importance score', async () => {
        mockStorage.readQuizzes.mockReturnValue({
            schemaVersion: 2,
            positions: [
                {
                    id: 'easy',
                    active: true,
                    analysis: { engine: 'darkbghelmet' },
                    ogid: 'a:b',
                    context: { equityDiff: 0.1 },
                    user: { name: 'alice' },
                    quiz: { playCount: 5, correctAnswers: 4 }
                },
                {
                    id: 'hard',
                    active: true,
                    analysis: { engine: 'darkbghelmet' },
                    ogid: 'c:d',
                    context: { equityDiff: 0.5 },
                    user: { name: 'alice' },
                    quiz: { playCount: 0, correctAnswers: 0 }
                }
            ]
        });

        const quiz = await getNextQuiz('alice');
        expect(quiz).not.toBeNull();
        expect(quiz.id).toBe('hard');
    });

    it('returns null when no quizzes exist', async () => {
        mockStorage.readQuizzes.mockReturnValue({ schemaVersion: 2, positions: [] });
        const quiz = await getNextQuiz('alice');
        expect(quiz).toBeNull();
    });

    it('does not serve quizzes until they have been reanalysed with the engine', async () => {
        mockStorage.readQuizzes.mockReturnValue({
            schemaVersion: 2,
            positions: [{
                id: 'pending',
                active: true,
                ogid: 'a:b',
                context: { equityDiff: 0.5 },
                user: { name: 'alice' },
                quiz: { playCount: 0, correctAnswers: 0 }
            }]
        });
        await expect(getNextQuiz('alice')).resolves.toBeNull();
    });

    it('respects player filter', async () => {
        mockStorage.readQuizzes.mockReturnValue({
            schemaVersion: 2,
            positions: [
                {
                    id: 'q1',
                    active: true,
                    analysis: { engine: 'darkbghelmet' },
                    ogid: 'a:b',
                    context: { equityDiff: 0.5 },
                    user: { name: 'alice' },
                    quiz: { playCount: 0, correctAnswers: 0 }
                },
                {
                    id: 'q2',
                    active: true,
                    analysis: { engine: 'darkbghelmet' },
                    ogid: 'c:d',
                    context: { equityDiff: 0.5 },
                    user: { name: 'bob' },
                    quiz: { playCount: 0, correctAnswers: 0 }
                }
            ]
        });

        const quiz = await getNextQuiz('alice', 'bob');
        expect(quiz).not.toBeNull();
        expect(quiz.id).toBe('q2');
    });

    it('respects match filter', async () => {
        mockStorage.readQuizzes.mockReturnValue({
            schemaVersion: 2,
            positions: [
                {
                    id: 'q1',
                    active: true,
                    analysis: { engine: 'darkbghelmet' },
                    ogid: 'a:b',
                    context: { equityDiff: 0.5 },
                    user: { name: 'alice' },
                    quiz: { playCount: 0, correctAnswers: 0 },
                    dgGameId: '111'
                },
                {
                    id: 'q2',
                    active: true,
                    analysis: { engine: 'darkbghelmet' },
                    ogid: 'c:d',
                    context: { equityDiff: 0.5 },
                    user: { name: 'alice' },
                    quiz: { playCount: 0, correctAnswers: 0 },
                    dgGameId: '222'
                }
            ]
        });

        const quiz = await getNextQuiz('alice', null, '222');
        expect(quiz.id).toBe('q2');
    });

    it('filters training modes and alternates categories in mixed mode', async () => {
        mockStorage.readQuizzes.mockReturnValue({
            schemaVersion: 2,
            positions: [
                {
                    id: 'checker', type: 'move', active: true,
                    analysis: { engine: 'darkbghelmet' },
                    context: { equityDiff: 0.4 }, user: { name: 'alice' },
                    quiz: { playCount: 0, correctAnswers: 0 }
                },
                {
                    id: 'cube', type: 'cube-offer', active: true,
                    analysis: { engine: 'darkbghelmet' },
                    context: { equityDiff: 0.2 }, user: { name: 'alice' },
                    quiz: { playCount: 0, correctAnswers: 0 }
                }
            ]
        });

        await expect(getNextQuiz('alice', null, null, 'checker')).resolves.toMatchObject({ id: 'checker' });
        await expect(getNextQuiz('alice', null, null, 'cube')).resolves.toMatchObject({ id: 'cube' });
        await expect(getNextQuiz('alice', null, null, 'mixed', 'checker')).resolves.toMatchObject({ id: 'cube' });
        await expect(getNextQuiz('alice', null, null, 'mixed', 'cube')).resolves.toMatchObject({ id: 'checker' });
    });
});

describe('getQuizById()', () => {
    it('returns the quiz with matching id', async () => {
        mockStorage.readQuizzes.mockReturnValue({
            schemaVersion: 2,
            positions: [
                {
                    id: 'abc123',
                    ogid: 'a:b',
                    context: { equityDiff: 0.2, player: 'player1', gameNumber: 1, plyIndex: 1 },
                    user: { name: 'alice' }
                }
            ]
        });

        const quiz = await getQuizById('alice', 'abc123');
        expect(quiz).not.toBeNull();
        expect(quiz.id).toBe('abc123');
    });

    it('returns null for unknown id', async () => {
        mockStorage.readQuizzes.mockReturnValue({ schemaVersion: 2, positions: [] });
        const quiz = await getQuizById('alice', 'nonexistent');
        expect(quiz).toBeNull();
    });

    it('returns null for invalid id', async () => {
        const quiz = await getQuizById('alice', null);
        expect(quiz).toBeNull();
    });
});

describe('recordQuizResult()', () => {
    it('increments playCount and correctAnswers on correct answer', async () => {
        const positions = [{
            id: 'q1',
            ogid: 'a:b',
            context: { equityDiff: 0.2, player: 'player1', gameNumber: 1, plyIndex: 1 },
            user: { name: 'alice' },
            quiz: { playCount: 2, correctAnswers: 1 }
        }];

        mockStorage.updateUserData.mockImplementation((_key, updater) => {
            const current = {
                quizzes: { positions },
                analyzedMatches: { matches: [] }
            };
            const result = updater(current);
            return result;
        });

        const result = await recordQuizResult('alice', 'q1', true);
        expect(result).not.toBeNull();

        const updaterCall = mockStorage.updateUserData.mock.calls[0];
        expect(updaterCall[0]).toBe('alice');
    });

    it('returns null for unknown quiz id', async () => {
        mockStorage.updateUserData.mockImplementation((_key, updater) => {
            const current = {
                quizzes: { positions: [] },
                analyzedMatches: { matches: [] }
            };
            return updater(current);
        });

        const result = await recordQuizResult('alice', 'nonexistent', true);
        expect(result).toBeNull();
    });

    it('sets playCount and correctAnswers to 100 when ignored', async () => {
        const positions = [{
            id: 'q1',
            ogid: 'a:b',
            context: { equityDiff: 0.2 },
            user: { name: 'alice' },
            quiz: { playCount: 0, correctAnswers: 0 }
        }];
        let savedData;
        mockStorage.updateUserData.mockImplementation((_key, updater) => {
            const current = {
                quizzes: { positions: JSON.parse(JSON.stringify(positions)) },
                analyzedMatches: { matches: [] }
            };
            savedData = updater(current);
            return savedData;
        });

        const result = await recordQuizResult('alice', 'q1', false, true);
        expect(result).not.toBeNull();
        expect(result.quiz.playCount).toBe(100);
        expect(result.quiz.correctAnswers).toBe(100);
    });
});

describe('deepAnalyzeQuiz()', () => {
    it('re-analyses at the deep depth, keeps answers given meanwhile, and preserves a snapshot', async () => {
        const original = {
            id: 'q-deep',
            type: 'move',
            ogid: 'invalid:test-ogid',
            active: true,
            best: candidate('13/7 8/7', 0.1),
            user: { name: 'alice', ...candidate('24/18 13/11', -0.2) },
            context: {
                equityDiff: 0.3,
                player: 'player1',
                dice: { die1: 6, die2: 2 },
                plyIndex: 4
            },
            analysis: { engine: 'darkbghelmet', network: 'net-a', plies: 3 },
            quiz: { playCount: 0, correctAnswers: 0 }
        };
        const quizzes = { schemaVersion: 2, threshold: 0.08, positions: [original] };
        mockStorage.readQuizzes.mockReturnValue(quizzes);
        mockStorage.updateUserData.mockImplementation((_key, updater) => updater({
            quizzes: {
                ...quizzes,
                positions: [{ ...original, quiz: { playCount: 1, correctAnswers: 1 } }]
            },
            analyzedMatches: { matches: [] }
        }));
        mockEngine.analyzeChecker.mockImplementation(async ({ played, plies }) => ({
            ...checkerResult(
                [candidate('13/7 8/7', 0.18, plies), candidate('24/18 13/11', -0.11, plies)],
                { ...playedResult(played, played === '24/18 13/11' ? -0.11 : 0.18, 0.18, 2), ply: plies }
            ),
            plies,
            engineMetadata: { ...engineMetadata, plies }
        }));

        const result = await deepAnalyzeQuiz('alice', 'q-deep');

        expect(mockEngine.analyzeChecker).toHaveBeenCalledWith({
            ogid: original.ogid,
            dice: { die1: 6, die2: 2 },
            plies: 5,
            played: '24/18 13/11'
        });
        expect(result.analysis).toMatchObject({ engine: 'darkbghelmet', plies: 5 });
        expect(result.context.equityDiff).toBeCloseTo(0.29);
        expect(result.quiz).toEqual({ playCount: 1, correctAnswers: 1 });
        expect(result.deepAnalysis).toMatchObject({
            status: 'complete', engine: 'darkbghelmet', network: 'net-a', plies: 5
        });
        expect(result.fastAnalysis.analysis.plies).toBe(3);
    });

    it('returns an already completed deep analysis without running the engine again', async () => {
        const completed = { id: 'done', deepAnalysis: { status: 'complete' } };
        mockStorage.readQuizzes.mockReturnValue({ schemaVersion: 2, positions: [completed] });

        await expect(deepAnalyzeQuiz('alice', 'done')).resolves.toBe(completed);
        expect(mockEngine.analyzeChecker).not.toHaveBeenCalled();
        expect(mockEngine.analyzeCube).not.toHaveBeenCalled();
    });
});

describe('analyzeQuizPosition()', () => {
    const ogid = (() => {
        const board = BackgammonBoard.starting('player1');
        board.dice = null;
        return board.toOgid();
    })();
    const checkerQuiz = () => ({
        id: 'q-panel',
        type: 'move',
        ogid,
        active: true,
        best: candidate('13/7 8/7', 0.1),
        user: { name: 'alice', ...candidate('24/18 13/11', -0.2) },
        context: { equityDiff: 0.3, player: 'player1', dice: { die1: 6, die2: 2 }, plyIndex: 4 },
        analysis: { engine: 'darkbghelmet', network: 'net-a', plies: 3 },
        quiz: { playCount: 1, correctAnswers: 0 }
    });
    const engineAnswer = async ({ played, plies }) => ({
        ...checkerResult(
            [
                { ...candidate('13/7 8/7', 0.18, plies), points: [1] },
                { ...candidate('24/18 13/11', -0.11, plies), points: [2] },
                // The engine searches the played play fully, the rest only shallowly.
                candidate('24/16', -0.3, played === '24/16' ? plies : 1)
            ],
            { ...playedResult(played, played === '13/7 8/7' ? 0.18 : -0.11, 0.18, 2), ply: plies }
        ),
        plies,
        engineMetadata: { ...engineMetadata, plies }
    });

    afterEach(() => {
        mockEngine.config.deepPlies = 5;
    });

    it('analyses all plays with the answer searched fully, without saving below the deep depth', async () => {
        mockStorage.readQuizzes.mockReturnValue({ schemaVersion: 2, positions: [checkerQuiz()] });
        mockEngine.analyzeChecker.mockImplementation(engineAnswer);

        const result = await analyzeQuizPosition('alice', 'q-panel', { plies: 3, answer: '13/7 8/7' });

        expect(mockEngine.analyzeChecker).toHaveBeenCalledWith({
            ogid, dice: { die1: 6, die2: 2 }, played: '13/7 8/7', plies: 3, maxMoves: 10
        });
        expect(result.quiz).toBeNull();
        expect(result.answer).toBe('13/7 8/7');
        expect(result.analysis).toMatchObject({ kind: 'move', plies: 3 });
        expect(result.analysis.moves[0]).not.toHaveProperty('points');
        expect(mockStorage.updateUserData).not.toHaveBeenCalled();
    });

    it('saves the analysis at the deep depth as the deep analysis and searches the answer too', async () => {
        mockEngine.config.deepPlies = 4;
        const quiz = checkerQuiz();
        const quizzes = { schemaVersion: 2, threshold: 0.08, positions: [quiz] };
        mockStorage.readQuizzes.mockReturnValue(quizzes);
        mockStorage.updateUserData.mockImplementation((_key, updater) => updater({
            quizzes, analyzedMatches: { matches: [] }
        }));
        mockEngine.analyzeChecker.mockImplementation(engineAnswer);

        const result = await analyzeQuizPosition('alice', 'q-panel', { plies: 4, answer: '24/16' });

        expect(result.quiz.deepAnalysis).toMatchObject({ status: 'complete', plies: 4 });
        expect(result.analysis).toMatchObject({ kind: 'move', plies: 4 });
        // The match play is ranked by the saved analysis; the answer is searched on its own.
        expect(mockEngine.analyzeChecker).toHaveBeenCalledWith(expect.objectContaining({ played: '24/18 13/11', plies: 4 }));
        expect(mockEngine.analyzeChecker).toHaveBeenCalledWith(expect.objectContaining({ played: '24/16', plies: 4, maxMoves: 1000 }));
        expect(result.answer).toBe('24/16');
        expect(result.analysis.moves.find((move) => move.move === '24/16').ply).toBe(4);
    });

    it('does not save again once the quiz has its deep analysis', async () => {
        mockEngine.config.deepPlies = 4;
        mockStorage.readQuizzes.mockReturnValue({
            schemaVersion: 2, positions: [{ ...checkerQuiz(), deepAnalysis: { status: 'complete', plies: 4 } }]
        });
        mockEngine.analyzeChecker.mockImplementation(engineAnswer);

        const result = await analyzeQuizPosition('alice', 'q-panel', { plies: 4, answer: '24/18 13/11' });

        expect(result.quiz).toBeNull();
        expect(mockStorage.updateUserData).not.toHaveBeenCalled();
    });

    it('analyses a cube quiz for the doubler', async () => {
        mockStorage.readQuizzes.mockReturnValue({
            schemaVersion: 2,
            positions: [{
                id: 'q-cube', type: 'cube-response', ogid, active: true,
                context: { player: 'player2', offeredBy: 'player1', cubeValue: 1 },
                analysis: { plies: 3 }
            }]
        });
        mockEngine.analyzeCube.mockResolvedValue({
            decision: 'Double, take', noDoubleEquity: 0.5, doubleTakeEquity: 0.6, doublePassEquity: 1,
            evaluation, plies: 3, durationMs: 5
        });

        const result = await analyzeQuizPosition('alice', 'q-cube', { plies: 3 });

        expect(mockEngine.analyzeCube).toHaveBeenCalledWith({ ogid, player: 'player1', plies: 3 });
        expect(result.analysis).toMatchObject({
            kind: 'cube', decision: 'Double, take', equity: { noDouble: 0.5, doubleTake: 0.6, doublePass: 1 }
        });
    });

    it('rejects analyses the quiz or the server does not offer', async () => {
        mockStorage.readQuizzes.mockReturnValue({
            schemaVersion: 2,
            positions: [checkerQuiz(), { id: 'q-cube', type: 'cube-offer', ogid, context: { player: 'player1' } }]
        });
        await expect(analyzeQuizPosition('alice', 'q-cube', { kind: 'deepen', move: '24/16' }))
            .rejects.toThrow("A cube quiz has no 'deepen' analysis");
        await expect(analyzeQuizPosition('alice', 'q-panel', { plies: 6 })).rejects.toThrow('Depth must be 1 to 4 plies');
        await expect(analyzeQuizPosition('alice', 'missing', {})).resolves.toBeNull();
    });

    it('runs one analysis per user at a time', async () => {
        mockStorage.readQuizzes.mockReturnValue({ schemaVersion: 2, positions: [checkerQuiz()] });
        let finish;
        mockEngine.analyzeChecker.mockImplementationOnce((request) => new Promise((resolve) => {
            finish = () => resolve(engineAnswer(request));
        }));

        const first = analyzeQuizPosition('alice', 'q-panel', { plies: 3 });
        await new Promise((resolve) => setImmediate(resolve));
        await expect(analyzeQuizPosition('alice', 'q-panel', { plies: 2 }))
            .rejects.toMatchObject({ status: 429 });
        finish();
        await expect(first).resolves.toMatchObject({ quiz: null });
    });
});
