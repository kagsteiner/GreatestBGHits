(function exposeCheckerPlay(root, factory) {
    const checkerPlay = factory();
    if (typeof module === 'object' && module.exports) module.exports = checkerPlay;
    else root.checkerPlay = checkerPlay;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createCheckerPlay() {
    'use strict';

    // Positions use the engine's `points` format, seen from the player on
    // roll: points[1..24] are signed (own checkers positive), points[25] is the
    // own bar and points[0] the opponent's bar. Borne-off checkers are implied.
    // The rules that need the whole roll (use as many dice as possible, the
    // larger die first) are left to the engine's list of legal plays: a move
    // on the board is accepted while it can still end in one of those plays.

    const BAR = 25;
    const OFF = 0;

    function positionFromBoard(board, onRoll) {
        const me = onRoll || board.turn;
        const opp = me === 'player1' ? 'player2' : 'player1';
        const mine = board.points[me];
        const theirs = board.points[opp];
        const points = new Array(26).fill(0);
        for (let point = 1; point <= 24; point++) {
            points[point] = (mine[point] || 0) - (theirs[25 - point] || 0);
        }
        points[BAR] = mine[BAR] || 0;
        points[0] = theirs[BAR] || 0;
        return points;
    }

    function positionKey(points) {
        return points.join(',');
    }

    function allHome(points) {
        for (let point = 7; point <= BAR; point++) if (points[point] > 0) return false;
        return true;
    }

    /**
     * Move one checker from `from` by one die. Returns null when the checker
     * cannot make that step on its own: no checker there, a checker still on
     * the bar, a blocked point, or bearing off before all are home.
     */
    function step(points, from, die) {
        if (!(points[from] > 0)) return null;
        if (points[BAR] > 0 && from !== BAR) return null;
        const target = from - die;
        const next = points.slice();
        next[from] -= 1;
        if (target <= 0) {
            if (from === BAR || !allHome(points)) return null;
            if (target < 0) {
                // A larger die bears off only the checker farthest from home.
                for (let point = from + 1; point <= 6; point++) if (points[point] > 0) return null;
            }
            return { points: next, from, to: OFF, die, hit: false };
        }
        if (points[target] < -1) return null;
        const hit = points[target] === -1;
        if (hit) {
            next[target] = 1;
            next[0] += 1;
        } else {
            next[target] += 1;
        }
        return { points: next, from, to: target, die, hit };
    }

    function expandCountToken(token) {
        const match = String(token || '').match(/^([^()\s]+)\((\d+)\)$/);
        if (!match) return token ? [token] : [];
        return Array.from({ length: Number(match[2]) }, () => match[1]);
    }

    function parsePoint(text) {
        const value = String(text).replace(/\*/g, '').toLowerCase();
        if (value === 'bar') return BAR;
        if (value === 'off') return OFF;
        const point = Number(value);
        return Number.isInteger(point) && point >= 0 && point <= BAR ? point : null;
    }

    /**
     * Apply a play written in move notation (e.g. "24/18* 13/11", "6/off(2)",
     * "24/23 23/18") without checking the dice. Returns null for notation
     * that does not fit the position.
     */
    function applyMoveText(points, moveText) {
        let next = points.slice();
        const tokens = String(moveText || '').trim().split(/\s+/).filter(Boolean).flatMap(expandCountToken);
        for (const token of tokens) {
            const chain = token.split('/').map(parsePoint);
            if (chain.length < 2 || chain.includes(null)) return null;
            for (let index = 0; index < chain.length - 1; index++) {
                const from = chain[index];
                const to = chain[index + 1];
                if (!(next[from] > 0) || from === OFF || to === BAR || to >= from) return null;
                next = next.slice();
                next[from] -= 1;
                if (to === OFF) continue;
                if (next[to] < -1) return null;
                if (next[to] === -1) {
                    next[to] = 1;
                    next[0] += 1;
                } else {
                    next[to] += 1;
                }
            }
        }
        return next;
    }

    function diceList(dice) {
        const [d1, d2] = dice;
        return d1 === d2 ? [d1, d1, d1, d1] : [d1, d2];
    }

    function removeDie(remaining, die) {
        const index = remaining.indexOf(die);
        return remaining.slice(0, index).concat(remaining.slice(index + 1));
    }

    /**
     * Track a play made checker by checker against the engine's legal plays.
     *
     * @param {number[]} start position before the play
     * @param {number[]} dice the two dice
     * @param {Array<{ move: string, key: string }>} plays legal plays with the keys of their final positions
     */
    function createPlay(start, dice, plays) {
        const finals = new Map(plays.map((play) => [play.key, play.move]));
        const memo = new Map();
        const history = [];
        let points = start.slice();
        let remaining = diceList(dice);

        function canFinish(position, dieList) {
            const key = positionKey(position);
            if (finals.has(key)) return true;
            if (!dieList.length) return false;
            const memoKey = `${key}|${dieList.slice().sort().join('')}`;
            if (memo.has(memoKey)) return memo.get(memoKey);
            let result = false;
            for (const die of new Set(dieList)) {
                for (let from = BAR; from >= 1 && !result; from--) {
                    const moved = step(position, from, die);
                    if (moved && canFinish(moved.points, removeDie(dieList, die))) result = true;
                }
                if (result) break;
            }
            memo.set(memoKey, result);
            return result;
        }

        /**
         * Where the checker on `from` can go with the dice left, moving it
         * one or more steps, so that the play can still be completed legally.
         * When several routes reach the same point, the one with the fewest
         * hits on the way wins (a hit en route can be made with two moves).
         */
        function destinationsFrom(from) {
            const found = new Map();
            const explore = (position, at, dieList, steps) => {
                for (const die of new Set(dieList)) {
                    const moved = step(position, at, die);
                    if (!moved) continue;
                    const rest = removeDie(dieList, die);
                    const route = steps.concat([moved]);
                    if (canFinish(moved.points, rest)) {
                        const hits = route.filter((entry, index) => entry.hit && index < route.length - 1).length;
                        const existing = found.get(moved.to);
                        if (!existing || hits < existing.hits || (hits === existing.hits && route.length < existing.steps.length)) {
                            found.set(moved.to, { to: moved.to, steps: route, points: moved.points, remaining: rest, hits });
                        }
                    }
                    if (moved.to !== OFF) explore(moved.points, moved.to, rest, route);
                }
            };
            // A legal final position may still allow more moves: in the
            // bear-off, 5/off with the 5 ends where 5/4/off does, and the 1
            // may still be played elsewhere.
            explore(points, from, remaining, []);
            return Array.from(found.values());
        }

        function movableFrom() {
            const sources = [];
            for (let from = BAR; from >= 1; from--) {
                if (points[from] > 0 && destinationsFrom(from).length) sources.push(from);
            }
            return sources;
        }

        function move(from, to) {
            const destination = destinationsFrom(from).find((entry) => entry.to === to);
            if (!destination) return null;
            history.push({ points, remaining, steps: destination.steps });
            points = destination.points;
            remaining = destination.remaining;
            return destination;
        }

        function undo() {
            const last = history.pop();
            if (!last) return false;
            points = last.points;
            remaining = last.remaining;
            return true;
        }

        function reset() {
            while (history.length) undo();
        }

        function isComplete() {
            return finals.has(positionKey(points));
        }

        return {
            get points() { return points.slice(); },
            get remaining() { return remaining.slice(); },
            get moveCount() { return history.length; },
            get steps() { return history.flatMap((entry) => entry.steps); },
            isComplete,
            finalKey: () => positionKey(points),
            finalMove: () => (isComplete() ? finals.get(positionKey(points)) : null),
            destinationsFrom,
            movableFrom,
            move,
            undo,
            reset
        };
    }

    return {
        BAR,
        OFF,
        positionFromBoard,
        positionKey,
        step,
        applyMoveText,
        createPlay
    };
}));
