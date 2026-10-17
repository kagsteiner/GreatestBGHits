'use strict';

// Accounts and match history for playing against the engine. These tables
// are separate from the quiz data (user_data) and do not touch it.

const crypto = require('crypto');

const NAME_PATTERN = /^[A-Za-z0-9_.-]{3,20}$/;
const MIN_PASSWORD_LENGTH = 6;
const SCRYPT_KEY_LENGTH = 64;

class AccountError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = 'AccountError';
        this.status = status;
    }
}

function hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH);
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/** One row of play_matches as the history list shows it. */
function summaryFromRow(row) {
    return {
        id: row.id,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        status: row.status,
        length: row.match_length,
        plies: row.plies,
        score: { you: row.score_you, engine: row.score_engine },
        games: row.games_played,
        decisions: row.decisions,
        flagged: row.flagged,
        pr: row.pr
    };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
function createPlayStore(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS play_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at TEXT NOT NULL
    )
    `);
    db.exec(`
    CREATE TABLE IF NOT EXISTS play_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES play_users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL
    )
    `);
    db.exec(`
    CREATE TABLE IF NOT EXISTS play_matches (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES play_users(id) ON DELETE CASCADE,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        match_length INTEGER NOT NULL,
        plies INTEGER NOT NULL,
        score_you INTEGER NOT NULL,
        score_engine INTEGER NOT NULL,
        games_played INTEGER NOT NULL,
        decisions INTEGER NOT NULL,
        rated INTEGER NOT NULL,
        flagged INTEGER NOT NULL,
        total_loss REAL NOT NULL,
        pr REAL,
        record_json TEXT NOT NULL
    )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS play_matches_user ON play_matches (user_id, started_at)');

    const statements = {
        insertUser: db.prepare('INSERT INTO play_users (name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?)'),
        userByName: db.prepare('SELECT * FROM play_users WHERE name = ?'),
        insertSession: db.prepare('INSERT INTO play_sessions (token_hash, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)'),
        sessionUser: db.prepare(`
            SELECT play_users.id, play_users.name FROM play_sessions
            JOIN play_users ON play_users.id = play_sessions.user_id
            WHERE play_sessions.token_hash = ?`),
        touchSession: db.prepare('UPDATE play_sessions SET last_used_at = ? WHERE token_hash = ?'),
        deleteSession: db.prepare('DELETE FROM play_sessions WHERE token_hash = ?'),
        upsertMatch: db.prepare(`
            INSERT INTO play_matches (id, user_id, started_at, updated_at, finished_at, status, match_length, plies,
                score_you, score_engine, games_played, decisions, rated, flagged, total_loss, pr, record_json)
            VALUES (@id, @userId, @startedAt, @updatedAt, @finishedAt, @status, @length, @plies,
                @scoreYou, @scoreEngine, @games, @decisions, @rated, @flagged, @totalLoss, @pr, @record)
            ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, finished_at = excluded.finished_at,
                status = excluded.status, score_you = excluded.score_you, score_engine = excluded.score_engine,
                games_played = excluded.games_played, decisions = excluded.decisions, rated = excluded.rated,
                flagged = excluded.flagged, total_loss = excluded.total_loss, pr = excluded.pr,
                record_json = excluded.record_json
            WHERE play_matches.user_id = excluded.user_id`),
        abandonInProgress: db.prepare("UPDATE play_matches SET status = 'abandoned', updated_at = ? WHERE status = 'in-progress'"),
        listMatches: db.prepare('SELECT * FROM play_matches WHERE user_id = ? ORDER BY started_at DESC LIMIT ?'),
        getMatch: db.prepare('SELECT * FROM play_matches WHERE id = ? AND user_id = ?')
    };

    function newSession(userId) {
        const token = crypto.randomBytes(32).toString('hex');
        const now = new Date().toISOString();
        statements.insertSession.run(hashToken(token), userId, now, now);
        return token;
    }

    return {
        /** Create an account and log it in. */
        register(name, password) {
            const trimmed = String(name || '').trim();
            if (!NAME_PATTERN.test(trimmed)) {
                throw new AccountError('Choose a name of 3–20 letters, digits, dots, dashes or underscores');
            }
            if (String(password || '').length < MIN_PASSWORD_LENGTH) {
                throw new AccountError(`Choose a password of at least ${MIN_PASSWORD_LENGTH} characters`);
            }
            if (statements.userByName.get(trimmed)) throw new AccountError('That name is taken', 409);
            const salt = crypto.randomBytes(16);
            const result = statements.insertUser.run(
                trimmed, hashPassword(String(password), salt).toString('hex'), salt.toString('hex'), new Date().toISOString()
            );
            const userId = Number(result.lastInsertRowid);
            return { token: newSession(userId), user: { id: userId, name: trimmed } };
        },

        login(name, password) {
            const user = statements.userByName.get(String(name || '').trim());
            const salt = user ? Buffer.from(user.password_salt, 'hex') : crypto.randomBytes(16);
            // Hash even for unknown names, so both cases take the same time.
            const given = hashPassword(String(password || ''), salt);
            const stored = user ? Buffer.from(user.password_hash, 'hex') : Buffer.alloc(SCRYPT_KEY_LENGTH);
            if (!user || !crypto.timingSafeEqual(given, stored)) throw new AccountError('Wrong name or password', 401);
            return { token: newSession(user.id), user: { id: user.id, name: user.name } };
        },

        /** The user a session token belongs to, or null. */
        userForToken(token) {
            if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
            const tokenHash = hashToken(token);
            const user = statements.sessionUser.get(tokenHash);
            if (user) statements.touchSession.run(new Date().toISOString(), tokenHash);
            return user ? { id: user.id, name: user.name } : null;
        },

        logout(token) {
            if (typeof token === 'string') statements.deleteSession.run(hashToken(token));
        },

        /** Insert or update a match record (see PlayMatches.record()). */
        saveMatch(record) {
            statements.upsertMatch.run({
                id: record.id,
                userId: record.userId,
                startedAt: record.startedAt,
                updatedAt: new Date().toISOString(),
                finishedAt: record.finishedAt || null,
                status: record.status,
                length: record.length,
                plies: record.plies,
                scoreYou: record.score.you,
                scoreEngine: record.score.engine,
                games: record.games.length,
                decisions: record.stats.decisions,
                rated: record.stats.rated,
                flagged: record.stats.flagged,
                totalLoss: record.stats.totalLoss,
                pr: record.stats.pr ? record.stats.pr.value : null,
                record: JSON.stringify({ games: record.games, opponent: record.opponent })
            });
        },

        /** Matches live in memory: after a restart, unfinished ones are abandoned. */
        abandonInProgress() {
            return statements.abandonInProgress.run(new Date().toISOString()).changes;
        },

        listMatches(userId, limit = 200) {
            return statements.listMatches.all(userId, limit).map(summaryFromRow);
        },

        /** A match with all its games, or null if it is not this user's. */
        getMatch(userId, id) {
            const row = statements.getMatch.get(String(id), userId);
            if (!row) return null;
            const stored = JSON.parse(row.record_json);
            return { ...summaryFromRow(row), games: stored.games || [], opponent: stored.opponent || 'DarkBGHelmet' };
        }
    };
}

module.exports = {
    AccountError,
    MIN_PASSWORD_LENGTH,
    createPlayStore
};
