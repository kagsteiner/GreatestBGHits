'use strict';

const Database = require('better-sqlite3');
const { createFriendStore } = require('../src/friendStore');

describe('friend match history', () => {
    it('saves finished matches, lists the newest first, and updates the marks', () => {
        const store = createFriendStore(new Database(':memory:'));
        const record = (id, finishedAt) => ({
            id,
            startedAt: '2026-10-24T18:00:00.000Z',
            finishedAt,
            length: 5,
            player1: { name: 'Karl', score: 5, pr: 4.2, luck: 0.31 },
            player2: { name: 'Fred', score: 3, pr: null, luck: -0.12 },
            marked: [{ id: '1:3', seat: 'player2', name: 'Fred', kind: 'move', ogid: 'x', action: '8/2 6/2', best: '13/7 13/9', loss: 0.1 }]
        });
        store.saveMatch(record('a', '2026-10-24T19:00:00.000Z'));
        store.saveMatch(record('b', '2026-10-25T19:00:00.000Z'));
        const [newest, older] = store.listMatches();
        expect(newest.id).toBe('b');
        expect(older).toMatchObject({
            length: 5,
            player1: { name: 'Karl', score: 5, pr: 4.2, luck: 0.31 },
            player2: { name: 'Fred', score: 3, pr: null, luck: -0.12 },
            marked: [{ id: '1:3', action: '8/2 6/2' }]
        });
        store.markDecisions('a', []);
        expect(store.listMatches().find((match) => match.id === 'a').marked).toEqual([]);
    });

    it('keeps the games of a match for its review, but not in the list', () => {
        const store = createFriendStore(new Database(':memory:'));
        const record = {
            id: 'a', startedAt: 'x', finishedAt: 'y', length: 3,
            player1: { name: 'Karl', score: 3, pr: 1, luck: 0 },
            player2: { name: 'Fred', score: 0, pr: 2, luck: 0 }
        };
        store.saveMatch({ ...record, games: [{ number: 1, log: [] }] });
        store.saveMatch({ ...record, id: 'old' });
        const list = store.listMatches();
        expect(list.find((match) => match.id === 'a')).toMatchObject({ hasGames: true });
        expect(list.find((match) => match.id === 'a').games).toBeUndefined();
        expect(list.find((match) => match.id === 'old')).toMatchObject({ hasGames: false });
        expect(store.getMatch('a')).toMatchObject({ length: 3, games: [{ number: 1, log: [] }] });
        expect(store.getMatch('old').games).toBeNull();
        expect(store.getMatch('nope')).toBeNull();
    });

    it('adds the games to a table from before they were kept, and the old matches stay', () => {
        const db = new Database(':memory:');
        db.exec(`CREATE TABLE friend_matches (
            id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT NOT NULL, match_length INTEGER NOT NULL,
            player1_name TEXT NOT NULL, player2_name TEXT NOT NULL, player1_score INTEGER NOT NULL, player2_score INTEGER NOT NULL,
            player1_pr REAL, player2_pr REAL, player1_luck REAL NOT NULL, player2_luck REAL NOT NULL,
            marked_json TEXT NOT NULL DEFAULT '[]')`);
        db.exec(`INSERT INTO friend_matches VALUES ('old', 'x', 'y', 3, 'Karl', 'Fred', 3, 0, 1, 2, 0, 0, '[]')`);
        const store = createFriendStore(db);
        createFriendStore(db);
        expect(store.listMatches()).toEqual([expect.objectContaining({ id: 'old', hasGames: false })]);
    });

    it('keeps open matches with their state, and lists them without it', () => {
        const store = createFriendStore(new Database(':memory:'));
        const open = (id, updatedAt) => ({
            id, updatedAt, length: 5, names: { player1: 'Karl', player2: 'Fred' }, score: { player1: 1, player2: 0 }, state: { phase: 'turn' }
        });
        store.saveOpenMatch(open('a', '2026-11-01'));
        store.saveOpenMatch(open('b', '2026-11-02'));
        store.saveOpenMatch({ ...open('a', '2026-11-03'), score: { player1: 2, player2: 0 } });
        const list = store.listOpenMatches();
        expect(list.map((item) => item.id)).toEqual(['a', 'b']);
        expect(list[0]).toEqual({
            id: 'a', updatedAt: '2026-11-03', length: 5, names: { player1: 'Karl', player2: 'Fred' }, score: { player1: 2, player2: 0 }
        });
        expect(store.getOpenMatch('a')).toEqual({ phase: 'turn' });
        store.deleteOpenMatch('a');
        expect(store.getOpenMatch('a')).toBeNull();
        expect(store.listOpenMatches().map((item) => item.id)).toEqual(['b']);
    });
});
