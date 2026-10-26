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
});
