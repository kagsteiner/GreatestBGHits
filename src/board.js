'use strict';

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
     * Pack little-endian bit array to bytes.
     */
    static #bitsToBytesLe(bits, byteCount) {
        const bytes = new Uint8Array(byteCount);
        for (let i = 0; i < byteCount; i++) {
            let byte = 0;
            for (let b = 0; b < 8; b++) {
                const bit = bits[i * 8 + b] ? 1 : 0;
                byte |= (bit << b);
            }
            bytes[i] = byte;
        }
        return bytes;
    }

    /**
     * Unpack bytes to little-endian bit array.
     */
    static #bytesToBitsLe(bytes) {
        const bits = [];
        for (let i = 0; i < bytes.length; i++) {
            const v = bytes[i];
            for (let b = 0; b < 8; b++) bits.push((v >> b) & 1);
        }
        return bits;
    }

    static #bytesToBase64Trim(bytes) {
        return Buffer.from(bytes).toString('base64').replace(/=+$/g, '');
    }

    static #base64ToBytes(text) {
        // Pad to a multiple of 4 for Node base64
        const padLen = (4 - (text.length % 4)) % 4;
        const padded = text + '='.repeat(padLen);
        return Buffer.from(padded, 'base64');
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
            dice: this.dice ? { ...this.dice } : null
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
        if (hit && to >= 1 && to <= 24) {
            if (opp[to] > 0) {
                opp[to] -= 1;
                opp[25] += 1; // opponent to bar
            }
        }
        // Increment destination: to can be 0 (off) or 1..24
        if (to < 0 || to > 25) return;
        mine[to] += 1;
    }

    /**
     * Encode to GNU Position ID (14 chars) using 80-bit unary scheme.
     * Order: player1 first, then player2. Within each side: points 1..24, then bar.
     * This matches the spec's fixed side ordering independent of turn.
     * @returns {string}
     */
    toPositionId() {
        const bits = [];
        const pushSide = (arr) => {
            for (let i = 1; i <= 24; i++) {
                const n = Math.max(0, Math.min(15, Number(arr[i] || 0)));
                for (let k = 0; k < n; k++) bits.push(1);
                bits.push(0);
            }
            const bar = Math.max(0, Math.min(15, Number(arr[25] || 0)));
            for (let k = 0; k < bar; k++) bits.push(1);
            bits.push(0);
        };
        const current = this.turn === 'player2' ? 'player2' : 'player1';
        const other = current === 'player1' ? 'player2' : 'player1';
        pushSide(this.points[current]);
        pushSide(this.points[other]);
        // Exactly 80 bits -> 10 bytes -> 14 base64 chars (without padding)
        const bytes = BackgammonBoard.#bitsToBytesLe(bits, 10);
        return BackgammonBoard.#bytesToBase64Trim(bytes);
    }

    /**
     * Encode to a full GNU Match ID (12 chars, 9 bytes -> base64) based on
     * 66-bit match key per GNUBG spec.
     * Fields encoded: cube value/owner, dice owner (on roll), Crawford flag (0),
     * game state (001=in progress), decision owner (same as roller), double offered (0),
     * resignation (00), dice (3+3 bits, 0 if none), match length, scores.
     */
    toMatchId() {
        const bits = [];
        const writeBits = (value, width) => {
            let v = Number(value) >>> 0;
            for (let i = 0; i < width; i++) {
                bits.push(v & 1);
                v >>= 1;
            }
        };
        // Cube exponent (log2 cube)
        const cubeVal = Math.max(1, Number(this.cube || 1));
        let exp = 0; let c = cubeVal;
        while (c > 1 && exp < 15) { c >>= 1; exp++; }
        writeBits(exp, 4);
        // Cube owner: 00 player1, 01 player2, 11 centered
        let cubeOwnerBits = 3; // centered
        if (this.cubeOwner === 'player1') cubeOwnerBits = 0;
        else if (this.cubeOwner === 'player2') cubeOwnerBits = 1;
        writeBits(cubeOwnerBits, 2);
        // Dice owner (roller): 0 player1, 1 player2
        const rollerBit = this.turn === 'player2' ? 1 : 0;
        writeBits(rollerBit, 1);
        // Crawford flag (0 = no Crawford)
        writeBits(0, 1);
        // Game state (001 = in progress)
        writeBits(1, 3);
        // Decision owner (same as roller here)
        writeBits(rollerBit, 1);
        // Double offered (0)
        writeBits(0, 1);
        // Resignation offered (00)
        writeBits(0, 2);
        // Dice: 3 bits each (0..6), 0 means not set
        const d1 = this.dice && Number(this.dice.die1) || 0;
        const d2 = this.dice && Number(this.dice.die2) || 0;
        writeBits(d1, 3);
        writeBits(d2, 3);
        // Match length (15 bits) - 0 for money
        const mlen = Number.isFinite(this.matchLength) ? Math.max(0, Math.min(32767, this.matchLength)) : 0;
        writeBits(mlen, 15);
        // Scores (15 bits each)
        const s1 = Math.max(0, Math.min(32767, Number(this.score?.player1 || 0)));
        const s2 = Math.max(0, Math.min(32767, Number(this.score?.player2 || 0)));
        writeBits(s1, 15);
        writeBits(s2, 15);
        // Now we have 66 bits; pad to 72 and encode as 9 bytes -> 12 base64 chars (no padding kept)
        while (bits.length < 72) bits.push(0);
        const bytes = BackgammonBoard.#bitsToBytesLe(bits, 9);
        return BackgammonBoard.#bytesToBase64Trim(bytes);
    }

    /**
     * Combined GNU ID string in the form positionId:matchId
     */
    toGnuId() {
        const pos = this.toPositionId();
        const mid = this.toMatchId();
        return `${pos}:${mid}`;
    }

    /**
     * Build a board from a GNU ID. Currently decodes Position ID; match fields
     * are left at defaults. Points are assigned relative to the current-turn
     * player as encoded by the Position ID (turn assumed 'player1').
     * @param {string} gnuId positionId:matchId
     */
    static fromGnuId(gnuId) {
        if (typeof gnuId !== 'string' || !gnuId.includes(':')) {
            throw new Error('fromGnuId expects positionId:matchId');
        }
        const [posId, matchId] = gnuId.split(':', 2);
        const board = new BackgammonBoard();
        board.turn = 'player1';
        BackgammonBoard.#decodePositionIdInto(board, posId);
        if (matchId && matchId.length === 12) {
            BackgammonBoard.#decodeMatchIdInto(board, matchId);
        }
        return board;
    }

    /**
     * Decode a 14-char Position ID into board points.
     * Fills this.points for player on roll first and opponent second.
     * @private
     */
    static #decodePositionIdInto(board, posId) {
        if (typeof posId !== 'string' || posId.length !== 14) {
            throw new Error('Invalid Position ID length');
        }
        const bytes = BackgammonBoard.#base64ToBytes(posId);
        if (bytes.length !== 10) throw new Error('Invalid Position ID payload');
        const bits = BackgammonBoard.#bytesToBitsLe(bytes);
        const readSide = () => {
            const arr = new Array(26).fill(0);
            let ptr = 0;
            for (let i = 1; i <= 24; i++) {
                let count = 0;
                while (ptr < bits.length && bits[ptr] === 1) { count++; ptr++; }
                // consume terminating 0
                if (ptr < bits.length) ptr++;
                arr[i] = count;
            }
            let bar = 0;
            while (ptr < bits.length && bits[ptr] === 1) { bar++; ptr++; }
            if (ptr < bits.length) ptr++;
            arr[25] = bar;
            return { arr, ptr };
        };
        const first = readSide();
        // slice remaining bits for second side
        const secondBits = bits.slice(first.ptr);
        const second = (() => {
            const arr = new Array(26).fill(0);
            let ptr = 0;
            for (let i = 1; i <= 24; i++) {
                let count = 0;
                while (ptr < secondBits.length && secondBits[ptr] === 1) { count++; ptr++; }
                if (ptr < secondBits.length) ptr++;
                arr[i] = count;
            }
            let bar = 0;
            while (ptr < secondBits.length && secondBits[ptr] === 1) { bar++; ptr++; }
            if (ptr < secondBits.length) ptr++;
            arr[25] = bar;
            return { arr };
        })();
        board.points.player1 = first.arr;
        board.points.player2 = second.arr;
    }

    /**
     * Decode a 12-char Match ID into board match fields.
     * @private
     */
    static #decodeMatchIdInto(board, matchId) {
        try {
            if (typeof matchId !== 'string' || matchId.length !== 12) return;
            const bytes = BackgammonBoard.#base64ToBytes(matchId);
            if (bytes.length !== 9) return;
            const bits = BackgammonBoard.#bytesToBitsLe(bytes);
            let ptr = 0;
            const readBits = (w) => {
                let v = 0;
                for (let i = 0; i < w; i++) v |= (bits[ptr + i] & 1) << i;
                ptr += w;
                return v >>> 0;
            };
            const cubeExp = readBits(4);
            const cubeOwnerBits = readBits(2);
            const rollerBit = readBits(1);
            /* crawford */ readBits(1);
            /* game state */ readBits(3);
            /* decision owner */ readBits(1);
            /* double offered */ readBits(1);
            /* resignation */ readBits(2);
            const d1 = readBits(3);
            const d2 = readBits(3);
            const mlen = readBits(15);
            const s1 = readBits(15);
            const s2 = readBits(15);

            board.cube = 1 << cubeExp;
            board.cubeOwner = cubeOwnerBits === 0 ? 'player1' : (cubeOwnerBits === 1 ? 'player2' : null);
            board.turn = rollerBit === 1 ? 'player2' : 'player1';
            board.dice = (d1 || d2) ? { die1: d1, die2: d2 } : null;
            board.matchLength = mlen || null;
            board.score = { player1: s1, player2: s2 };
        } catch (_) {
            // ignore decoding errors; leave defaults
        }
    }
}

module.exports = BackgammonBoard;


