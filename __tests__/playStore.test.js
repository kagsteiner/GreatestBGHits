'use strict';

const Database = require('better-sqlite3');
const { AccountError, createPlayStore } = require('../src/playStore');

function sampleRecord(overrides = {}) {
    return {
        id: 'match-1',
        userId: 1,
        startedAt: '2026-10-17T10:00:00.000Z',
        finishedAt: null,
        status: 'in-progress',
        length: 7,
        plies: 3,
        score: { you: 2, engine: 1 },
        games: [{ number: 1, score: { you: 0, engine: 0 }, crawford: false, log: [{ type: 'opening', you: 5, engine: 3 }] }],
        stats: { decisions: 12, rated: 10, flagged: 2, totalLoss: 0.12, pr: { value: 6, label: 'Expert' } },
        opponent: 'DarkBGHelmet',
        ...overrides
    };
}

describe('playStore', () => {
    let db;
    let store;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        store = createPlayStore(db);
    });

    afterEach(() => db.close());

    it('leaves other tables alone', () => {
        db.exec('CREATE TABLE user_data (username TEXT PRIMARY KEY, quizzes_json TEXT)');
        db.prepare('INSERT INTO user_data VALUES (?, ?)').run('alice', '{"positions":[1]}');
        createPlayStore(db);
        expect(db.prepare('SELECT quizzes_json FROM user_data').get().quizzes_json).toBe('{"positions":[1]}');
    });

    it('registers, logs in with the right password only, and resolves sessions', () => {
        const registered = store.register('Karl', 'secret1');
        expect(registered.user).toEqual({ id: 1, name: 'Karl' });
        expect(store.userForToken(registered.token)).toEqual({ id: 1, name: 'Karl' });

        // Names are unique regardless of case.
        expect(() => store.register('karl', 'other12')).toThrow('That name is taken');
        expect(() => store.register('x', 'secret1')).toThrow(AccountError);
        expect(() => store.register('Somebody', '123')).toThrow('at least 6');

        expect(() => store.login('Karl', 'wrong12')).toThrow('Wrong name or password');
        expect(() => store.login('Nobody', 'secret1')).toThrow('Wrong name or password');
        const again = store.login('KARL', 'secret1');
        expect(again.token).not.toBe(registered.token);

        store.logout(again.token);
        expect(store.userForToken(again.token)).toBeNull();
        expect(store.userForToken(registered.token)).toEqual({ id: 1, name: 'Karl' });
        expect(store.userForToken('not-a-token')).toBeNull();
        // Passwords are not stored in the clear.
        expect(JSON.stringify(db.prepare('SELECT * FROM play_users').all())).not.toContain('secret1');
    });

    it('saves, updates and lists matches per user, and abandons unfinished ones', () => {
        const { user } = store.register('Karl', 'secret1');
        const other = store.register('Eva', 'secret2').user;
        store.saveMatch(sampleRecord({ userId: user.id }));
        store.saveMatch(sampleRecord({ userId: user.id, status: 'finished', finishedAt: '2026-10-17T11:00:00.000Z', score: { you: 7, engine: 3 } }));
        store.saveMatch(sampleRecord({ id: 'match-2', userId: user.id, startedAt: '2026-10-17T12:00:00.000Z' }));
        // Another user cannot overwrite somebody else's match.
        store.saveMatch(sampleRecord({ userId: other.id, status: 'abandoned' }));

        const list = store.listMatches(user.id);
        expect(list.map((entry) => entry.id)).toEqual(['match-2', 'match-1']);
        expect(list[1]).toMatchObject({
            status: 'finished', length: 7, plies: 3, score: { you: 7, engine: 3 }, games: 1, decisions: 12, rated: 10, flagged: 2, pr: 6
        });
        expect(store.listMatches(other.id)).toEqual([]);

        expect(store.abandonInProgress()).toBe(1);
        expect(store.listMatches(user.id)[0].status).toBe('abandoned');

        const full = store.getMatch(user.id, 'match-1');
        expect(full.games[0].log[0]).toEqual({ type: 'opening', you: 5, engine: 3 });
        expect(store.getMatch(other.id, 'match-1')).toBeNull();
    });
});
