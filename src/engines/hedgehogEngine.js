'use strict';

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const BackgammonBoard = require('../board');
const { moveNotationToParts } = require('./moveUtils');

const projectRoot = path.resolve(__dirname, '..', '..');
const defaultAssetDir = path.join(projectRoot, 'vendor', 'hedgehog');

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function loadManifest(assetDir) {
    const manifestPath = process.env.HEDGEHOG_MANIFEST_PATH || path.join(assetDir, 'manifest.json');
    try {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (_) {
        return {};
    }
}

function getConfig(overrides = {}) {
    const assetDir = overrides.assetDir || process.env.HEDGEHOG_ASSET_DIR || defaultAssetDir;
    const manifest = overrides.manifest || loadManifest(assetDir);
    const files = manifest.files || {};
    const ply = positiveInteger(overrides.ply ?? process.env.HEDGEHOG_PLY, 2);
    if (ply > 2) throw new Error('HEDGEHOG_PLY must be 1 or 2 for the community engine');

    return {
        assetDir,
        modulePath: overrides.modulePath || process.env.HEDGEHOG_MODULE_PATH || path.join(assetDir, files.module?.name || 'ogx.js'),
        wasmPath: overrides.wasmPath || process.env.HEDGEHOG_WASM_PATH || path.join(assetDir, files.wasm?.name || 'ogx.wasm'),
        modelPath: overrides.modelPath || process.env.HEDGEHOG_MODEL_PATH || path.join(assetDir, files.model?.name || 'fox.ogxf'),
        expectedHashes: overrides.expectedHashes || {
            module: files.module?.sha256,
            wasm: files.wasm?.sha256,
            model: files.model?.sha256
        },
        ply,
        timeoutMs: positiveInteger(overrides.timeoutMs ?? process.env.HEDGEHOG_TIMEOUT_MS, 120000),
        verbose: overrides.verbose ?? process.env.HEDGEHOG_VERBOSE === '1'
    };
}

class HedgehogEngineClient {
    constructor(config = {}) {
        this.config = getConfig(config);
        this.worker = null;
        this.startPromise = null;
        this.pending = new Map();
        this.nextId = 1;
        this.metadata = null;
        this.lastError = null;
    }

    async analyze(params) {
        let gnuId = params.matchId || params.gnuId;
        if (typeof params.positionId === 'string' && params.positionId && !String(gnuId || '').includes(':')) {
            gnuId = `${params.positionId}:${gnuId}`;
        }
        if (typeof gnuId !== 'string' || !gnuId.includes(':')) {
            return {
                matchId: gnuId,
                positionIndex: params.positionIndex,
                engine: 'hedgehog',
                engineAvailable: false,
                moves: [],
                error: 'Hedgehog analysis requires a GNU positionId:matchId input'
            };
        }

        let board;
        try {
            board = BackgammonBoard.fromGnuId(gnuId);
            if (params.dice) board.dice = params.dice;
        } catch (error) {
            return {
                matchId: gnuId,
                positionIndex: params.positionIndex,
                engine: 'hedgehog',
                engineAvailable: false,
                moves: [],
                error: `Cannot convert position to OGID: ${error.message}`
            };
        }

        const ogid = board.toOgid();
        const d1 = Number(params.dice?.die1 ?? board.dice?.die1);
        const d2 = Number(params.dice?.die2 ?? board.dice?.die2);

        try {
            const result = await this.request('analyze', { ogid, d1, d2, ply: this.config.ply });
            return {
                matchId: gnuId,
                ogid,
                positionIndex: params.positionIndex,
                engine: 'hedgehog',
                engineAvailable: true,
                moves: result.moves.map((move) => ({
                    move: move.move_notation,
                    equity: move.equity_nply,
                    moves: moveNotationToParts(move.move_notation),
                    resultingOgid: move.resulting_ogid,
                    evaluation: move.eval,
                    ply: move.ply || this.config.ply
                })),
                durationMs: result.durationMs,
                bestMoveVerified: result.bestMoveVerified,
                engineMetadata: result.metadata
            };
        } catch (error) {
            this.lastError = error.message;
            return {
                matchId: gnuId,
                ogid,
                positionIndex: params.positionIndex,
                engine: 'hedgehog',
                engineAvailable: false,
                moves: [],
                error: error.message
            };
        }
    }

    async request(action, params = {}) {
        await this.ensureStarted();
        const id = this.nextId++;
        this.worker.ref();

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                const error = new Error(`Hedgehog ${action} timed out after ${this.config.timeoutMs}ms`);
                reject(error);
                this.handleFailure(error);
            }, this.config.timeoutMs);

            this.pending.set(id, { resolve, reject, timeout });
            this.worker.postMessage({ id, action, params });
        });
    }

    ensureStarted() {
        if (this.startPromise) return this.startPromise;

        for (const [label, filePath] of [
            ['module', this.config.modulePath],
            ['WASM', this.config.wasmPath],
            ['model', this.config.modelPath]
        ]) {
            if (!fs.existsSync(filePath)) {
                return Promise.reject(new Error(
                    `Hedgehog ${label} asset is missing at ${filePath}. Run npm run hedgehog:install.`
                ));
            }
        }

        const worker = new Worker(path.join(__dirname, 'hedgehogWorker.mjs'), {
            workerData: this.config
        });
        this.worker = worker;

        worker.on('message', (message) => this.handleMessage(message));
        worker.on('error', (error) => {
            if (this.worker === worker) this.handleFailure(error);
        });
        worker.on('exit', (code) => {
            if (code !== 0 && this.worker === worker) {
                this.handleFailure(new Error(`Hedgehog worker exited with code ${code}`));
            }
        });

        this.startPromise = new Promise((resolve, reject) => {
            this.startResolve = resolve;
            this.startReject = reject;
        });
        return this.startPromise;
    }

    handleMessage(message) {
        if (message.type === 'ready') {
            if (message.success) {
                this.metadata = message.metadata;
                this.startResolve?.(message.metadata);
            } else {
                const error = new Error(message.error || 'Hedgehog worker failed to initialize');
                this.startReject?.(error);
                this.handleFailure(error);
            }
            return;
        }
        if (message.type === 'fatal') {
            this.handleFailure(new Error(message.error || 'Fatal Hedgehog worker error'));
            return;
        }

        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(message.id);
        if (message.type === 'error') pending.reject(new Error(message.error));
        else pending.resolve(message.result);
        if (this.pending.size === 0) this.worker?.unref();
    }

    handleFailure(error) {
        const failedWorker = this.worker;
        this.lastError = error.message;
        this.startReject?.(error);
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pending.clear();
        this.worker = null;
        this.startPromise = null;
        this.startResolve = null;
        this.startReject = null;
        if (failedWorker) {
            failedWorker.removeAllListeners();
            failedWorker.terminate().catch(() => {});
        }
    }

    async close() {
        const worker = this.worker;
        const error = new Error('Hedgehog engine closed');
        this.startReject?.(error);
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pending.clear();
        this.worker = null;
        this.startPromise = null;
        this.startResolve = null;
        this.startReject = null;
        if (worker) await worker.terminate();
    }

    getStatus() {
        return {
            running: !!this.worker,
            pending: this.pending.size,
            metadata: this.metadata,
            lastError: this.lastError,
            config: {
                modulePath: this.config.modulePath,
                wasmPath: this.config.wasmPath,
                modelPath: this.config.modelPath,
                ply: this.config.ply,
                timeoutMs: this.config.timeoutMs
            }
        };
    }
}

let sharedClient = null;

function getSharedClient() {
    if (!sharedClient) sharedClient = new HedgehogEngineClient();
    return sharedClient;
}

async function runHedgehogAnalysis(params) {
    return getSharedClient().analyze(params);
}

runHedgehogAnalysis.getStatus = () => getSharedClient().getStatus();
runHedgehogAnalysis.close = async () => {
    if (sharedClient) await sharedClient.close();
    sharedClient = null;
};
runHedgehogAnalysis.HedgehogEngineClient = HedgehogEngineClient;
runHedgehogAnalysis.getConfig = getConfig;

module.exports = runHedgehogAnalysis;
