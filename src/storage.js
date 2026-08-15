'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const {
    DEFAULT_MISTAKE_THRESHOLD,
    DEFAULT_CUBE_MISTAKE_THRESHOLD,
    MATCH_ANALYSIS_VERSION
} = require('./constants');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'app.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS user_data (
    username TEXT PRIMARY KEY,
    quizzes_json TEXT NOT NULL,
    analyzed_matches_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
`);

db.exec(`
CREATE TABLE IF NOT EXISTS daily_activity (
    date TEXT PRIMARY KEY,
    quizzes_added INTEGER NOT NULL DEFAULT 0,
    quizzes_served INTEGER NOT NULL DEFAULT 0,
    logins INTEGER NOT NULL DEFAULT 0
)
`);

db.exec(`
CREATE TABLE IF NOT EXISTS monthly_activity (
    month TEXT PRIMARY KEY,
    days INTEGER NOT NULL DEFAULT 0,
    quizzes_added INTEGER NOT NULL DEFAULT 0,
    quizzes_served INTEGER NOT NULL DEFAULT 0,
    logins INTEGER NOT NULL DEFAULT 0
)
`);

db.exec(`
CREATE TABLE IF NOT EXISTS admin_notice_seen (
    username TEXT NOT NULL,
    message_hash TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    PRIMARY KEY (username, message_hash)
)
`);

const selectStmt = db.prepare(
    'SELECT username, quizzes_json, analyzed_matches_json FROM user_data WHERE username = ?'
);
const insertStmt = db.prepare(
    'INSERT INTO user_data (username, quizzes_json, analyzed_matches_json, updated_at) VALUES (?, ?, ?, ?)'
);
const updateStmt = db.prepare(
    'UPDATE user_data SET quizzes_json = ?, analyzed_matches_json = ?, updated_at = ? WHERE username = ?'
);
const updateQuizzesStmt = db.prepare(
    'UPDATE user_data SET quizzes_json = ?, updated_at = ? WHERE username = ?'
);
const updateAnalyzedMatchesStmt = db.prepare(
    'UPDATE user_data SET analyzed_matches_json = ?, updated_at = ? WHERE username = ?'
);
const insertAdminNoticeSeenStmt = db.prepare(
    'INSERT OR IGNORE INTO admin_notice_seen (username, message_hash, seen_at) VALUES (?, ?, ?)'
);

function normalizeUsername(username) {
    if (typeof username !== 'string') return '';
    return username.trim().toLowerCase();
}

function defaultQuizzesPayload() {
    return {
        schemaVersion: 2,
        threshold: DEFAULT_MISTAKE_THRESHOLD,
        cubeThreshold: DEFAULT_CUBE_MISTAKE_THRESHOLD,
        positions: []
    };
}

function defaultAnalyzedMatchesPayload() {
    return { analysisVersion: MATCH_ANALYSIS_VERSION, matches: [] };
}

function ensureRow(username) {
    const normalized = normalizeUsername(username);
    if (!normalized) {
        throw new Error('Username is required');
    }
    let row = selectStmt.get(normalized);
    if (!row) {
        const quizzes = JSON.stringify(defaultQuizzesPayload());
        const matches = JSON.stringify(defaultAnalyzedMatchesPayload());
        const now = new Date().toISOString();
        insertStmt.run(normalized, quizzes, matches, now);
        row = { username: normalized, quizzes_json: quizzes, analyzed_matches_json: matches };
    }
    return row;
}

function readQuizzes(username) {
    const row = ensureRow(username);
    return JSON.parse(row.quizzes_json);
}

function writeQuizzes(username, quizzesPayload) {
    const row = ensureRow(username);
    const payload = quizzesPayload || defaultQuizzesPayload();
    const now = new Date().toISOString();
    updateQuizzesStmt.run(JSON.stringify(payload), now, row.username);
    return payload;
}

function readAnalyzedMatches(username) {
    const row = ensureRow(username);
    return JSON.parse(row.analyzed_matches_json);
}

function writeAnalyzedMatches(username, matchesPayload) {
    const row = ensureRow(username);
    const payload = matchesPayload || defaultAnalyzedMatchesPayload();
    const now = new Date().toISOString();
    updateAnalyzedMatchesStmt.run(JSON.stringify(payload), now, row.username);
    return payload;
}

function updateUserData(username, updater) {
    const normalized = normalizeUsername(username);
    if (!normalized) {
        throw new Error('Username is required');
    }
    const txn = db.transaction((userKey) => {
        const row = ensureRow(userKey);
        const current = {
            quizzes: JSON.parse(row.quizzes_json),
            analyzedMatches: JSON.parse(row.analyzed_matches_json)
        };
        const updates = updater(current) || {};
        const nextQuizzes = updates.quizzes || current.quizzes;
        const nextMatches = updates.analyzedMatches || current.analyzedMatches;
        updateStmt.run(
            JSON.stringify(nextQuizzes),
            JSON.stringify(nextMatches),
            new Date().toISOString(),
            row.username
        );
        return { quizzes: nextQuizzes, analyzedMatches: nextMatches };
    });
    return txn(normalized);
}

function getAllUsersStats() {
    const selectAllStmt = db.prepare('SELECT username, quizzes_json FROM user_data');
    const rows = selectAllStmt.all();
    return rows.map(row => {
        try {
            const quizzes = JSON.parse(row.quizzes_json);
            const positions = Array.isArray(quizzes.positions) ? quizzes.positions : [];
            const quizCount = positions.filter(
                (position) => position?.active === true && position?.analysis?.engine === 'hedgehog'
            ).length;
            return {
                username: row.username,
                quizCount,
                storedQuizCount: positions.length
            };
        } catch (error) {
            return {
                username: row.username,
                quizCount: 0
            };
        }
    });
}

/**
 * Search for a quiz by ID across ALL users' quizzes.
 * Returns the quiz object with additional _username field if found, null otherwise.
 * @param {string} id - The quiz ID to search for
 * @returns {object|null}
 */
function getQuizByIdFromAllUsers(id) {
    if (!id || typeof id !== 'string') return null;
    const selectAllStmt = db.prepare('SELECT username, quizzes_json FROM user_data');
    const rows = selectAllStmt.all();
    for (const row of rows) {
        try {
            const quizzes = JSON.parse(row.quizzes_json);
            const positions = Array.isArray(quizzes.positions) ? quizzes.positions : [];
            const quiz = positions.find(p => p && p.id === id);
            if (quiz) {
                // Return quiz with owner username attached
                return { ...quiz, _username: row.username };
            }
        } catch (error) {
            // Skip malformed entries
            continue;
        }
    }
    return null;
}

/**
 * Atomically records that a user has seen an admin notice hash.
 * @param {string} username
 * @param {string} messageHash
 * @returns {boolean} true only the first time this user/hash is recorded
 */
function consumeAdminNotice(username, messageHash) {
    const normalized = normalizeUsername(username);
    if (!normalized || !messageHash || typeof messageHash !== 'string') {
        return false;
    }
    const info = insertAdminNoticeSeenStmt.run(normalized, messageHash, new Date().toISOString());
    return info.changes > 0;
}

// --------------- Activity tracking ---------------

function todayDateStr() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function currentMonthStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const upsertDailyStmt = db.prepare(`
    INSERT INTO daily_activity (date, quizzes_added, quizzes_served, logins)
    VALUES (@date, @quizzes_added, @quizzes_served, @logins)
    ON CONFLICT(date) DO UPDATE SET
        quizzes_added = quizzes_added + excluded.quizzes_added,
        quizzes_served = quizzes_served + excluded.quizzes_served,
        logins = logins + excluded.logins
`);

/**
 * Increment an activity counter for today.
 * @param {'quizzes_added'|'quizzes_served'|'logins'} type
 * @param {number} [count=1]
 */
function recordActivity(type, count) {
    const n = count || 1;
    const row = { date: todayDateStr(), quizzes_added: 0, quizzes_served: 0, logins: 0 };
    row[type] = n;
    upsertDailyStmt.run(row);
}

const rollupStmt = db.prepare(`
    INSERT INTO monthly_activity (month, days, quizzes_added, quizzes_served, logins)
    VALUES (@month, @days, @quizzes_added, @quizzes_served, @logins)
    ON CONFLICT(month) DO UPDATE SET
        days = excluded.days,
        quizzes_added = excluded.quizzes_added,
        quizzes_served = excluded.quizzes_served,
        logins = excluded.logins
`);

/**
 * Move any daily_activity rows from past months into monthly_activity, then delete them.
 */
function rollupPastMonths() {
    const curMonth = currentMonthStr();
    const pastRows = db.prepare(
        "SELECT date, quizzes_added, quizzes_served, logins FROM daily_activity WHERE substr(date,1,7) != ?"
    ).all(curMonth);

    if (pastRows.length === 0) return;

    const byMonth = new Map();
    for (const r of pastRows) {
        const m = r.date.substring(0, 7);
        if (!byMonth.has(m)) byMonth.set(m, { quizzes_added: 0, quizzes_served: 0, logins: 0, days: 0 });
        const agg = byMonth.get(m);
        agg.quizzes_added += r.quizzes_added;
        agg.quizzes_served += r.quizzes_served;
        agg.logins += r.logins;
        agg.days += 1;
    }

    const txn = db.transaction(() => {
        for (const [month, agg] of byMonth) {
            rollupStmt.run({ month, ...agg });
        }
        db.prepare("DELETE FROM daily_activity WHERE substr(date,1,7) != ?").run(curMonth);
    });
    txn();
}

/**
 * Return activity stats: current month daily breakdown + all past monthly aggregates.
 */
function getActivityStats() {
    rollupPastMonths();

    const curMonth = currentMonthStr();
    const dailyRows = db.prepare(
        "SELECT date, quizzes_added, quizzes_served, logins FROM daily_activity ORDER BY date DESC"
    ).all();

    const monthlyRows = db.prepare(
        "SELECT month, days, quizzes_added, quizzes_served, logins FROM monthly_activity ORDER BY month DESC"
    ).all();

    return {
        currentMonth: { month: curMonth, days: dailyRows },
        months: monthlyRows
    };
}

module.exports = {
    normalizeUsername,
    defaultQuizzesPayload,
    defaultAnalyzedMatchesPayload,
    readQuizzes,
    writeQuizzes,
    readAnalyzedMatches,
    writeAnalyzedMatches,
    updateUserData,
    getAllUsersStats,
    getQuizByIdFromAllUsers,
    consumeAdminNotice,
    recordActivity,
    getActivityStats
};
