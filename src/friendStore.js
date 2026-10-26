'use strict';

// History of the friendly matches (src/friendMatch.js): one row per finished
// match with the result, the PR and the luck of both players, and the
// decisions the players marked to look at later. Moves are not stored.

/**
 * @param {import('better-sqlite3').Database} db
 */
function createFriendStore(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS friend_matches (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        match_length INTEGER NOT NULL,
        player1_name TEXT NOT NULL,
        player2_name TEXT NOT NULL,
        player1_score INTEGER NOT NULL,
        player2_score INTEGER NOT NULL,
        player1_pr REAL,
        player2_pr REAL,
        player1_luck REAL NOT NULL,
        player2_luck REAL NOT NULL,
        marked_json TEXT NOT NULL DEFAULT '[]'
    )
    `);
    const statements = {
        insert: db.prepare(`
            INSERT OR REPLACE INTO friend_matches (id, started_at, finished_at, match_length,
                player1_name, player2_name, player1_score, player2_score,
                player1_pr, player2_pr, player1_luck, player2_luck, marked_json)
            VALUES (@id, @startedAt, @finishedAt, @length, @name1, @name2, @score1, @score2,
                @pr1, @pr2, @luck1, @luck2, @marked)
        `),
        mark: db.prepare('UPDATE friend_matches SET marked_json = ? WHERE id = ?'),
        list: db.prepare('SELECT * FROM friend_matches ORDER BY finished_at DESC LIMIT ?')
    };

    return {
        saveMatch(record) {
            statements.insert.run({
                id: record.id,
                startedAt: record.startedAt,
                finishedAt: record.finishedAt,
                length: record.length,
                name1: record.player1.name,
                name2: record.player2.name,
                score1: record.player1.score,
                score2: record.player2.score,
                pr1: record.player1.pr,
                pr2: record.player2.pr,
                luck1: record.player1.luck,
                luck2: record.player2.luck,
                marked: JSON.stringify(record.marked || [])
            });
        },

        /** Marks made after the match was saved (from the end-of-match screen). */
        markDecisions(id, marked) {
            statements.mark.run(JSON.stringify(marked || []), id);
        },

        listMatches(limit = 200) {
            return statements.list.all(limit).map((row) => ({
                id: row.id,
                startedAt: row.started_at,
                finishedAt: row.finished_at,
                length: row.match_length,
                player1: { name: row.player1_name, score: row.player1_score, pr: row.player1_pr, luck: row.player1_luck },
                player2: { name: row.player2_name, score: row.player2_score, pr: row.player2_pr, luck: row.player2_luck },
                marked: JSON.parse(row.marked_json || '[]')
            }));
        }
    };
}

module.exports = { createFriendStore };
