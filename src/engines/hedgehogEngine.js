'use strict';

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
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
    const models = manifest.models || {};
    const modelId = overrides.model || process.env.HEDGEHOG_MODEL || manifest.defaultModel;
    const modelEntry = models[modelId];
    if (!modelEntry) {
        const available = Object.keys(models).join(', ') || 'none';
        throw new Error(`Unknown Hedgehog model '${modelId || ''}'. Available models: ${available}`);
    }
    const ply = positiveInteger(overrides.ply ?? process.env.HEDGEHOG_PLY, 2);
    if (ply > 2) throw new Error('HEDGEHOG_PLY must be 1 or 2 for the community engine');

    return {
        assetDir,
        modulePath: overrides.modulePath || process.env.HEDGEHOG_MODULE_PATH || path.join(assetDir, files.module?.name || 'ogx.js'),
        wasmPath: overrides.wasmPath || process.env.HEDGEHOG_WASM_PATH || path.join(assetDir, files.wasm?.name || 'ogx.wasm'),
        modelId,
        modelName: modelEntry.displayName || modelId,
        modelPath: overrides.modelPath || process.env.HEDGEHOG_MODEL_PATH || path.join(assetDir, modelEntry.name),
        expectedHashes: overrides.expectedHashes || {
            module: files.module?.sha256,
            wasm: files.wasm?.sha256,
            model: modelEntry.sha256
        },
        ply,
        timeoutMs: positiveInteger(overrides.timeoutMs ?? process.env.HEDGEHOG_TIMEOUT_MS, 120000),
        maxPending: positiveInteger(overrides.maxPending ?? process.env.HEDGEHOG_MAX_PENDING, 4),
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
        const ogid = params?.ogid;
        if (typeof ogid !== 'string' || !ogid) {
            throw new TypeError('Hedgehog analysis requires ogid');
        }
        const d1 = Number(params.dice?.die1);
        const d2 = Number(params.dice?.die2);
        const result = await this.request('analyze', { ogid, d1, d2, ply: this.config.ply });
        return {
            ogid,
            positionIndex: params.positionIndex,
            engine: 'hedgehog',
            moves: result.moves.map((move) => ({
                move: move.move_notation,
                equity: move.equity_nply,
                moves: moveNotationToParts(move.move_notation),
                resultingOgid: move.resulting_ogid,
                evaluation: move.eval ? {
                    win: move.eval.win,
                    gammonWin: move.eval.gammon_win,
                    backgammonWin: move.eval.bg_win,
                    gammonLoss: move.eval.gammon_loss,
                    backgammonLoss: move.eval.bg_loss
                } : null,
                ply: move.ply || this.config.ply
            })),
            durationMs: result.durationMs,
            bestMoveVerified: result.bestMoveVerified,
            engineMetadata: result.metadata
        };
    }

    async request(action, params = {}) {
        await this.ensureStarted();
        if (this.pending.size >= this.config.maxPending) {
            throw new Error(`Hedgehog queue is full (${this.config.maxPending} pending requests)`);
        }
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
                modelId: this.config.modelId,
                modelName: this.config.modelName,
                ply: this.config.ply,
                timeoutMs: this.config.timeoutMs,
                maxPending: this.config.maxPending
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
