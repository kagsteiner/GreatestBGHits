'use strict';

// This decoder is intentionally quarantined under scripts/migrations. It is
// needed only to convert pre-Hedgehog quiz records and is not loaded by the app.
const BackgammonBoard = require('../../src/board');

function base64ToBytes(text) {
    const padded = text + '='.repeat((4 - (text.length % 4)) % 4);
    return Buffer.from(padded, 'base64');
}

function bytesToBitsLe(bytes) {
    const bits = [];
    for (const byte of bytes) {
        for (let bit = 0; bit < 8; bit++) bits.push((byte >> bit) & 1);
    }
    return bits;
}

function readBits(bits, cursor, width) {
    let value = 0;
    for (let bit = 0; bit < width; bit++) value |= (bits[cursor.offset + bit] & 1) << bit;
    cursor.offset += width;
    return value >>> 0;
}

function decodeSide(bits, start) {
    const points = new Array(26).fill(0);
    let cursor = start;
    for (let point = 1; point <= 25; point++) {
        let count = 0;
        while (cursor < bits.length && bits[cursor] === 1) {
            count += 1;
            cursor += 1;
        }
        if (cursor >= bits.length) throw new Error('Unterminated legacy checker encoding');
        cursor += 1;
        points[point] = count;
    }
    const remaining = points.slice(1).reduce((sum, count) => sum + count, 0);
    if (remaining > 15) throw new Error('Legacy position contains more than 15 checkers');
    points[0] = 15 - remaining;
    return { points, cursor };
}

function decodeLegacyPositionId(legacyId) {
    if (typeof legacyId !== 'string' || !legacyId.includes(':')) {
        throw new Error('Legacy position must contain positionId:matchId');
    }
    const [positionId, matchId] = legacyId.split(':', 2);
    if (positionId.length !== 14 || matchId.length !== 12) {
        throw new Error('Legacy position has an invalid ID length');
    }

    const positionBytes = base64ToBytes(positionId);
    const matchBytes = base64ToBytes(matchId);
    if (positionBytes.length !== 10 || matchBytes.length !== 9) {
        throw new Error('Legacy position has an invalid binary payload');
    }

    const matchBits = bytesToBitsLe(matchBytes);
    const matchCursor = { offset: 0 };
    const cubeExponent = readBits(matchBits, matchCursor, 4);
    const cubeOwnerBits = readBits(matchBits, matchCursor, 2);
    const rollerBit = readBits(matchBits, matchCursor, 1);
    const crawford = readBits(matchBits, matchCursor, 1) === 1;
    readBits(matchBits, matchCursor, 3); // game state
    readBits(matchBits, matchCursor, 1); // decision owner
    readBits(matchBits, matchCursor, 1); // double offered
    readBits(matchBits, matchCursor, 2); // resignation
    const die1 = readBits(matchBits, matchCursor, 3);
    const die2 = readBits(matchBits, matchCursor, 3);
    const matchLength = readBits(matchBits, matchCursor, 15);
    const score1 = readBits(matchBits, matchCursor, 15);
    const score2 = readBits(matchBits, matchCursor, 15);
    if (cubeExponent > 15 || ![die1, die2].every((die) => die >= 0 && die <= 6)) {
        throw new Error('Legacy match payload contains invalid values');
    }

    const positionBits = bytesToBitsLe(positionBytes);
    const first = decodeSide(positionBits, 0);
    const second = decodeSide(positionBits, first.cursor);
    const turn = rollerBit === 1 ? 'player2' : 'player1';
    const opponent = turn === 'player1' ? 'player2' : 'player1';
    const points = { player1: null, player2: null };
    points[opponent] = first.points;
    points[turn] = second.points;

    return {
        board: new BackgammonBoard({
            points,
            turn,
            cube: 2 ** cubeExponent,
            cubeOwner: cubeOwnerBits === 0 ? 'player1' : (cubeOwnerBits === 1 ? 'player2' : null),
            score: { player1: score1, player2: score2 },
            matchLength: matchLength || null,
            dice: die1 && die2 ? { die1, die2 } : null
        }),
        crawford
    };
}

module.exports = { decodeLegacyPositionId };
