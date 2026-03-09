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
        engineAvailable: true,
        threshold: 0.08,
        positions: []
    })),
    getQuizByIdFromAllUsers: jest.fn()
};
jest.mock('../src/storage', () => mockStorage);

jest.mock('../src/gnubgRunner', () => jest.fn());

const {
    normalizeMoveText,
    parseBoardIdToGnuId,
    getNextQuiz,
    getQuizById,
    recordQuizResult,
    loadQuizzes
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

describe('parseBoardIdToGnuId()', () => {
    it('extracts position and match IDs', () => {
        const text = 'Position ID: 4HPwATDgc/ABMA\n  Match ID: cIgfAAAAAAAA';
        expect(parseBoardIdToGnuId(text)).toBe('4HPwATDgc/ABMA:cIgfAAAAAAAA');
    });

    it('returns null when position ID is missing', () => {
        expect(parseBoardIdToGnuId('Match ID: cIgfAAAAAAAA')).toBeNull();
    });

    it('returns null when match ID is missing', () => {
        expect(parseBoardIdToGnuId('Position ID: 4HPwATDgc/ABMA')).toBeNull();
    });

    it('returns null for empty/null input', () => {
        expect(parseBoardIdToGnuId('')).toBeNull();
        expect(parseBoardIdToGnuId(null)).toBeNull();
    });
});

describe('loadQuizzes()', () => {
    it('returns normalized quiz data from storage', async () => {
        mockStorage.readQuizzes.mockReturnValue({
            engineAvailable: true,
            threshold: 0.08,
            positions: [
                {
                    gnuId: 'test:id',
                    context: { equityDiff: 0.2, player: 'player1', gameNumber: 1, plyIndex: 1 },
                    user: { name: 'alice' }
                }
            ]
        });

        const result = await loadQuizzes('alice');
        expect(result.engineAvailable).toBe(true);
        expect(result.threshold).toBe(0.08);
        expect(result.positions).toHaveLength(1);
        expect(result.positions[0].quiz).toBeDefined();
        expect(result.positions[0].quiz.playCount).toBe(0);
        expect(result.positions[0].id).toBeDefined();
    });

    it('handles empty storage', async () => {
        mockStorage.readQuizzes.mockReturnValue(null);
        const result = await loadQuizzes('alice');
        expect(result.positions).toEqual([]);
    });
});

describe('getNextQuiz()', () => {
    it('selects the quiz with highest importance score', async () => {
        mockStorage.readQuizzes.mockReturnValue({
            positions: [
                {
                    id: 'easy',
                    gnuId: 'a:b',
                    context: { equityDiff: 0.1 },
                    user: { name: 'alice' },
                    quiz: { playCount: 5, correctAnswers: 4 }
                },
                {
                    id: 'hard',
                    gnuId: 'c:d',
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
        mockStorage.readQuizzes.mockReturnValue({ positions: [] });
        const quiz = await getNextQuiz('alice');
        expect(quiz).toBeNull();
    });

    it('respects player filter', async () => {
        mockStorage.readQuizzes.mockReturnValue({
            positions: [
                {
                    id: 'q1',
                    gnuId: 'a:b',
                    context: { equityDiff: 0.5 },
                    user: { name: 'alice' },
                    quiz: { playCount: 0, correctAnswers: 0 }
                },
                {
                    id: 'q2',
                    gnuId: 'c:d',
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
            positions: [
                {
                    id: 'q1',
                    gnuId: 'a:b',
                    context: { equityDiff: 0.5 },
                    user: { name: 'alice' },
                    quiz: { playCount: 0, correctAnswers: 0 },
                    dgGameId: '111'
                },
                {
                    id: 'q2',
                    gnuId: 'c:d',
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
});

describe('getQuizById()', () => {
    it('returns the quiz with matching id', async () => {
        mockStorage.readQuizzes.mockReturnValue({
            positions: [
                {
                    id: 'abc123',
                    gnuId: 'a:b',
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
        mockStorage.readQuizzes.mockReturnValue({ positions: [] });
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
            gnuId: 'a:b',
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
            gnuId: 'a:b',
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
