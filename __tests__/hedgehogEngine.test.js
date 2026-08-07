'use strict';

const path = require('path');
const runHedgehogAnalysis = require('../src/engines/hedgehogEngine');
const BackgammonBoard = require('../src/board');

describe('HedgehogEngineClient', () => {
    it('reports missing local assets without affecting the process', async () => {
        const missing = path.join(__dirname, 'fixtures', 'missing-hedgehog-asset');
        const client = new runHedgehogAnalysis.HedgehogEngineClient({
            modulePath: `${missing}.js`,
            wasmPath: `${missing}.wasm`,
            modelPath: `${missing}.ogxf`
        });
        const board = BackgammonBoard.starting();
        board.dice = { die1: 3, die2: 1 };

        const result = await client.analyze({ ogid: board.toOgid(), dice: board.dice });
        expect(result.engineAvailable).toBe(false);
        expect(result.engine).toBe('hedgehog');
        expect(result.error).toContain('npm run hedgehog:install');
    });

    it('rejects community search depths above two', () => {
        expect(() => new runHedgehogAnalysis.HedgehogEngineClient({ ply: 3 }))
            .toThrow('HEDGEHOG_PLY must be 1 or 2');
    });

    it('selects pinned model profiles by ID', () => {
        const config = runHedgehogAnalysis.getConfig({ model: 'fox-v0.3' });
        expect(config.modelId).toBe('fox-v0.3');
        expect(config.modelName).toBe('FOX v0.3');
        expect(path.basename(config.modelPath)).toBe('fox-v0.3.ogxf');
    });

    it('rejects unknown model IDs with the available choices', () => {
        expect(() => runHedgehogAnalysis.getConfig({ model: 'unknown' }))
            .toThrow('Available models: aureus-v0.1, fox-v0.3, fox-v0.32');
    });

    it('accepts legacy separate position and match IDs during migration', async () => {
        const missing = path.join(__dirname, 'fixtures', 'missing-hedgehog-asset');
        const client = new runHedgehogAnalysis.HedgehogEngineClient({
            modulePath: `${missing}.js`,
            wasmPath: `${missing}.wasm`,
            modelPath: `${missing}.ogxf`
        });
        const board = BackgammonBoard.starting();
        const [positionId, matchId] = board.toGnuId().split(':');
        const result = await client.analyze({ positionId, matchId, dice: { die1: 3, die2: 1 } });
        expect(result.matchId).toBe(`${positionId}:${matchId}`);
        expect(result.error).toContain('npm run hedgehog:install');
    });
});
