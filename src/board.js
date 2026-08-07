'use strict';

const { decodeOgid } = require('../shared/ogid');

/**
 * Backgammon board internal representation (Option A):
 * - Two arrays per player, length 26, where indices mean:
 *   0 = borne off, 1..24 = board points, 25 = bar.
 * - Additional match fields: cube value/owner, turn, match length, scores, dice.
 */
class BackgammonBoard {
    /**
     * @param {Object} [opts]
     * @param {{ player1: number[], player2: number[] }} [opts.points]
     * @param {'player1'|'player2'} [opts.turn]
     * @param {number} [opts.cube]
     * @param {'player1'|'player2'|null} [opts.cubeOwner]
     * @param {{ player1: number, player2: number }} [opts.score]
     * @param {number|null} [opts.matchLength]
     * @param {{ die1?: number, die2?: number }|null} [opts.dice]
     */
    constructor(opts = {}) {
        this.points = {
            player1: Array.isArray(opts.points?.player1) ? opts.points.player1.slice() : new Array(26).fill(0),
            player2: Array.isArray(opts.points?.player2) ? opts.points.player2.slice() : new Array(26).fill(0)
        };
        this.turn = opts.turn === 'player2' ? 'player2' : 'player1';
        this.cube = typeof opts.cube === 'number' && opts.cube > 0 ? opts.cube : 1;
        this.cubeOwner = opts.cubeOwner === 'player2' ? 'player2' : (opts.cubeOwner === 'player1' ? 'player1' : null);
        this.score = {
            player1: typeof opts.score?.player1 === 'number' ? opts.score.player1 : 0,
            player2: typeof opts.score?.player2 === 'number' ? opts.score.player2 : 0
        };
        this.matchLength = typeof opts.matchLength === 'number' ? opts.matchLength : null;
        this.dice = opts.dice || null;
        this.ogidMetadata = opts.ogid && typeof opts.ogid === 'object' ? { ...opts.ogid } : {};
    }

    /**
     * Create standard starting position for a new game.
     * Points are from each player's perspective (1..24 increasing away from home).
     */
    static starting(turn = 'player1') {
        const p1 = new Array(26).fill(0);
        const p2 = new Array(26).fill(0);
        // Player 1 checkers (from player1 perspective):
        p1[24] = 2; // 24-point
        p1[13] = 5; // 13-point
        p1[8] = 3;  // 8-point
        p1[6] = 5;  // 6-point
        // Player 2 mirrored from their own perspective
        p2[24] = 2;
        p2[13] = 5;
        p2[8] = 3;
        p2[6] = 5;
        return new BackgammonBoard({ points: { player1: p1, player2: p2 }, turn });
    }

    /**
     * Create the Nackgammon starting position for a new game.
     * Compared with regular backgammon, each player moves one checker from
     * the 13-point and one from the 6-point to the 23-point.
     */
    static startingNackgammon(turn = 'player1') {
        const p1 = new Array(26).fill(0);
        const p2 = new Array(26).fill(0);
        for (const points of [p1, p2]) {
            points[24] = 2;
            points[23] = 2;
            points[13] = 4;
            points[8] = 3;
            points[6] = 4;
        }
        return new BackgammonBoard({ points: { player1: p1, player2: p2 }, turn });
    }

    /**
     * Deep clone board state.
     */
    clone() {
        return new BackgammonBoard({
            points: {
                player1: this.points.player1.slice(),
                player2: this.points.player2.slice()
            },
            turn: this.turn,
            cube: this.cube,
            cubeOwner: this.cubeOwner,
            score: { player1: this.score.player1, player2: this.score.player2 },
            matchLength: this.matchLength,
            dice: this.dice ? { ...this.dice } : null,
            ogid: { ...this.ogidMetadata }
        });
    }

    /**
     * Apply a complete move (list of parts) for the given player.
     * @param {'player1'|'player2'} player
     * @param {Array<{ from:number, to:number, hit?:boolean }>} parts
     */
    applyMoveParts(player, parts) {
        if (!Array.isArray(parts)) return;
        for (const part of parts) {
            if (!part || typeof part.from !== 'number' || typeof part.to !== 'number') continue;
            this.#moveOne(player, part.from, part.to, !!part.hit);
        }
    }

    /**
     * Move a single checker for player from -> to; handles hit/bar/off.
     * Indices: 0=off, 1..24 points, 25=bar.
     * Note: Board points are mirrored between players (my point n = opponent's point 25-n).
     * @private
     */
    #moveOne(player, from, to, hit) {
        const mine = this.points[player];
        const opp = this.points[player === 'player1' ? 'player2' : 'player1'];
        // Decrement source: from can be 25 (bar) or 1..24
        if (from < 0 || from > 25) return;
        if (mine[from] <= 0) return;
        mine[from] -= 1;
        // Handle hit: opponent point loses one to bar if marked as hit
        // Points are mirrored: my point 'to' = opponent's point (25-to)
        if (hit && to >= 1 && to <= 24) {
            const oppPoint = 25 - to;
            if (opp[oppPoint] > 0) {
                opp[oppPoint] -= 1;
                opp[25] += 1; // opponent to bar
            }
        }
        // Increment destination: to can be 0 (off) or 1..24
        if (to < 0 || to > 25) return;
        mine[to] += 1;
    }

    /**
     * Encode this position as an OpenGammon ID (OGID), the native Hedgehog
     * position format. Player 1 is mapped to White and player 2 to Black.
     *
     * The app stores both players' points from their own perspective. OGID
     * instead uses one absolute pip axis: White bears off towards pip 25 and
     * Black towards pip 0. Borne-off checkers are omitted by the OGID format.
     *
     * @param {{ gameState?: string, moveId?: number, crawford?: boolean }} [opts]
     * @returns {string}
     */
    toOgid(opts = {}) {
        const pipToChar = (pip) => {
            if (pip >= 0 && pip <= 9) return String(pip);
            if (pip >= 10 && pip <= 26) return String.fromCharCode('a'.charCodeAt(0) + pip - 10);
            throw new Error(`Cannot encode invalid OGID pip ${pip}`);
        };

        const expandCheckers = (player, mapPoint, barPip) => {
            const checkers = [];
            const points = this.points[player];
            for (let point = 1; point <= 24; point++) {
                const count = Number(points[point] || 0);
                if (!Number.isInteger(count) || count < 0) {
                    throw new Error(`Cannot encode invalid checker count for ${player} point ${point}`);
                }
                for (let i = 0; i < count; i++) checkers.push(mapPoint(point));
            }
            const barCount = Number(points[25] || 0);
            if (!Number.isInteger(barCount) || barCount < 0) {
                throw new Error(`Cannot encode invalid checker count for ${player} bar`);
            }
            for (let i = 0; i < barCount; i++) checkers.push(barPip);

            const offCount = Number(points[0] || 0);
            if (!Number.isInteger(offCount) || offCount < 0 || checkers.length + offCount > 15) {
                throw new Error(`Cannot encode invalid total checker count for ${player}`);
            }
            return checkers.sort((a, b) => a - b).map(pipToChar).join('');
        };

        // White/player1 moves from the app's point 24 down to 0, which is
        // OGID pip 1 up to 25. Black/player2 already follows OGID's pip axis.
        const white = expandCheckers('player1', (point) => 25 - point, 0);
        const black = expandCheckers('player2', (point) => point, 25);

        const cubeValue = Math.max(1, Number(this.cube || 1));
        const cubeExponent = Math.log2(cubeValue);
        if (!Number.isInteger(cubeExponent) || cubeExponent > 15) {
            throw new Error(`Cannot encode invalid cube value ${cubeValue}`);
        }
        const cubeOwner = this.cubeOwner === 'player1'
            ? 'W'
            : (this.cubeOwner === 'player2' ? 'B' : 'N');
        const cube = `${cubeOwner}${cubeExponent}N`;

        const d1 = Number(this.dice?.die1 || 0);
        const d2 = Number(this.dice?.die2 || 0);
        const hasDice = Number.isInteger(d1) && d1 >= 1 && d1 <= 6
            && Number.isInteger(d2) && d2 >= 1 && d2 <= 6;
        const dice = hasDice ? `${d1}${d2}` : '';

        // OGID records who reached the position, i.e. the opposite of the
        // player currently on roll.
        const reachedBy = this.turn === 'player2' ? 'W' : 'B';
        const requestedGameState = opts.gameState ?? this.ogidMetadata.gameState;
        const gameState = typeof requestedGameState === 'string' && requestedGameState
            ? requestedGameState
            : (hasDice ? 'R' : 'C');
        const whiteScore = Math.max(0, Number(this.score?.player1 || 0));
        const blackScore = Math.max(0, Number(this.score?.player2 || 0));
        const matchLength = Number.isFinite(this.matchLength) ? Math.max(0, this.matchLength) : 0;
        const crawford = opts.crawford ?? this.ogidMetadata.crawford;
        const match = `${matchLength}${crawford ? 'C' : ''}`;
        const requestedMoveId = opts.moveId ?? this.ogidMetadata.moveId;
        const moveId = Number.isInteger(requestedMoveId) && requestedMoveId >= 0 ? requestedMoveId : 0;

        return `${white}:${black}:${cube}:${dice}:${reachedBy}:${gameState}:${whiteScore}:${blackScore}:${match}:${moveId}`;
    }

    /**
     * Construct a board from Hedgehog's native OpenGammon ID.
     * @param {string} ogid
     * @returns {BackgammonBoard}
     */
    static fromOgid(ogid) {
        return new BackgammonBoard(decodeOgid(ogid));
    }

}

module.exports = BackgammonBoard;
