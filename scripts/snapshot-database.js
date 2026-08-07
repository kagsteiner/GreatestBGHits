'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function parseArgs(argv) {
    const options = {
        sourcePath: path.resolve(__dirname, '..', 'data', 'app.db'),
        outputPath: null
    };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--source' && argv[index + 1]) options.sourcePath = path.resolve(argv[++index]);
        else if (arg === '--output' && argv[index + 1]) options.outputPath = path.resolve(argv[++index]);
        else throw new Error(`Unknown or incomplete argument '${arg}'`);
    }
    if (!options.outputPath) throw new Error('--output is required');
    if (options.outputPath === options.sourcePath) throw new Error('Snapshot output must differ from the source database');
    return options;
}

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function inspectSnapshot(snapshotPath) {
    const db = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    try {
        const integrity = db.pragma('integrity_check', { simple: true });
        if (integrity !== 'ok') throw new Error(`snapshot integrity check failed: ${integrity}`);
        const users = db.prepare('SELECT COUNT(*) AS count FROM user_data').get().count;
        return { integrity, users };
    } finally {
        db.close();
    }
}

async function createSnapshot(options) {
    if (!fs.existsSync(options.sourcePath)) throw new Error(`Source database not found: ${options.sourcePath}`);
    if (fs.existsSync(options.outputPath)) throw new Error(`Refusing to overwrite existing snapshot: ${options.outputPath}`);
    const outputDirectory = path.dirname(options.outputPath);
    if (!fs.existsSync(outputDirectory)) throw new Error(`Snapshot directory not found: ${outputDirectory}`);

    const source = new Database(options.sourcePath, { readonly: true, fileMustExist: true });
    try {
        await source.backup(options.outputPath);
    } catch (error) {
        if (fs.existsSync(options.outputPath)) fs.rmSync(options.outputPath);
        throw error;
    } finally {
        source.close();
    }

    const verification = inspectSnapshot(options.outputPath);
    return {
        source: options.sourcePath,
        snapshot: options.outputPath,
        sqliteIntegrity: verification.integrity,
        users: verification.users,
        bytes: fs.statSync(options.outputPath).size,
        sha256: sha256File(options.outputPath)
    };
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
        createSnapshot(options)
            .then((report) => console.log(JSON.stringify(report, null, 2)))
            .catch((error) => {
                console.error(`Database snapshot failed: ${error.message}`);
                process.exitCode = 1;
            });
    }
}

module.exports = { createSnapshot, inspectSnapshot, parseArgs };
