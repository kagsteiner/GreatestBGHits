'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { DEFAULT_MISTAKE_THRESHOLD } = require('../src/constants');

// Use a fresh in-memory DB for each test run by re-wiring better-sqlite3
// before storage.js loads. We also stub fs.mkdirSync to skip directory creation.
let mockMemDb;

jest.mock('better-sqlite3', () => {
    const Actual = jest.requireActual('better-sqlite3');
    return function MockDatabase() {
        if (!mockMemDb) {
            mockMemDb = new Actual(':memory:');
        }
        return mockMemDb;
    };
});

jest.mock('fs', () => {
    const actual = jest.requireActual('fs');
    return { ...actual, mkdirSync: jest.fn() };
});

const storage = require('../src/storage');

afterAll(() => {
    if (mockMemDb) {
        try { mockMemDb.close(); } catch (_) { /* ignore */ }
    }
});

describe('storage', () => {
    describe('normalizeUsername()', () => {
        it('lowercases and trims', () => {
            expect(storage.normalizeUsername('  Alice  ')).toBe('alice');
        });

        it('returns empty string for non-string', () => {
            expect(storage.normalizeUsername(null)).toBe('');
            expect(storage.normalizeUsername(undefined)).toBe('');
            expect(storage.normalizeUsername(42)).toBe('');
        });
    });

    describe('defaultQuizzesPayload()', () => {
        it('returns expected structure', () => {
            const p = storage.defaultQuizzesPayload();
            expect(p.engineAvailable).toBe(true);
            expect(p.threshold).toBe(DEFAULT_MISTAKE_THRESHOLD);
            expect(p.positions).toEqual([]);
        });
    });

    describe('defaultAnalyzedMatchesPayload()', () => {
        it('returns expected structure', () => {
            const p = storage.defaultAnalyzedMatchesPayload();
            expect(p).toEqual({ matches: [] });
        });
    });

    describe('readQuizzes / writeQuizzes round-trip', () => {
        it('reads default quizzes for a new user', () => {
            const result = storage.readQuizzes('testuser_read');
            expect(result.engineAvailable).toBe(true);
            expect(result.threshold).toBe(DEFAULT_MISTAKE_THRESHOLD);
            expect(result.positions).toEqual([]);
        });

        it('persists written quizzes', () => {
            const payload = {
                engineAvailable: true,
                threshold: 0.1,
                positions: [{ id: 'q1', gnuId: 'test:id' }]
            };
            storage.writeQuizzes('testuser_write', payload);
            const result = storage.readQuizzes('testuser_write');
            expect(result.threshold).toBe(0.1);
            expect(result.positions).toHaveLength(1);
            expect(result.positions[0].id).toBe('q1');
        });
    });

    describe('readAnalyzedMatches / writeAnalyzedMatches round-trip', () => {
        it('reads default for new user', () => {
            const result = storage.readAnalyzedMatches('testuser_matches');
            expect(result).toEqual({ matches: [] });
        });

        it('persists written matches', () => {
            const payload = { matches: ['123', '456'] };
            storage.writeAnalyzedMatches('testuser_matches2', payload);
            const result = storage.readAnalyzedMatches('testuser_matches2');
            expect(result.matches).toEqual(['123', '456']);
        });
    });

    describe('updateUserData()', () => {
        it('applies updater atomically', () => {
            storage.writeQuizzes('testuser_update', {
                engineAvailable: true,
                threshold: 0.08,
                positions: [{ id: 'q1', value: 'original' }]
            });

            const result = storage.updateUserData('testuser_update', ({ quizzes, analyzedMatches }) => {
                quizzes.positions[0].value = 'modified';
                return { quizzes, analyzedMatches };
            });

            expect(result.quizzes.positions[0].value).toBe('modified');
            const reread = storage.readQuizzes('testuser_update');
            expect(reread.positions[0].value).toBe('modified');
        });

        it('throws for empty username', () => {
            expect(() => storage.updateUserData('', () => ({}))).toThrow('Username is required');
        });
    });

    describe('getAllUsersStats()', () => {
        it('returns stats for all users', () => {
            storage.writeQuizzes('statsuser1', {
                engineAvailable: true,
                threshold: 0.08,
                positions: [{ id: 'a' }, { id: 'b' }]
            });
            storage.writeQuizzes('statsuser2', {
                engineAvailable: true,
                threshold: 0.08,
                positions: [{ id: 'c' }]
            });

            const stats = storage.getAllUsersStats();
            const u1 = stats.find(s => s.username === 'statsuser1');
            const u2 = stats.find(s => s.username === 'statsuser2');
            expect(u1).toBeDefined();
            expect(u1.quizCount).toBe(2);
            expect(u2).toBeDefined();
            expect(u2.quizCount).toBe(1);
        });
    });

    describe('getQuizByIdFromAllUsers()', () => {
        it('finds a quiz across users', () => {
            storage.writeQuizzes('searchuser', {
                engineAvailable: true,
                threshold: 0.08,
                positions: [{ id: 'findme', gnuId: 'x:y' }]
            });

            const result = storage.getQuizByIdFromAllUsers('findme');
            expect(result).not.toBeNull();
            expect(result.id).toBe('findme');
            expect(result._username).toBe('searchuser');
        });

        it('returns null for unknown id', () => {
            expect(storage.getQuizByIdFromAllUsers('doesnotexist')).toBeNull();
        });

        it('returns null for invalid input', () => {
            expect(storage.getQuizByIdFromAllUsers(null)).toBeNull();
            expect(storage.getQuizByIdFromAllUsers('')).toBeNull();
        });
    });

    describe('recordActivity / getActivityStats', () => {
        it('increments activity counters', () => {
            storage.recordActivity('quizzes_served', 3);
            storage.recordActivity('quizzes_served', 2);
            storage.recordActivity('logins', 1);

            const stats = storage.getActivityStats();
            expect(stats.currentMonth).toBeDefined();
            expect(Array.isArray(stats.currentMonth.days)).toBe(true);

            const today = stats.currentMonth.days.find(
                d => d.quizzes_served >= 5
            );
            expect(today).toBeDefined();
        });
    });

    describe('consumeAdminNotice()', () => {
        it('returns true on first consumption', () => {
            const result = storage.consumeAdminNotice('noticeuser', 'hash123');
            expect(result).toBe(true);
        });

        it('returns false on duplicate consumption', () => {
            storage.consumeAdminNotice('noticeuser2', 'hash456');
            const result = storage.consumeAdminNotice('noticeuser2', 'hash456');
            expect(result).toBe(false);
        });

        it('returns false for invalid input', () => {
            expect(storage.consumeAdminNotice('', 'hash')).toBe(false);
            expect(storage.consumeAdminNotice('user', '')).toBe(false);
            expect(storage.consumeAdminNotice('user', null)).toBe(false);
        });
    });
});
