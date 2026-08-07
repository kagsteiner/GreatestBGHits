(function exposeOgidCodec(root, factory) {
    const codec = factory();
    if (typeof module === 'object' && module.exports) module.exports = codec;
    else root.ogidCodec = codec;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createOgidCodec() {
    'use strict';

    function pipFromChar(character) {
        if (/^[0-9]$/.test(character)) return Number(character);
        if (/^[a-q]$/.test(character)) return character.charCodeAt(0) - 87;
        throw new Error(`Invalid OGID checker pip '${character}'`);
    }

    function decodeCheckerList(text, player) {
        const points = new Array(26).fill(0);
        for (const character of text) {
            const pip = pipFromChar(character);
            let point;
            if (player === 'player1') {
                if (pip === 0) point = 25;
                else if (pip >= 1 && pip <= 24) point = 25 - pip;
                else throw new Error(`Invalid White checker pip ${pip}`);
            } else {
                if (pip === 25) point = 25;
                else if (pip >= 1 && pip <= 24) point = pip;
                else throw new Error(`Invalid Black checker pip ${pip}`);
            }
            points[point] += 1;
        }
        const onBoardAndBar = points.slice(1).reduce((sum, count) => sum + count, 0);
        if (onBoardAndBar > 15) throw new Error(`OGID contains too many ${player} checkers`);
        points[0] = 15 - onBoardAndBar;
        return points;
    }

    function parseNonNegativeInteger(value, label) {
        if (!/^\d+$/.test(value)) throw new Error(`Invalid OGID ${label} '${value}'`);
        return Number(value);
    }

    function decodeOgid(ogid) {
        if (typeof ogid !== 'string') throw new Error('OGID must be a string');
        const fields = ogid.split(':');
        if (fields.length !== 10) throw new Error(`OGID must contain 10 fields, received ${fields.length}`);
        const [white, black, cubeText, diceText, reachedBy, gameState, whiteScoreText, blackScoreText, matchText, moveIdText] = fields;

        const cubeMatch = cubeText.match(/^([WBN])(\d+)N$/);
        if (!cubeMatch) throw new Error(`Invalid OGID cube field '${cubeText}'`);
        const cubeExponent = Number(cubeMatch[2]);
        if (!Number.isInteger(cubeExponent) || cubeExponent < 0 || cubeExponent > 15) {
            throw new Error(`Invalid OGID cube exponent '${cubeMatch[2]}'`);
        }
        if (diceText && !/^[1-6]{2}$/.test(diceText)) {
            throw new Error(`Invalid OGID dice field '${diceText}'`);
        }
        if (reachedBy !== 'W' && reachedBy !== 'B') {
            throw new Error(`Invalid OGID reached-by field '${reachedBy}'`);
        }
        if (!gameState) throw new Error('OGID game state is required');

        const match = matchText.match(/^(\d+)(C?)$/);
        if (!match) throw new Error(`Invalid OGID match field '${matchText}'`);
        const matchLength = Number(match[1]);

        return {
            points: {
                player1: decodeCheckerList(white, 'player1'),
                player2: decodeCheckerList(black, 'player2')
            },
            turn: reachedBy === 'W' ? 'player2' : 'player1',
            cube: 2 ** cubeExponent,
            cubeOwner: cubeMatch[1] === 'W' ? 'player1' : (cubeMatch[1] === 'B' ? 'player2' : null),
            score: {
                player1: parseNonNegativeInteger(whiteScoreText, 'White score'),
                player2: parseNonNegativeInteger(blackScoreText, 'Black score')
            },
            matchLength: matchLength || null,
            dice: diceText ? { die1: Number(diceText[0]), die2: Number(diceText[1]) } : null,
            ogid: {
                reachedBy,
                gameState,
                crawford: match[2] === 'C',
                moveId: parseNonNegativeInteger(moveIdText, 'move ID')
            }
        };
    }

    return { decodeOgid };
}));
