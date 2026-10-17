'use strict';

// Writes a recorded match against the engine as a .mat match file (the
// Jellyfish format that gnubg, XG and DailyGammon use), so it can be imported
// into an analysis program. The human is the left-hand player.

const { moveNotationToParts } = require('./engines/moveUtils');

const LEFT_START = 5;
const LEFT_WIDTH = 28;

function formatMove(dice, move) {
    const roll = `${dice.die1}${dice.die2}:`;
    const parts = moveNotationToParts(move || '');
    if (!parts.length) return roll;
    const tokens = parts.map((part) => {
        const from = part.from === 25 ? 'bar' : String(part.from);
        const to = part.to === 0 ? 'off' : String(part.to);
        return `${from}/${to}${part.hit ? '*' : ''}`;
    });
    return `${roll} ${tokens.join(' ')}`;
}

function plural(points) {
    return `${points} point${points === 1 ? '' : 's'}`;
}

/**
 * The lines of one game. Every action takes its player's column; a line is
 * full once the right-hand column is used, as in the sample
 *   2) 31: 8/5 6/5                    Doubles => 2
 *   3) Takes                           64: 24/14
 */
function gameLines(game, names, matchLength, finalGame) {
    const lines = [];
    lines.push(` Game ${game.number}`);
    const left = `${names.you} : ${game.score.you}`;
    lines.push(` ${left.padEnd(LEFT_WIDTH + 4)} ${names.engine} : ${game.score.engine}`);

    const rows = [];
    let row = null;
    const place = (side, text) => {
        if (!row || (side === 'left' && (row.left !== null || row.right !== null)) || (side === 'right' && row.right !== null)) {
            row = { left: null, right: null };
            rows.push(row);
        }
        row[side] = text;
    };
    let result = null;
    for (const entry of game.log) {
        const side = entry.who === 'you' ? 'left' : 'right';
        if (entry.type === 'move') place(side, formatMove(entry.dice || { die1: 0, die2: 0 }, entry.move));
        else if (entry.type === 'double') place(side, `Doubles => ${entry.cube}`);
        else if (entry.type === 'take') place(side, 'Takes');
        else if (entry.type === 'pass') place(side, 'Drops');
        else if (entry.type === 'game-over') result = entry;
    }
    rows.forEach((entry, index) => {
        const number = `${String(index + 1).padStart(3)})`;
        const leftText = (entry.left || '').padEnd(LEFT_WIDTH);
        lines.push(`${number} ${leftText} ${entry.right || ''}`.trimEnd());
    });
    if (result) {
        const andMatch = finalGame && result.points + game.score[result.winner] >= matchLength ? ' and the match' : '';
        const text = `Wins ${plural(result.points)}${andMatch}`;
        const indent = result.winner === 'you' ? LEFT_START + 1 : LEFT_START + LEFT_WIDTH + 2;
        lines.push(`${' '.repeat(indent)}${text}`);
    }
    return lines;
}

/**
 * @param {{ length: number, games: Array<object>, opponent?: string }} match a stored match (playStore.getMatch)
 * @param {string} playerName the human's name
 * @returns {string}
 */
function matchToMat(match, playerName) {
    const names = { you: playerName, engine: match.opponent || 'DarkBGHelmet' };
    const out = [` ${match.length} point match`, ''];
    match.games.forEach((game, index) => {
        out.push(...gameLines(game, names, match.length, index === match.games.length - 1));
        out.push('');
    });
    return `${out.join('\n')}\n`;
}

module.exports = { formatMove, matchToMat };
