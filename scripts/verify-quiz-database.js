'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const BackgammonBoard = require('../src/board');
const { validateEvaluation } = require('../src/quizAnalysis');

function parseArgs(argv) {
    const options = { dbPath: path.resolve(__dirname, '..', 'data', 'app.db'), model: null };
    for (let index = 0; index < argv.length; index++) {
        if (argv[index] === '--db' && argv[index + 1]) options.dbPath = path.resolve(argv[++index]);
        else if (argv[index] === '--model' && argv[index + 1]) options.model = argv[++index];
        else throw new Error(`Unknown or incomplete argument '${argv[index]}'`);
    }
    return options;
}

function assertCanonicalOgid(ogid, label) {
    if (typeof ogid !== 'string' || !ogid) throw new Error(`${label} has no OGID`);
    const canonical = BackgammonBoard.fromOgid(ogid).toOgid();
    if (canonical !== ogid) throw new Error(`${label} has a non-canonical OGID`);
}

function verifyChoice(choice, label, required) {
    if (!choice) {
        if (required) throw new Error(`${label} is missing`);
        return false;
    }
    if (typeof choice.move !== 'string' || !choice.move) throw new Error(`${label} has no move`);
    if (!Number.isFinite(choice.equity)) throw new Error(`${label} has invalid equity`);
    validateEvaluation(choice.evaluation, choice.move);
    if (choice.resultingOgid) assertCanonicalOgid(choice.resultingOgid, `${label} resulting position`);
    return true;
}

function verifyDatabase(options) {
    if (!fs.existsSync(options.dbPath)) throw new Error(`Database not found: ${options.dbPath}`);
    const db = new Database(options.dbPath, { readonly: true, fileMustExist: true });
    try {
        const integrity = db.pragma('integrity_check', { simple: true });
        if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${integrity}`);
        const rows = db.prepare(
            'SELECT username, quizzes_json, analyzed_matches_json FROM user_data ORDER BY username'
        ).all();
        const digest = crypto.createHash('sha256');
        const ids = new Set();
        let quizzes = 0;
        let active = 0;
        let inactive = 0;
        let choicesWithProbabilities = 0;
        let archivedLearningRecords = 0;

        for (const row of rows) {
            digest.update(`${row.username}\0${row.quizzes_json}\0${row.analyzed_matches_json}\n`);
            const payload = JSON.parse(row.quizzes_json);
            if (payload.schemaVersion !== 2 || !Array.isArray(payload.positions)) {
                throw new Error(`User '${row.username}' is not on quiz schema version 2`);
            }
            if (!Number.isFinite(payload.threshold) || payload.threshold < 0) {
                throw new Error(`User '${row.username}' has an invalid mistake threshold`);
            }
            if (payload.cubeThreshold !== undefined
                && (!Number.isFinite(payload.cubeThreshold) || payload.cubeThreshold < 0)) {
                throw new Error(`User '${row.username}' has an invalid cube mistake threshold`);
            }
            for (const position of payload.positions) {
                quizzes += 1;
                if (typeof position.id !== 'string' || !position.id) throw new Error('Quiz has no stable ID');
                const scopedId = `${row.username}\0${position.id}`;
                if (ids.has(scopedId)) throw new Error(`User '${row.username}' has duplicate quiz '${position.id}'`);
                ids.add(scopedId);
                if (Object.prototype.hasOwnProperty.call(position, 'gnuId')) {
                    throw new Error(`Quiz '${position.id}' contains a legacy position ID`);
                }
                assertCanonicalOgid(position.ogid, `Quiz '${position.id}'`);
                if (position.analysis?.engine !== 'hedgehog') {
                    throw new Error(`Quiz '${position.id}' has no Hedgehog provenance`);
                }
                if (!position.analysis.model?.id || !position.analysis.modelHash || !position.analysis.analyzedAt) {
                    throw new Error(`Quiz '${position.id}' has incomplete model provenance`);
                }
                if (options.model && position.analysis.model.id !== options.model) {
                    throw new Error(`Quiz '${position.id}' was analyzed with '${position.analysis.model.id}', not '${options.model}'`);
                }
                const isCube = position.type === 'cube-offer' || position.type === 'cube-response';
                if (isCube) {
                    if (!Number.isFinite(position.best?.equity) || !position.best?.action
                        || !Number.isFinite(position.user?.equity) || !position.user?.action) {
                        throw new Error(`Cube quiz '${position.id}' has invalid decisions`);
                    }
                    if (!Array.isArray(position.options) || position.options.length !== 2) {
                        throw new Error(`Cube quiz '${position.id}' does not have two options`);
                    }
                    for (const field of ['noDoubleEquity', 'doubleTakeEquity', 'doublePassEquity']) {
                        if (!Number.isFinite(position.cubeAnalysis?.[field])) {
                            throw new Error(`Cube quiz '${position.id}' has invalid ${field}`);
                        }
                    }
                } else {
                    choicesWithProbabilities += Number(verifyChoice(position.best, `Quiz '${position.id}' best`, true));
                    choicesWithProbabilities += Number(verifyChoice(position.user, `Quiz '${position.id}' user`, true));
                    choicesWithProbabilities += Number(verifyChoice(position.higherSample, `Quiz '${position.id}' higher sample`, false));
                    choicesWithProbabilities += Number(verifyChoice(position.lowerSample, `Quiz '${position.id}' lower sample`, false));
                }
                if (position.active === true) active += 1;
                else if (position.active === false && position.inactiveReason) inactive += 1;
                else throw new Error(`Quiz '${position.id}' has no valid active state`);
                const playCount = Number(position.quiz?.playCount) || 0;
                const correctAnswers = Number(position.quiz?.correctAnswers) || 0;
                if (playCount < 0 || correctAnswers < 0 || correctAnswers > playCount) {
                    throw new Error(`Quiz '${position.id}' has invalid learning counters`);
                }
                archivedLearningRecords += Array.isArray(position.quiz?.history)
                    ? position.quiz.history.length
                    : 0;
            }
        }
        return {
            sqliteIntegrity: integrity,
            users: rows.length,
            quizzes,
            active,
            inactive,
            choicesWithProbabilities,
            archivedLearningRecords,
            databaseContentSha256: digest.digest('hex')
        };
    } finally {
        db.close();
    }
}

if (require.main === module) {
    try {
        console.log(JSON.stringify(verifyDatabase(parseArgs(process.argv.slice(2))), null, 2));
    } catch (error) {
        console.error(`Quiz database verification failed: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { parseArgs, verifyDatabase };
