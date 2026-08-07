'use strict';

const { moveNotationToParts, moveSignature } = require('../src/engines/moveUtils');

describe('engine move utilities', () => {
    it('parses ordinary, hit, bar, off, count, and chain notation', () => {
        expect(moveNotationToParts('bar/22* 6/off 8/5(2) 24/18*/13')).toEqual([
            { from: 25, to: 22, hit: true },
            { from: 6, to: 0, hit: false },
            { from: 8, to: 5, hit: false },
            { from: 8, to: 5, hit: false },
            { from: 24, to: 18, hit: true },
            { from: 18, to: 13, hit: false }
        ]);
    });

    it('matches equivalent moves independent of checker-move order', () => {
        expect(moveSignature('8/5 6/5')).toBe(moveSignature([
            { from: 6, to: 5, hit: false },
            { from: 8, to: 5, hit: false }
        ]));
    });
});
