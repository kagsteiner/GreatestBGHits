import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

let engine = null;
let moduleInstance = null;
let metadata = null;

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

function assertChecksum(label, data, expected) {
    const actual = sha256(data);
    if (expected && actual !== expected) {
        throw new Error(`${label} checksum mismatch: expected ${expected}, received ${actual}`);
    }
    return actual;
}

function copyEvaluation(evaluation) {
    if (!evaluation) return null;
    return {
        win: evaluation.win,
        gammon_win: evaluation.gammon_win,
        bg_win: evaluation.bg_win,
        gammon_loss: evaluation.gammon_loss,
        bg_loss: evaluation.bg_loss,
        equity: evaluation.equity
    };
}

function copyMove(rawMove) {
    const structuredMove = [];
    if (rawMove?.move && typeof rawMove.move.length === 'number') {
        for (let index = 0; index < rawMove.move.length; index++) {
            const part = rawMove.move[index];
            if (part) structuredMove.push({ from: part.from, pips: part.pips });
        }
    }
    return {
        resulting_ogid: rawMove.resulting_ogid,
        move_notation: rawMove.move_notation,
        move: structuredMove,
        equity_nply: rawMove.equity_nply ?? rawMove.eval?.equity,
        ply: rawMove.ply,
        eval: copyEvaluation(rawMove.eval)
    };
}

async function initialize() {
    const [moduleSource, wasmBinary, modelBinary] = await Promise.all([
        fs.readFile(workerData.modulePath),
        fs.readFile(workerData.wasmPath),
        fs.readFile(workerData.modelPath)
    ]);

    const hashes = {
        module: assertChecksum('Hedgehog module', moduleSource, workerData.expectedHashes?.module),
        wasm: assertChecksum('Hedgehog WASM', wasmBinary, workerData.expectedHashes?.wasm),
        model: assertChecksum('Hedgehog model', modelBinary, workerData.expectedHashes?.model)
    };

    const imported = await import(pathToFileURL(workerData.modulePath).href);
    const createOGXModule = imported.default;
    if (typeof createOGXModule !== 'function') {
        throw new Error('Hedgehog module has no default createOGXModule export');
    }

    moduleInstance = await createOGXModule({
        print: workerData.verbose ? console.log.bind(console) : () => {},
        printErr: workerData.verbose ? console.error.bind(console) : () => {},
        instantiateWasm(imports, receiveInstance) {
            WebAssembly.instantiate(wasmBinary, imports)
                .then(({ instance }) => receiveInstance(instance))
                .catch((error) => {
                    parentPort.postMessage({ type: 'fatal', error: error.message });
                });
        }
    });

    engine = new moduleInstance.OGXEngine();
    const modelPointer = moduleInstance._malloc(modelBinary.length);
    try {
        moduleInstance.HEAPU8.set(modelBinary, modelPointer);
        if (!engine.loadModelData(modelPointer, modelBinary.length)) {
            throw new Error(engine.getLastLoadError() || 'Hedgehog rejected the model');
        }
    } finally {
        moduleInstance._free(modelPointer);
    }

    metadata = {
        engineVersion: typeof engine.engineVersion === 'function' ? engine.engineVersion() : null,
        networkConfig: engine.getNetworkConfig(),
        modelMetadata: typeof engine.getModelMetadata === 'function' ? engine.getModelMetadata() : null,
        hashes,
        ply: workerData.ply
    };
}

function analyze(params) {
    const { ogid, d1, d2, ply } = params;
    if (!engine.isValidOgid(ogid)) throw new Error(`Invalid OGID: ${ogid}`);
    if (![d1, d2].every((die) => Number.isInteger(die) && die >= 1 && die <= 6)) {
        throw new Error('Hedgehog analysis requires two dice in the range 1..6');
    }
    if (!Number.isInteger(ply) || ply < 1 || ply > 2) {
        throw new Error('The community Hedgehog adapter supports ply 1 or 2');
    }

    const startedAt = performance.now();
    // getMoves() omits the explicit equity_nply field in the current build;
    // use the uniform N-ply API even at depth 1.
    const rawMoves = engine.getMovesNPly(ogid, d1, d2, ply);
    const moves = [];
    for (let index = 0; index < rawMoves.length; index++) moves.push(copyMove(rawMoves[index]));

    const rawBest = engine.findBestMoveNPly(ogid, d1, d2, ply);
    // getMovesNPly is not ordered by strength. Sort explicitly and verify the
    // top equity against the engine's dedicated best-move operation. Equal
    // equity moves are all legitimate best moves.
    moves.sort((a, b) => Number(b.equity_nply) - Number(a.equity_nply));
    const bestResultingOgid = rawBest?.resulting_ogid || null;
    const bestEquity = rawBest?.[`equity_${ply}ply`] ?? rawBest?.eval?.equity;
    const bestMoveVerified = moves.length === 0
        ? bestResultingOgid === null
        : moves[0].resulting_ogid === bestResultingOgid
            || (Number.isFinite(bestEquity) && Math.abs(moves[0].equity_nply - bestEquity) < 1e-9);
    if (!bestMoveVerified) {
        throw new Error('Hedgehog move ordering disagrees with findBestMoveNPly');
    }

    return {
        moves,
        durationMs: performance.now() - startedAt,
        bestMoveVerified,
        metadata
    };
}

parentPort.on('message', ({ id, action, params }) => {
    try {
        let result;
        if (action === 'analyze') result = analyze(params);
        else if (action === 'status') result = metadata;
        else throw new Error(`Unknown Hedgehog worker action: ${action}`);
        parentPort.postMessage({ id, type: 'result', result });
    } catch (error) {
        parentPort.postMessage({ id, type: 'error', error: error.message });
    }
});

initialize()
    .then(() => parentPort.postMessage({ type: 'ready', success: true, metadata }))
    .catch((error) => parentPort.postMessage({ type: 'ready', success: false, error: error.message }));
