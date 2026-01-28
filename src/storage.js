'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DEFAULT_MISTAKE_THRESHOLD } = require('./constants');

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

const selectStmt = db.prepare(
    'SELECT username, quizzes_json, analyzed_matches_json FROM user_data WHERE username = ?'
);
const insertStmt = db.prepare(
    'INSERT INTO user_data (username, quizzes_json, analyzed_matches_json, updated_at) VALUES (?, ?, ?, ?)'
);
const updateStmt = db.prepare(
    'UPDATE user_data SET quizzes_json = ?, analyzed_matches_json = ?, updated_at = ? WHERE username = ?'
);

function normalizeUsername(username) {
    if (typeof username !== 'string') return '';
    return username.trim().toLowerCase();
}

function defaultQuizzesPayload() {
    return {
        engineAvailable: true,
        threshold: DEFAULT_MISTAKE_THRESHOLD,
        positions: []
    };
}

function defaultAnalyzedMatchesPayload() {
    return { matches: [] };
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
    updateStmt.run(
        JSON.stringify(payload),
        row.analyzed_matches_json,
        now,
        row.username
    );
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
    updateStmt.run(
        row.quizzes_json,
        JSON.stringify(payload),
        now,
        row.username
    );
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
            const quizCount = Array.isArray(quizzes.positions) ? quizzes.positions.length : 0;
            return {
                username: row.username,
                quizCount
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
    getQuizByIdFromAllUsers
};


