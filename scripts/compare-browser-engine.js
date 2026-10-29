'use strict';

// Compares the browser engine (public/engine/, run here in Node.js) with the
// server engine (bgserver at BG_ENGINE_URL) on stored quizzes: the same
// requests through the same engine client, once over each route.
//
//   node scripts/compare-browser-engine.js [--db data/app.db] [--limit 40] [--plies 2,3]
//
// Run it after scripts/update-browser-engine.js: with the same network both
// must agree; a difference is reported per quiz.

require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');
const { BgEngineClient } = require('../src/engines/bgEngine');
const { EngineBridges } = require('../src/engineBridge');
const { isCubeQuiz, cubeRequestFor } = require('../src/quizAnalysis');

const BRIDGE = '0123456789abcdef0123456789abcdef';
// The builds round differently (native ARM code vs WebAssembly), by about 1e-5.
const EPSILON = 1e-4;
let largest = 0;

function parseArgs(argv) {
    const options = { dbPath: path.resolve(__dirname, '..', 'data', 'app.db'), limit: 40, plies: [2, 3] };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--db' && argv[index + 1]) options.dbPath = path.resolve(argv[++index]);
        else if (arg === '--limit' && argv[index + 1]) options.limit = Number(argv[++index]);
        else if (arg === '--plies' && argv[index + 1]) options.plies = argv[++index].split(',').map(Number);
        else throw new Error(`Unknown or incomplete argument '${arg}'`);
    }
    return options;
}

function storedQuizzes(dbPath, limit) {
    const db = new Database(dbPath, { readonly: true });
    const quizzes = [];
    for (const row of db.prepare('SELECT quizzes_json FROM user_data').all()) {
        const data = JSON.parse(row.quizzes_json || '{}');
        quizzes.push(...(Array.isArray(data.positions) ? data.positions : []).filter((quiz) => quiz.active !== false && quiz.ogid));
    }
    db.close();
    // Every n-th quiz: checker and cube quizzes of all kinds of positions.
    const step = Math.max(1, Math.floor(quizzes.length / limit));
    return quizzes.filter((_, index) => index % step === 0).slice(0, limit);
}

/** The engine work as the quiz analysis panel requests it. */
function analyse(client, quiz, plies) {
    if (isCubeQuiz(quiz)) return client.analyzeCube({ ...cubeRequestFor(quiz), plies });
    return client.analyzeChecker({ ogid: quiz.ogid, dice: quiz.context?.dice, played: quiz.user?.move, plies, maxMoves: 10 });
}

function differences(server, browser) {
    const found = [];
    const close = (a, b) => {
        if (a == null && b == null) return true;
        largest = Math.max(largest, Math.abs(a - b));
        return Math.abs(a - b) < EPSILON;
    };
    if (server.decision !== undefined) {
        if (server.decision !== browser.decision) found.push(`decision ${server.decision} vs ${browser.decision}`);
        for (const key of ['noDoubleEquity', 'doubleTakeEquity', 'doublePassEquity']) {
            if (!close(server[key], browser[key])) found.push(`${key} ${server[key]} vs ${browser[key]}`);
        }
        return found;
    }
    if (server.moves.length !== browser.moves.length) found.push(`${server.moves.length} vs ${browser.moves.length} plays`);
    server.moves.forEach((move, index) => {
        const other = browser.moves[index];
        if (!other || move.move !== other.move || !close(move.equity, other.equity)) {
            found.push(`#${index + 1} ${move.move} ${move.equity} vs ${other?.move} ${other?.equity}`);
        }
    });
    if (server.played?.move !== browser.played?.move || !close(server.played?.equity, browser.played?.equity)) {
        found.push(`played ${server.played?.move} vs ${browser.played?.move}`);
    }
    return found;
}

async function main() {
    const { dbPath, limit, plies } = parseArgs(process.argv.slice(2));
    const BGHelmet = require('../public/engine/bghelmet.js');
    const engineDir = path.join(__dirname, '..', 'public', 'engine');
    const engine = await BGHelmet.load({ net: path.join(engineDir, 'engine.bgnn'), threads: 4 });
    const bridges = new EngineBridges({ network: engine.info().network, pollMs: 1000 });
    const client = new BgEngineClient({ bridges, timeoutMs: 300000 });
    const serverInfo = await client.getInfo();
    console.log(`server engine: ${serverInfo.network} (${client.config.url}); browser engine: ${engine.info().network}`);

    // A page in this process: computes the jobs of requests carrying its id.
    let serving = true;
    (async () => {
        while (serving) {
            for (const job of await bridges.poll(BRIDGE, engine.info())) {
                const method = { '/v1/info': 'info', '/v1/move': 'move', '/v1/cube': 'cube' }[job.path];
                try {
                    bridges.answer(BRIDGE, job.id, engine[method](job.body));
                } catch (error) {
                    bridges.answer(BRIDGE, job.id, undefined, error.message);
                }
            }
        }
    })();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const asPage = (fn) => new Promise((resolve, reject) => {
        bridges.middleware()({ get: () => BRIDGE }, {}, () => fn().then(resolve, reject));
    });

    const quizzes = storedQuizzes(dbPath, limit);
    let compared = 0;
    let differing = 0;
    const time = { server: 0, browser: 0 };
    for (const quiz of quizzes) {
        for (const depth of plies) {
            let t = Date.now();
            const server = await analyse(client, quiz, depth);
            time.server += Date.now() - t;
            t = Date.now();
            const browser = await asPage(() => analyse(client, quiz, depth));
            time.browser += Date.now() - t;
            compared += 1;
            const found = differences(server, browser);
            if (found.length) {
                differing += 1;
                console.log(`quiz ${quiz.id} (${quiz.type}) at ${depth}-ply: ${found.join('; ')}`);
            }
        }
    }
    serving = false;
    bridges.close();
    console.log(`${compared} analyses of ${quizzes.length} quizzes compared, ${differing} differ `
        + `(largest equity difference ${largest.toExponential(1)}); `
        + `time: server ${time.server} ms, browser engine ${time.browser} ms`);
    process.exit(differing ? 1 : 0);
}

main().catch((error) => {
    console.error(error.message);
    process.exit(2);
});
