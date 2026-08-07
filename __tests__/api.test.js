'use strict';

// Mock heavy dependencies before requiring server.js
jest.mock('../src/gnubgRunner', () => jest.fn().mockResolvedValue({
    matchId: 'test:id',
    engineAvailable: false,
    moves: []
}));

jest.mock('../DailyGammonRetriever', () => {
    return jest.fn().mockImplementation(() => ({
        login: jest.fn().mockResolvedValue(true),
        getFinishedMatches: jest.fn().mockResolvedValue([]),
        getFullExportUrls: jest.fn().mockReturnValue([]),
        session: {}
    }));
});

// Mock storage with in-memory data
const mockUsers = new Map();

jest.mock('../src/storage', () => {
    const { DEFAULT_MISTAKE_THRESHOLD } = jest.requireActual('../src/constants');

    function normalizeUsername(u) {
        return typeof u === 'string' ? u.trim().toLowerCase() : '';
    }

    function getUser(username) {
        const key = normalizeUsername(username);
        if (!mockUsers.has(key)) {
            mockUsers.set(key, {
                quizzes: { engineAvailable: true, threshold: DEFAULT_MISTAKE_THRESHOLD, positions: [] },
                analyzedMatches: { matches: [] }
            });
        }
        return mockUsers.get(key);
    }

    return {
        normalizeUsername,
        defaultQuizzesPayload: () => ({
            engineAvailable: true,
            threshold: DEFAULT_MISTAKE_THRESHOLD,
            positions: []
        }),
        defaultAnalyzedMatchesPayload: () => ({ matches: [] }),
        readQuizzes: jest.fn((username) => {
            return { ...getUser(username).quizzes };
        }),
        writeQuizzes: jest.fn((username, payload) => {
            getUser(username).quizzes = payload;
            return payload;
        }),
        readAnalyzedMatches: jest.fn((username) => {
            return { ...getUser(username).analyzedMatches };
        }),
        writeAnalyzedMatches: jest.fn((username, payload) => {
            getUser(username).analyzedMatches = payload;
            return payload;
        }),
        updateUserData: jest.fn((username, updater) => {
            const user = getUser(username);
            const result = updater({
                quizzes: { ...user.quizzes },
                analyzedMatches: { ...user.analyzedMatches }
            });
            if (result.quizzes) user.quizzes = result.quizzes;
            if (result.analyzedMatches) user.analyzedMatches = result.analyzedMatches;
            return result;
        }),
        getAllUsersStats: jest.fn(() => {
            const stats = [];
            for (const [username, data] of mockUsers) {
                stats.push({
                    username,
                    quizCount: data.quizzes.positions ? data.quizzes.positions.length : 0
                });
            }
            return stats;
        }),
        getQuizByIdFromAllUsers: jest.fn(() => null),
        consumeAdminNotice: jest.fn(() => false),
        recordActivity: jest.fn(),
        getActivityStats: jest.fn(() => ({
            currentMonth: { month: '2026-02', days: [] },
            months: []
        }))
    };
});

jest.mock('../src/adminNotice', () => ({
    getActiveAdminNotice: jest.fn(() => null)
}));

// Suppress dotenv warnings
jest.mock('dotenv', () => ({ config: jest.fn() }));

const request = require('supertest');
const runGnuBgAnalysis = require('../src/gnubgRunner');
const app = require('../server');

const AUTH_HEADER = 'Basic ' + Buffer.from('TestUser:testpass').toString('base64');

beforeEach(() => {
    mockUsers.clear();
    jest.clearAllMocks();
});

describe('API routes', () => {
    describe('GET /health', () => {
        it('returns 200 with status ok', async () => {
            const res = await request(app).get('/health');
            expect(res.status).toBe(200);
            expect(res.body.status).toBe('ok');
            expect(res.body.analysis).toEqual({ mode: 'gnubg', authoritativeEngine: 'gnubg' });
        });
    });

    describe('GET /siteStats (public)', () => {
        it('returns 200', async () => {
            const res = await request(app).get('/siteStats');
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
        });
    });

    describe('GET /activityStats (public)', () => {
        it('returns 200 with expected shape', async () => {
            const res = await request(app).get('/activityStats');
            expect(res.status).toBe(200);
            expect(res.body.currentMonth).toBeDefined();
            expect(res.body.months).toBeDefined();
        });
    });

    describe('authentication', () => {
        it('returns 401 for unauthenticated requests to protected routes', async () => {
            const res = await request(app).get('/getQuiz');
            expect(res.status).toBe(401);
        });

        it('returns 401 for malformed auth header', async () => {
            const res = await request(app)
                .get('/getQuiz')
                .set('Authorization', 'Bearer invalid');
            expect(res.status).toBe(401);
        });

        it('accepts valid Basic Auth', async () => {
            const res = await request(app)
                .get('/getQuiz')
                .set('Authorization', AUTH_HEADER);
            // 204 = no quiz, which is fine - we just care it's not 401
            expect([200, 204]).toContain(res.status);
        });
    });

    describe('GET /getQuiz', () => {
        it('returns 204 when no quizzes exist', async () => {
            const res = await request(app)
                .get('/getQuiz')
                .set('Authorization', AUTH_HEADER);
            expect(res.status).toBe(204);
        });

        it('returns a quiz when one exists', async () => {
            // Seed quiz data
            const storage = require('../src/storage');
            storage.readQuizzes.mockReturnValueOnce({
                engineAvailable: true,
                threshold: 0.08,
                positions: [{
                    id: 'q1',
                    gnuId: 'test:id',
                    context: { equityDiff: 0.3, player: 'player1', gameNumber: 1, plyIndex: 1 },
                    user: { name: 'testuser' },
                    quiz: { playCount: 0, correctAnswers: 0 }
                }]
            });

            const res = await request(app)
                .get('/getQuiz')
                .set('Authorization', AUTH_HEADER);
            expect(res.status).toBe(200);
            expect(res.body.id).toBe('q1');
        });
    });

    describe('GET /getQuiz/:id', () => {
        it('returns 404 for unknown quiz', async () => {
            const res = await request(app)
                .get('/getQuiz/nonexistent')
                .set('Authorization', AUTH_HEADER);
            expect(res.status).toBe(404);
        });
    });

    describe('POST /updateQuiz', () => {
        it('returns 400 without id', async () => {
            const res = await request(app)
                .post('/updateQuiz')
                .set('Authorization', AUTH_HEADER)
                .send({});
            expect(res.status).toBe(400);
        });

        it('returns 404 for unknown quiz', async () => {
            const res = await request(app)
                .post('/updateQuiz')
                .set('Authorization', AUTH_HEADER)
                .send({ id: 'nonexistent', wasCorrect: true });
            expect(res.status).toBe(404);
        });
    });

    describe('GET /getStatistics', () => {
        it('returns statistics shape', async () => {
            const res = await request(app)
                .get('/getStatistics')
                .set('Authorization', AUTH_HEADER);
            expect(res.status).toBe(200);
            expect(res.body).toHaveProperty('totalQuizzes');
            expect(res.body).toHaveProperty('totalAttempts');
            expect(res.body).toHaveProperty('totalCorrect');
        });
    });

    describe('GET /getPlayers', () => {
        it('returns an array', async () => {
            const res = await request(app)
                .get('/getPlayers')
                .set('Authorization', AUTH_HEADER);
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
        });
    });

    describe('GET /getMatches', () => {
        it('returns an array', async () => {
            const res = await request(app)
                .get('/getMatches')
                .set('Authorization', AUTH_HEADER);
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
        });
    });

    describe('POST /addLastMatchesAndSave', () => {
        it('creates a job and returns jobId', async () => {
            const res = await request(app)
                .post('/addLastMatchesAndSave')
                .set('Authorization', AUTH_HEADER)
                .send({ days: 7 });
            expect(res.status).toBe(200);
            expect(res.body.jobId).toBeDefined();
            expect(typeof res.body.jobId).toBe('string');
        });
    });

    describe('POST /analyzePositionFromMatch', () => {
        it('returns 400 without matchId', async () => {
            const res = await request(app)
                .post('/analyzePositionFromMatch')
                .send({});
            expect(res.status).toBe(400);
        });

        it('uses the configured analysis adapter', async () => {
            const res = await request(app)
                .post('/analyzePositionFromMatch')
                .send({ matchId: 'match-id', positionId: 'position-id', dice: { die1: 3, die2: 1 } });
            expect(res.status).toBe(200);
            expect(runGnuBgAnalysis).toHaveBeenCalledWith({
                matchId: 'match-id',
                positionId: 'position-id',
                positionIndex: undefined,
                dice: { die1: 3, die2: 1 }
            });
        });
    });
});
