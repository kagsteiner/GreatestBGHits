'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bgEngine = require('../src/engines/bgEngine');
const { analyzeQuiz, applyQuizAnalysis, isCubeQuiz, validateEvaluation } = require('../src/quizAnalysis');

function parseArgs(argv) {
    const options = {
        dbPath: path.resolve(__dirname, '..', 'data', 'app.db'),
        apply: false,
        audit: false,
        excludeUnrecognized: false,
        plies: null,
        limit: Infinity
    };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--apply') options.apply = true;
        else if (arg === '--audit') options.audit = true;
        else if (arg === '--exclude-unrecognized') options.excludeUnrecognized = true;
        else if (arg === '--db' && argv[index + 1]) options.dbPath = path.resolve(argv[++index]);
        else if (arg === '--plies' && argv[index + 1]) options.plies = Number(argv[++index]);
        else if (arg === '--limit' && argv[index + 1]) options.limit = Number(argv[++index]);
        else throw new Error(`Unknown or incomplete argument '${arg}'`);
    }
    if (!Number.isFinite(options.limit) && options.limit !== Infinity) throw new Error('--limit must be a number');
    if (options.limit < 1) throw new Error('--limit must be at least 1');
    if (options.plies !== null && (!Number.isInteger(options.plies) || options.plies < 1 || options.plies > 7)) {
        throw new Error('--plies must be an integer from 1 to 7');
    }
    if (options.apply && options.audit) throw new Error('--apply and --audit cannot be combined');
    if (options.excludeUnrecognized && !options.apply) {
        throw new Error('--exclude-unrecognized requires --apply');
    }
    return options;
}

function hasValidChoice(choice) {
    if (!choice) return false;
    if (!Number.isFinite(choice.equity)) return false;
    if (!choice.evaluation) return true;
    try {
        return validateEvaluation(choice.evaluation, choice.move || '?');
    } catch (_) {
        return false;
    }
}

function needsAnalysis(position, network) {
    if (position.analysis?.engine !== bgEngine.ENGINE_ID || position.analysis?.network !== network) return true;
    if (position.active === false && ['forced-move', 'cube-not-available'].includes(position.inactiveReason)) {
        return false;
    }
    if (isCubeQuiz(position)) {
        return !Number.isFinite(position.cubeAnalysis?.noDoubleEquity)
            || !Number.isFinite(position.cubeAnalysis?.doubleTakeEquity)
            || !Number.isFinite(position.cubeAnalysis?.doublePassEquity);
    }
    return !hasValidChoice(position.best)
        || !hasValidChoice(position.user)
        || ![position.higherSample, position.lowerSample]
            .every((choice) => choice == null || hasValidChoice(choice));
}

function thresholdFor(position, payload) {
    return isCubeQuiz(position) ? payload.cubeThreshold : payload.threshold;
}

function applyStoredAnalysis(position, analysis, payload, analyzedAt) {
    // A bulk reanalysis replaces the authoritative result. Drop the markers
    // of an earlier on-demand deep analysis so the UI does not claim that the
    // replaced result is still the saved deep analysis.
    const source = { ...position };
    delete source.deepAnalysis;
    delete source.fastAnalysis;
    return applyQuizAnalysis(source, analysis.result, {
        threshold: thresholdFor(position, payload),
        alternatives: analysis.alternatives,
        analyzedAt
    });
}

function inventory(db, network) {
    const rows = db.prepare('SELECT username, quizzes_json FROM user_data ORDER BY username').all();
    const pending = [];
    let quizzes = 0;
    for (const row of rows) {
        const payload = JSON.parse(row.quizzes_json);
        if (payload.schemaVersion !== 2 || !Array.isArray(payload.positions)) {
            throw new Error(`User '${row.username}' has not completed the schema-v2 migration`);
        }
        for (const position of payload.positions) {
            quizzes += 1;
            if (typeof position.ogid !== 'string' || !position.ogid) {
                throw new Error(`Quiz '${position.id || '?'}' has no OGID`);
            }
            if (Object.prototype.hasOwnProperty.call(position, 'gnuId')) {
                throw new Error(`Quiz '${position.id || '?'}' still contains a legacy position ID`);
            }
            if (needsAnalysis(position, network)) {
                pending.push({ username: row.username, id: position.id, ogid: position.ogid });
            }
        }
    }
    return { users: rows.length, quizzes, pending };
}

async function reanalyze(options) {
    if (!fs.existsSync(options.dbPath)) throw new Error(`Database not found: ${options.dbPath}`);
    const client = bgEngine.getClient();
    const { network } = await client.getInfo();
    const plies = options.plies || client.config.plies;
    const analyze = (position, payload) => analyzeQuiz(client, position, {
        plies,
        threshold: thresholdFor(position, payload)
    });
    const db = new Database(options.dbPath, { readonly: !options.apply, fileMustExist: true });
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    let backupPath = null;
    try {
        const before = inventory(db, network);
        const work = before.pending.slice(0, options.limit);
        if (!options.apply && !options.audit) {
            return {
                mode: 'dry-run',
                network,
                plies,
                users: before.users,
                quizzes: before.quizzes,
                pending: before.pending.length,
                selected: work.length,
                backupPath
            };
        }

        if (options.audit) {
            const errors = [];
            let checked = 0;
            const selectUser = db.prepare('SELECT quizzes_json FROM user_data WHERE username = ?');
            for (const item of work) {
                const row = selectUser.get(item.username);
                const payload = JSON.parse(row.quizzes_json);
                const current = payload.positions.find((position) => position.id === item.id);
                try {
                    const analysis = await analyze(current, payload);
                    applyStoredAnalysis(current, analysis, payload);
                } catch (error) {
                    errors.push({
                        username: item.username,
                        id: item.id,
                        ogid: item.ogid,
                        playedMove: current.user?.move || null,
                        category: error.code === 'QUIZ_MOVE_NOT_RECOGNIZED'
                            ? 'unrecognized-played-move'
                            : 'analysis-error',
                        error: error.message
                    });
                }
                checked += 1;
                if (checked % 100 === 0 || checked === work.length) {
                    console.log(`Audited ${checked}/${work.length} quizzes; ${errors.length} errors`);
                }
            }
            return {
                mode: 'audit',
                network,
                plies,
                users: before.users,
                quizzes: before.quizzes,
                pending: before.pending.length,
                checked,
                errorCount: errors.length,
                errors
            };
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        backupPath = `${options.dbPath}.pre-reanalysis-${timestamp}.backup`;
        await db.backup(backupPath);

        const selectUser = db.prepare('SELECT quizzes_json FROM user_data WHERE username = ?');
        const updateUser = db.prepare('UPDATE user_data SET quizzes_json = ?, updated_at = ? WHERE username = ?');
        const saveResult = db.transaction((item, analysis) => {
            const row = selectUser.get(item.username);
            if (!row) throw new Error(`User '${item.username}' disappeared during migration`);
            const payload = JSON.parse(row.quizzes_json);
            const index = payload.positions.findIndex((position) => position.id === item.id);
            if (index < 0) throw new Error(`Quiz '${item.id}' disappeared during migration`);
            const current = payload.positions[index];
            if (current.ogid !== item.ogid) throw new Error(`Quiz '${item.id}' changed position during migration`);
            payload.positions[index] = applyStoredAnalysis(
                current,
                analysis,
                payload,
                new Date().toISOString()
            );
            updateUser.run(JSON.stringify(payload), new Date().toISOString(), item.username);
            return payload.positions[index];
        });
        const removeQuiz = db.transaction((item) => {
            const row = selectUser.get(item.username);
            if (!row) throw new Error(`User '${item.username}' disappeared during migration`);
            const payload = JSON.parse(row.quizzes_json);
            const index = payload.positions.findIndex((position) => position.id === item.id);
            if (index < 0) throw new Error(`Quiz '${item.id}' disappeared during migration`);
            if (payload.positions[index].ogid !== item.ogid) {
                throw new Error(`Quiz '${item.id}' changed position during migration`);
            }
            const [removed] = payload.positions.splice(index, 1);
            updateUser.run(JSON.stringify(payload), new Date().toISOString(), item.username);
            return removed;
        });

        let completed = 0;
        let processed = 0;
        let inactive = 0;
        let resetLearningHistory = 0;
        const excluded = [];
        for (const item of work) {
            let analysis;
            processed += 1;
            try {
                const row = selectUser.get(item.username);
                const payload = JSON.parse(row.quizzes_json);
                const current = payload.positions.find((position) => position.id === item.id);
                analysis = await analyze(current, payload);
                const beforeHistoryLength = Array.isArray(current.quiz?.history)
                    ? current.quiz.history.length
                    : 0;
                const updated = saveResult(item, analysis);
                completed += 1;
                if (!updated.active) inactive += 1;
                if ((updated.quiz?.history?.length || 0) > beforeHistoryLength) {
                    resetLearningHistory += 1;
                }
                const progressInterval = work.length >= 1000 ? 100 : 10;
                if (processed % progressInterval === 0 || processed === work.length) {
                    console.log(`Processed ${processed}/${work.length} quizzes; excluded ${excluded.length}`);
                }
            } catch (error) {
                if (options.excludeUnrecognized && error.code === 'QUIZ_MOVE_NOT_RECOGNIZED') {
                    const removed = removeQuiz(item);
                    excluded.push({
                        username: item.username,
                        id: item.id,
                        ogid: item.ogid,
                        playedMove: removed.user?.move || null,
                        reason: error.message
                    });
                    console.log(`Excluded unrecognized quiz '${item.id}' for user '${item.username}'`);
                    continue;
                }
                throw new Error(`Stopped at quiz '${item.id}' for user '${item.username}': ${error.message}`);
            }
        }

        const integrity = db.pragma('integrity_check', { simple: true });
        if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${integrity}`);
        const after = inventory(db, network);
        return {
            mode: 'applied',
            network,
            plies,
            users: after.users,
            quizzes: after.quizzes,
            completed,
            excludedCount: excluded.length,
            excluded,
            remaining: after.pending.length,
            inactive,
            resetLearningHistory,
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
        reanalyze(options)
            .then((report) => console.log(JSON.stringify(report, null, 2)))
            .catch((error) => {
                console.error(`Quiz reanalysis failed: ${error.message}`);
                process.exitCode = 1;
            });
    }
}

module.exports = { hasValidChoice, inventory, needsAnalysis, parseArgs, reanalyze };
