'use strict';

const mockHedgehog = jest.fn();
mockHedgehog.close = jest.fn();
mockHedgehog.getStatus = jest.fn();
jest.mock('../src/engines/hedgehogEngine', () => mockHedgehog);

const analyzePosition = require('../src/engines/analysisEngine');

beforeEach(() => {
    jest.clearAllMocks();
});

describe('analysis engine', () => {
    it('delegates analysis to Hedgehog', async () => {
        const params = { ogid: 'example', dice: { die1: 3, die2: 1 } };
        const expected = { engine: 'hedgehog', moves: [] };
        mockHedgehog.mockResolvedValue(expected);

        await expect(analyzePosition(params)).resolves.toBe(expected);
        expect(mockHedgehog).toHaveBeenCalledWith(params);
    });

    it('exposes the active model in health status', () => {
        mockHedgehog.getStatus.mockReturnValue({
            running: true,
            pending: 2,
            metadata: { engineVersion: 'test' },
            lastError: null,
            config: {
                modelId: 'aureus-v0.1',
                modelName: 'Aureus v0.1',
                ply: 2,
                timeoutMs: 120000
            }
        });

        expect(analyzePosition.getStatus()).toEqual({
            engine: 'hedgehog',
            running: true,
            pending: 2,
            metadata: { engineVersion: 'test' },
            lastError: null,
            model: 'aureus-v0.1',
            modelName: 'Aureus v0.1',
            ply: 2,
            timeoutMs: 120000
        });
    });
});
