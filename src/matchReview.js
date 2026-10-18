'use strict';

// Turns a recorded match against the engine (playStore.getMatch) into the
// steps of a review: every move and cube action with the position before the
// decision (to analyse it) and after it (to show it). The human is player1.

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
    for (const entry of game.log || []) {
        switch (entry.type) {
        case 'grade':
            if (entry.kind === 'cube' && entry.action === 'No double') {
                // "No double": the human rolled instead of doubling.
                add({
                    type: 'no-double', who: 'you',
                    before: ogidFor(board, game, SIDE.you, null), after: ogidFor(board, game, SIDE.you, null),
                    grade: entry
                });
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
                grade: entry.who === 'you' ? pendingGrade : null
            });
            pendingGrade = null;
            break;
        }
        case 'double': {
            const player = SIDE[entry.who];
            const before = ogidFor(board, game, player, null);
            add({
                type: 'double', who: entry.who, cube: entry.cube, before, after: before,
                grade: entry.who === 'you' ? pendingGrade : null
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
                grade: entry.who === 'you' ? pendingGrade : null
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

module.exports = { buildReview };
