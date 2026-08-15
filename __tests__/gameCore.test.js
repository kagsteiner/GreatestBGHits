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
    getQuizByIdFromAllUsers: jest.fn()
};
jest.mock('../src/storage', () => mockStorage);

jest.mock('../src/engines/analysisEngine', () => jest.fn());
const analyzePosition = require('../src/engines/analysisEngine');
analyzePosition.analyzeCube = jest.fn();
const BackgammonBoard = require('../src/board');

const evaluation = {
    win: 0.55,
    gammonWin: 0.15,
    backgammonWin: 0.02,
    gammonLoss: 0.1,
    backgammonLoss: 0.01
};
const candidate = (move, equity) => ({ move, equity, evaluation, resultingOgid: 'result', ply: 2 });

const {
    normalizeMoveText,
    getNextQuiz,
    getQuizById,
    recordQuizResult,
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
    const forcedPassAnalysis = {
        moves: [candidate('', 0)],
        engineMetadata: {
            model: { id: 'fox-v0.3', name: 'FOX v0.3' },
            hashes: { model: 'hash' },
            engineVersion: 'test',
            ply: 2
        }
    };
    const cubeAnalysis = {
        ogid: 'cube-ogid',
        available: true,
        action: 'Double/Take',
        shouldDouble: true,
        shouldTake: true,
        noDoubleEquity: 0.1,
        doubleTakeEquity: 0.3,
        doublePassEquity: 1,
        noDoubleNormEq: 0.1,
        doubleTakeNormEq: 0.3,
        doublePassNormEq: 1,
        engineMetadata: {
            model: { id: 'fox-v0.3', name: 'FOX v0.3' },
            hashes: { model: 'hash' },
            engineVersion: 'test',
            cubePly: 2
        }
    };

    it('skips the opening roll and creates a missed-double quiz before a later roll', async () => {
        analyzePosition.mockResolvedValue(forcedPassAnalysis);
        analyzePosition.analyzeCube.mockResolvedValue(cubeAnalysis);
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

        expect(analyzePosition.analyzeCube).toHaveBeenCalledTimes(1);
        expect(analyzePosition.analyzeCube.mock.calls[0][0]).toMatchObject({
            player: 'player2', cubeValue: 1, cubeOwner: null, matchLength: 5
        });
        expect(result.positions).toHaveLength(1);
        expect(result.positions[0]).toMatchObject({
            type: 'cube-offer',
            best: { action: 'double' },
            user: { name: 'Bob', action: 'no-double' }
        });
    });

    it('transfers cube ownership after a take before checker analysis continues', async () => {
        analyzePosition.mockResolvedValue(forcedPassAnalysis);
        analyzePosition.analyzeCube.mockResolvedValue(cubeAnalysis);
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

        await buildGamePositions(match);

        const continuedBoard = BackgammonBoard.fromOgid(analyzePosition.mock.calls[1][0].ogid);
        expect(continuedBoard.cube).toBe(2);
        expect(continuedBoard.cubeOwner).toBe('player1');
    });

    it('marks Crawford positions and never asks the cube engine in the Crawford game', async () => {
        analyzePosition.mockResolvedValue(forcedPassAnalysis);
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

        expect(analyzePosition.analyzeCube).not.toHaveBeenCalled();
        expect(analyzePosition.mock.calls[1][0].ogid.split(':')[8]).toBe('5C');
    });

    it('analyzes and tags Nackgammon positions from the Nack starting board', async () => {
        analyzePosition.mockResolvedValue({
            moves: [
                candidate('13/7 8/2', 0.2),
                candidate('24/18 18/14', 0.0)
            ],
            engineMetadata: {
                model: { id: 'aureus-v0.1', name: 'Aureus v0.1' },
                hashes: { model: 'hash' },
                engineVersion: 'test',
                ply: 2
            }
        });
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
        const analyzedOgid = analyzePosition.mock.calls[0][0].ogid;
        const expectedBoard = BackgammonBoard.startingNackgammon();
        expectedBoard.dice = { die1: 6, die2: 4 };
        expectedBoard.matchLength = 1;

        expect(analyzedOgid).toBe(expectedBoard.toOgid());
        expect(result.positions).toHaveLength(1);
        expect(result.positions[0].variant).toBe('nackgammon');
        expect(result.positions[0].best.evaluation.gammonWin).toBe(0.15);
        expect(result.positions[0].analysis.model.id).toBe('aureus-v0.1');
    });

    it('propagates Hedgehog failures instead of silently completing a match', async () => {
        analyzePosition.mockRejectedValue(new Error('engine worker crashed'));
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

        await expect(buildGamePositions(match)).rejects.toThrow('engine worker crashed');
    });

    it('recognizes a forced pass and does not create a quiz for it', async () => {
        analyzePosition.mockResolvedValue({
            moves: [candidate('', -0.5144)],
            engineMetadata: {
                model: { id: 'fox-v0.3', name: 'FOX v0.3' },
                hashes: { model: 'hash' },
                engineVersion: 'test',
                ply: 2
            }
        });
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

        expect(analyzePosition).toHaveBeenCalledTimes(1);
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
            analysis: { engine: 'hedgehog', model: { id: 'aureus-v0.1' } },
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
            analysis: { engine: 'hedgehog' },
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
                    analysis: { engine: 'hedgehog' },
                    ogid: 'a:b',
                    context: { equityDiff: 0.1 },
                    user: { name: 'alice' },
                    quiz: { playCount: 5, correctAnswers: 4 }
                },
                {
                    id: 'hard',
                    active: true,
                    analysis: { engine: 'hedgehog' },
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

    it('does not serve quizzes until Hedgehog reanalysis is complete', async () => {
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
                    analysis: { engine: 'hedgehog' },
                    ogid: 'a:b',
                    context: { equityDiff: 0.5 },
                    user: { name: 'alice' },
                    quiz: { playCount: 0, correctAnswers: 0 }
                },
                {
                    id: 'q2',
                    active: true,
                    analysis: { engine: 'hedgehog' },
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
                    analysis: { engine: 'hedgehog' },
                    ogid: 'a:b',
                    context: { equityDiff: 0.5 },
                    user: { name: 'alice' },
                    quiz: { playCount: 0, correctAnswers: 0 },
                    dgGameId: '111'
                },
                {
                    id: 'q2',
                    active: true,
                    analysis: { engine: 'hedgehog' },
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
                    analysis: { engine: 'hedgehog' },
                    context: { equityDiff: 0.4 }, user: { name: 'alice' },
                    quiz: { playCount: 0, correctAnswers: 0 }
                },
                {
                    id: 'cube', type: 'cube-offer', active: true,
                    analysis: { engine: 'hedgehog' },
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
