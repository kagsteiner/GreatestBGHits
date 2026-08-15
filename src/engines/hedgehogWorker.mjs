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
        equity: evaluation.equity,
        cubeful_equity: evaluation.cubeful_equity
    };
}

function firstFinite(...values) {
    return values.find((value) => Number.isFinite(value));
}

function moveEquity(rawMove) {
    // findBestMoveNPly ranks checker plays by cubeful equity. This matters in
    // match play once the cube has been turned; cubeless and cubeful ordering
    // can legitimately disagree.
    return firstFinite(
        rawMove?.cubeful_equity_nply,
        rawMove?.eval?.cubeful_equity,
        rawMove?.equity_nply,
        rawMove?.eval?.equity
    );
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
        equity_nply: moveEquity(rawMove),
        cubeful_equity_nply: firstFinite(
            rawMove.cubeful_equity_nply,
            rawMove.eval?.cubeful_equity
        ),
        cubeless_equity_nply: firstFinite(rawMove.equity_nply, rawMove.eval?.equity),
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
        model: { id: workerData.modelId, name: workerData.modelName },
        networkConfig: engine.getNetworkConfig(),
        modelMetadata: typeof engine.getModelMetadata === 'function' ? engine.getModelMetadata() : null,
        hashes,
        ply: workerData.ply,
        cubePly: workerData.cubePly
    };
}

function relativeCubeOwner(cubeOwner, player) {
    if (!cubeOwner) return 'center';
    return cubeOwner === player ? 'me' : 'opponent';
}

function analyzeCube(params) {
    const {
        ogid,
        cubeValue,
        cubeOwner,
        player,
        matchLength,
        myScore,
        opponentScore,
        cubePly,
        isCrawford
    } = params;
    if (!engine.isValidOgid(ogid)) throw new Error(`Invalid OGID: ${ogid}`);
    if (player !== 'player1' && player !== 'player2') {
        throw new Error('Hedgehog cube analysis requires player1 or player2');
    }
    if (!Number.isInteger(cubeValue) || cubeValue < 1 || (cubeValue & (cubeValue - 1)) !== 0) {
        throw new Error(`Invalid cube value: ${cubeValue}`);
    }
    if (!Number.isInteger(cubePly) || cubePly < 0 || cubePly > 2) {
        throw new Error('The community Hedgehog adapter supports cube ply 0, 1, or 2');
    }
    const modelMetadata = typeof engine.getModelMetadata === 'function'
        ? engine.getModelMetadata()
        : null;
    if (modelMetadata && modelMetadata.supports_cube === false) {
        throw new Error('The selected Hedgehog model does not support cube decisions');
    }

    const startedAt = performance.now();
    const raw = engine.getCubeDecision(
        ogid,
        cubeValue,
        relativeCubeOwner(cubeOwner, player),
        Number.isInteger(matchLength) ? matchLength : 0,
        Number.isInteger(myScore) ? myScore : 0,
        Number.isInteger(opponentScore) ? opponentScore : 0,
        cubePly,
        isCrawford ? 1 : 0
    );
    if (raw?.error) throw new Error(raw.error);

    return {
        available: raw.available !== false,
        action: raw.action,
        shouldDouble: raw.shouldDouble,
        shouldTake: raw.shouldTake,
        cubeDisabled: raw.cubeDisabled || false,
        reason: raw.reason || null,
        noDoubleEquity: raw.noDoubleEquity,
        doubleTakeEquity: raw.doubleTakeEquity,
        doublePassEquity: raw.doublePassEquity,
        noDoubleNormEq: raw.noDoubleNormEq,
        doubleTakeNormEq: raw.doubleTakeNormEq,
        doublePassNormEq: raw.doublePassNormEq,
        takePoint: raw.takePoint,
        doublePoint: raw.doublePoint,
        winProb: raw.winProb ?? raw.gwc,
        equity: raw.equity,
        eval: copyEvaluation(raw.eval),
        durationMs: performance.now() - startedAt,
        metadata
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
    // getMovesNPly is not ordered by strength. copyMove() selects Hedgehog's
    // cubeful equity, matching the dedicated best-move operation. Equal-equity
    // moves are all legitimate best moves.
    moves.sort((a, b) => Number(b.equity_nply) - Number(a.equity_nply));
    const bestResultingOgid = rawBest?.resulting_ogid || null;
    const bestEquity = firstFinite(
        rawBest?.[`equity_${ply}ply`],
        rawBest?.eval?.cubeful_equity,
        rawBest?.eval?.equity
    );
    const bestMoveVerified = moves.length === 0
        ? bestResultingOgid === null
        : moves[0].resulting_ogid === bestResultingOgid
            || (Number.isFinite(bestEquity) && Math.abs(moves[0].equity_nply - bestEquity) < 1e-9);
    // getMovesNPly evaluates the complete candidate list, while Hedgehog's
    // dedicated best-move search can occasionally disagree with it. Keep the
    // fully evaluated cubeful ordering authoritative instead of aborting an
    // entire match import; retain the disagreement for diagnostics.
    const bestMoveDisagreement = bestMoveVerified ? null : {
        candidate: {
            resultingOgid: moves[0]?.resulting_ogid || null,
            move: moves[0]?.move_notation || '',
            equity: moves[0]?.equity_nply
        },
        dedicated: {
            resultingOgid: bestResultingOgid,
            move: rawBest?.move_notation || '',
            equity: bestEquity
        }
    };

    return {
        moves,
        durationMs: performance.now() - startedAt,
        bestMoveVerified,
        bestMoveDisagreement,
        metadata
    };
}

parentPort.on('message', ({ id, action, params }) => {
    try {
        let result;
        if (action === 'analyze') result = analyze(params);
        else if (action === 'analyzeCube') result = analyzeCube(params);
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
