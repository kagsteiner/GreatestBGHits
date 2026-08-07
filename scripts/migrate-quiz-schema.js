'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const BackgammonBoard = require('../src/board');
const { decodeLegacyPositionId } = require('./migrations/legacy-position-id');

function parseArgs(argv) {
    const result = { dbPath: path.resolve(__dirname, '..', 'data', 'app.db'), apply: false, audit: false };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--apply') result.apply = true;
        else if (arg === '--audit') result.audit = true;
        else if (arg === '--db' && argv[index + 1]) result.dbPath = path.resolve(argv[++index]);
        else throw new Error(`Unknown or incomplete argument '${arg}'`);
    }
    if (result.apply && result.audit) throw new Error('--apply and --audit cannot be combined');
    return result;
}

function stableDigest(records) {
    const hash = crypto.createHash('sha256');
    for (const record of records) hash.update(`${JSON.stringify(record)}\n`);
    return hash.digest('hex');
}

function preservedPayload(username, payload) {
    const copy = JSON.parse(JSON.stringify(payload));
    delete copy.schemaVersion;
    delete copy.engineAvailable;
    copy.positions = (copy.positions || []).map((position) => {
        const preserved = { ...position };
        delete preserved.gnuId;
        delete preserved.ogid;
        return preserved;
    });
    return { username, payload: copy };
}

function convertRows(rows) {
    const convertedRows = [];
    const beforeData = [];
    const afterData = [];
    const ids = new Set();
    let quizCount = 0;
    let convertedCount = 0;
    let alreadyNativeCount = 0;

    for (const row of rows) {
        let payload;
        try {
            payload = JSON.parse(row.quizzes_json);
        } catch (error) {
            throw new Error(`User '${row.username}' has invalid quiz JSON: ${error.message}`);
        }
        if (!Array.isArray(payload.positions)) {
            throw new Error(`User '${row.username}' has no positions array`);
        }
        if (!Number.isFinite(payload.threshold) || payload.threshold < 0) {
            throw new Error(`User '${row.username}' has an invalid mistake threshold`);
        }
        beforeData.push(preservedPayload(row.username, payload));

        const positions = payload.positions.map((original, index) => {
            if (!original || typeof original !== 'object') {
                throw new Error(`User '${row.username}' position ${index} is not an object`);
            }
            if (typeof original.id !== 'string' || !original.id) {
                throw new Error(`User '${row.username}' position ${index} has no stable ID`);
            }
            const scopedId = `${row.username}\0${original.id}`;
            if (ids.has(scopedId)) throw new Error(`User '${row.username}' has duplicate quiz ID '${original.id}'`);
            ids.add(scopedId);
            const position = { ...original };
            let board;
            try {
                if (typeof position.ogid === 'string' && position.ogid) {
                    board = BackgammonBoard.fromOgid(position.ogid);
                    if (board.toOgid() !== position.ogid) {
                        throw new Error('has a non-canonical OGID');
                    }
                    if (typeof position.gnuId === 'string' && position.gnuId) {
                        const decodedLegacy = decodeLegacyPositionId(position.gnuId);
                        const legacyOgid = decodedLegacy.board.toOgid({ crawford: decodedLegacy.crawford });
                        if (legacyOgid !== position.ogid) {
                            throw new Error('has conflicting legacy and OGID positions');
                        }
                    }
                    alreadyNativeCount += 1;
                } else {
                    const decoded = decodeLegacyPositionId(position.gnuId);
                    board = decoded.board;
                    position.ogid = board.toOgid({ crawford: decoded.crawford });
                    convertedCount += 1;
                }
            } catch (error) {
                throw new Error(`User '${row.username}' quiz '${original.id}' cannot be migrated: ${error.message}`);
            }

            if (position.context?.dice) {
                const expected = position.context.dice;
                if (board.dice?.die1 !== expected.die1 || board.dice?.die2 !== expected.die2) {
                    throw new Error(`Quiz '${original.id}' has dice that disagree with its encoded position`);
                }
            }
            delete position.gnuId;
            quizCount += 1;
            return position;
        });

        const converted = { ...payload, schemaVersion: 2, positions };
        delete converted.engineAvailable;
        afterData.push(preservedPayload(row.username, converted));
        convertedRows.push({ ...row, quizzes_json: JSON.stringify(converted) });
    }

    const beforeDigest = stableDigest(beforeData);
    const afterDigest = stableDigest(afterData);
    if (beforeDigest !== afterDigest) throw new Error('Migration changed data outside the position-ID/schema conversion');

    return {
        rows: convertedRows,
        report: {
            users: rows.length,
            quizzes: quizCount,
            converted: convertedCount,
            alreadyNative: alreadyNativeCount,
            preservedDataSha256: beforeDigest
        }
    };
}

function auditRows(rows) {
    const errors = [];
    let quizzes = 0;
    const ids = new Set();
    for (const row of rows) {
        let payload;
        try {
            payload = JSON.parse(row.quizzes_json);
        } catch (error) {
            errors.push({ username: row.username, id: null, error: `Invalid quiz JSON: ${error.message}` });
            continue;
        }
        if (!Array.isArray(payload.positions)) {
            errors.push({ username: row.username, id: null, error: 'No positions array' });
            continue;
        }
        for (const position of payload.positions) {
            quizzes += 1;
            const id = typeof position?.id === 'string' && position.id ? position.id : null;
            const scopedId = id ? `${row.username}\0${id}` : null;
            if (scopedId && ids.has(scopedId)) {
                errors.push({ username: row.username, id, error: `Duplicate quiz ID '${id}'` });
                continue;
            }
            if (scopedId) ids.add(scopedId);
            const singleRow = {
                ...row,
                quizzes_json: JSON.stringify({ ...payload, positions: [position] })
            };
            try {
                convertRows([singleRow]);
            } catch (error) {
                errors.push({ username: row.username, id, error: error.message });
            }
        }
    }
    return { users: rows.length, quizzes, errorCount: errors.length, errors };
}

async function migrate(options) {
    if (!fs.existsSync(options.dbPath)) throw new Error(`Database not found: ${options.dbPath}`);
    const db = new Database(options.dbPath, { readonly: !options.apply, fileMustExist: true });
    db.pragma('foreign_keys = ON');
    try {
        const rows = db.prepare(
            'SELECT username, quizzes_json, analyzed_matches_json, updated_at FROM user_data ORDER BY username'
        ).all();
        if (options.audit) return { mode: 'audit', ...auditRows(rows) };
        const converted = convertRows(rows);
        if (!options.apply) return { ...converted.report, mode: 'dry-run', backupPath: null };

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${options.dbPath}.pre-hedgehog-${timestamp}.backup`;
        await db.backup(backupPath);

        const update = db.prepare(
            'UPDATE user_data SET quizzes_json = ?, updated_at = ? WHERE username = ?'
        );
        const applyTransaction = db.transaction(() => {
            const now = new Date().toISOString();
            for (const row of converted.rows) update.run(row.quizzes_json, now, row.username);
            const verificationRows = db.prepare(
                'SELECT username, quizzes_json, analyzed_matches_json, updated_at FROM user_data ORDER BY username'
            ).all();
            const verification = convertRows(verificationRows).report;
            if (verification.preservedDataSha256 !== converted.report.preservedDataSha256
                || verification.alreadyNative !== converted.report.quizzes) {
                throw new Error('Post-migration verification failed; transaction rolled back');
            }
            return verification;
        });
        const verification = applyTransaction();
        const integrity = db.pragma('integrity_check', { simple: true });
        if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${integrity}; restore ${backupPath}`);
        return {
            ...converted.report,
            verifiedNative: verification.alreadyNative,
            mode: 'applied',
            backupPath
        };
    } finally {
        db.close();
    }
}

if (require.main === module) {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
    if (options) {
        migrate(options)
            .then((report) => console.log(JSON.stringify(report, null, 2)))
            .catch((error) => {
                console.error(`Quiz migration failed: ${error.message}`);
                process.exitCode = 1;
            });
    }
}

module.exports = { auditRows, convertRows, migrate, parseArgs };
