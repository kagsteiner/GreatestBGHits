'use strict';

// History of the friendly matches (src/friendMatch.js): one row per finished
// match with the result, the PR and the luck of both players, and the
// decisions the players marked to look at later, and every game to review it
// (not for matches from before the games were kept). Unfinished matches have their own table with everything needed to go on.

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
    );
    CREATE TABLE IF NOT EXISTS friend_open_matches (
        id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        match_length INTEGER NOT NULL,
        player1_name TEXT NOT NULL,
        player2_name TEXT NOT NULL,
        player1_score INTEGER NOT NULL,
        player2_score INTEGER NOT NULL,
        state_json TEXT NOT NULL
    )
    `);
    if (!db.prepare('PRAGMA table_info(friend_matches)').all().some((column) => column.name === 'games_json')) {
        db.exec('ALTER TABLE friend_matches ADD COLUMN games_json TEXT');
    }
    const statements = {
        insert: db.prepare(`
            INSERT OR REPLACE INTO friend_matches (id, started_at, finished_at, match_length,
                player1_name, player2_name, player1_score, player2_score,
                player1_pr, player2_pr, player1_luck, player2_luck, marked_json, games_json)
            VALUES (@id, @startedAt, @finishedAt, @length, @name1, @name2, @score1, @score2,
                @pr1, @pr2, @luck1, @luck2, @marked, @games)
        `),
        mark: db.prepare('UPDATE friend_matches SET marked_json = ? WHERE id = ?'),
        // Without the games, which only one review needs.
        list: db.prepare(`
            SELECT id, started_at, finished_at, match_length, player1_name, player2_name, player1_score, player2_score,
                player1_pr, player2_pr, player1_luck, player2_luck, marked_json, games_json IS NOT NULL AS has_games
            FROM friend_matches ORDER BY finished_at DESC LIMIT ?
        `),
        get: db.prepare('SELECT * FROM friend_matches WHERE id = ?'),
        saveOpen: db.prepare(`
            INSERT OR REPLACE INTO friend_open_matches (id, updated_at, match_length,
                player1_name, player2_name, player1_score, player2_score, state_json)
            VALUES (@id, @updatedAt, @length, @name1, @name2, @score1, @score2, @state)
        `),
        deleteOpen: db.prepare('DELETE FROM friend_open_matches WHERE id = ?'),
        // Without the state: the page asks for this list with every poll.
        listOpen: db.prepare(`
            SELECT id, updated_at, match_length, player1_name, player2_name, player1_score, player2_score
            FROM friend_open_matches ORDER BY updated_at DESC
        `),
        getOpen: db.prepare('SELECT state_json FROM friend_open_matches WHERE id = ?')
    };

    const toMatch = (row) => ({
        id: row.id,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        length: row.match_length,
        player1: { name: row.player1_name, score: row.player1_score, pr: row.player1_pr, luck: row.player1_luck },
        player2: { name: row.player2_name, score: row.player2_score, pr: row.player2_pr, luck: row.player2_luck },
        marked: JSON.parse(row.marked_json || '[]')
    });

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
                marked: JSON.stringify(record.marked || []),
                games: record.games ? JSON.stringify(record.games) : null
            });
        },

        /** Marks made after the match was saved (from the end-of-match screen). */
        markDecisions(id, marked) {
            statements.mark.run(JSON.stringify(marked || []), id);
        },

        listMatches(limit = 200) {
            return statements.list.all(limit).map((row) => ({ ...toMatch(row), hasGames: Boolean(row.has_games) }));
        },

        /** One finished match with its games (null for the games of an old match). */
        getMatch(id) {
            const row = statements.get.get(id);
            return row ? { ...toMatch(row), games: row.games_json ? JSON.parse(row.games_json) : null } : null;
        },

        /** The running match after its latest action, to go on from there. */
        saveOpenMatch(open) {
            statements.saveOpen.run({
                id: open.id,
                updatedAt: open.updatedAt,
                length: open.length,
                name1: open.names.player1,
                name2: open.names.player2,
                score1: open.score.player1,
                score2: open.score.player2,
                state: JSON.stringify(open.state)
            });
        },

        deleteOpenMatch(id) {
            statements.deleteOpen.run(id);
        },

        listOpenMatches() {
            return statements.listOpen.all().map((row) => ({
                id: row.id,
                updatedAt: row.updated_at,
                length: row.match_length,
                names: { player1: row.player1_name, player2: row.player2_name },
                score: { player1: row.player1_score, player2: row.player2_score }
            }));
        },

        getOpenMatch(id) {
            const row = statements.getOpen.get(id);
            return row ? JSON.parse(row.state_json) : null;
        }
    };
}

module.exports = { createFriendStore };
