'use strict';

// Turns a recorded match against the engine (playStore.getMatch) into the
// steps of a review: every move and cube action with the position before the
// decision (to analyse it) and after it (to show it). The human is player1.
// A match between friends is first seen from one player's side (friendMatchView):
// that player is the human, the other one takes the place of the engine, and
// their decisions are graded too.

const BackgammonBoard = require('./board');

const SIDE = { you: 'player1', engine: 'player2' };

function gameStartBoard(match, game) {
    const board = BackgammonBoard.starting('player1');
    board.matchLength = match.length;
    board.score = { player1: game.score.you, player2: game.score.engine };
    return board;
}

/** The board as an OGID with `player` on roll and the given dice (or none). */
function ogidFor(board, game, player, dice) {
    const copy = board.clone();
    copy.turn = player;
    copy.dice = dice || null;
    return copy.toOgid({ crawford: game.crawford === true, gameState: dice ? 'R' : 'C' });
}

function gameSteps(match, game) {
    let board = gameStartBoard(match, game);
    const steps = [];
    let pendingGrade = null;
    const add = (step) => {
        steps.push({ index: steps.length, ...step });
    };
    // In a match against the engine only the human's decisions have a grade (and no `who`).
    const gradeOf = (who) => ((pendingGrade?.who ?? 'you') === who ? pendingGrade : null);
    for (const entry of game.log || []) {
        switch (entry.type) {
        case 'grade':
            if (entry.kind === 'cube' && entry.action === 'No double') {
                // "No double": the player rolled instead of doubling.
                const who = entry.who ?? 'you';
                const before = ogidFor(board, game, SIDE[who], null);
                add({ type: 'no-double', who, before, after: before, grade: entry });
            } else {
                pendingGrade = entry;
            }
            break;
        case 'move': {
            const player = SIDE[entry.who];
            const before = ogidFor(board, game, player, entry.dice);
            const after = BackgammonBoard.fromOgid(entry.ogid);
            // The after-position keeps the cube as it was before this move.
            after.cube = board.cube;
            after.cubeOwner = board.cubeOwner;
            board = after;
            add({
                type: 'move', who: entry.who, dice: entry.dice, move: entry.move, forced: entry.forced === true,
                before, after: ogidFor(board, game, player, entry.dice),
                grade: gradeOf(entry.who)
            });
            pendingGrade = null;
            break;
        }
        case 'double': {
            const player = SIDE[entry.who];
            const before = ogidFor(board, game, player, null);
            add({
                type: 'double', who: entry.who, cube: entry.cube, before, after: before,
                grade: gradeOf(entry.who)
            });
            pendingGrade = null;
            break;
        }
        case 'take':
        case 'pass': {
            const doubler = entry.who === 'you' ? SIDE.engine : SIDE.you;
            // Analysed from the doubler's side, as the cube decision it answers.
            const before = ogidFor(board, game, doubler, null);
            if (entry.type === 'take') {
                board.cube *= 2;
                board.cubeOwner = SIDE[entry.who];
            }
            add({
                type: entry.type, who: entry.who, before, after: ogidFor(board, game, doubler, null),
                grade: gradeOf(entry.who)
            });
            pendingGrade = null;
            break;
        }
        case 'game-over':
            add({
                type: 'game-over', who: entry.winner, points: entry.points, kind: entry.kind,
                before: ogidFor(board, game, SIDE.you, null), after: ogidFor(board, game, SIDE.you, null)
            });
            break;
        default:
            break;
        }
    }
    return steps;
}

/**
 * @param {{ length: number, games: Array<object> }} match
 * @returns {Array<{ number: number, score: object, crawford: boolean, steps: Array<object> }>}
 */
function buildReview(match) {
    return (match.games || []).map((game) => ({
        number: game.number,
        score: game.score,
        crawford: game.crawford === true,
        steps: gameSteps(match, game)
    }));
}

/** A position with the two sides exchanged, for the player who is player2 in it. */
function mirrored(ogid) {
    const board = BackgammonBoard.fromOgid(ogid);
    const swap = (seat) => (seat === 'player1' ? 'player2' : (seat === 'player2' ? 'player1' : seat));
    return new BackgammonBoard({
        points: { player1: board.points.player2, player2: board.points.player1 },
        turn: swap(board.turn),
        cube: board.cube,
        cubeOwner: swap(board.cubeOwner),
        score: { player1: board.score.player2, player2: board.score.player1 },
        matchLength: board.matchLength,
        dice: board.dice,
        ogid: board.ogidMetadata
    }).toOgid();
}

/**
 * A finished match between friends (friendStore.getMatch) in the form of a
 * match against the engine, as `viewer` ('player1' or 'player2') sees it.
 * @returns {{ length: number, games: Array<object>, you: object, opponent: object }}
 */
function friendMatchView(match, viewer) {
    const marked = new Set(match.marked.map((item) => item.id));
    const other = viewer === 'player1' ? 'player2' : 'player1';
    const side = (seat) => (seat === viewer ? 'you' : 'engine');
    const games = (match.games || []).map((game) => ({
        number: game.number,
        crawford: game.crawford,
        score: { you: game.score[viewer], engine: game.score[other] },
        log: game.log.map((entry) => {
            const seen = { ...entry };
            if (entry.who) seen.who = side(entry.who);
            if (entry.winner) seen.winner = side(entry.winner);
            if (entry.ogid && viewer === 'player2') seen.ogid = mirrored(entry.ogid);
            if (entry.type === 'grade') seen.marked = marked.has(entry.id);
            return seen;
        })
    }));
    return { length: match.length, games, you: match[viewer], opponent: match[other] };
}

module.exports = { buildReview, friendMatchView };
