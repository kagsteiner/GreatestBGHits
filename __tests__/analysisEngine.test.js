'use strict';

jest.mock('../src/gnubgRunner', () => jest.fn());
jest.mock('../src/engines/hedgehogEngine', () => jest.fn());

const runGnuBgAnalysis = require('../src/gnubgRunner');
const runHedgehogAnalysis = require('../src/engines/hedgehogEngine');
const analyzePosition = require('../src/engines/analysisEngine');

const savedEngine = process.env.ANALYSIS_ENGINE;
const savedReport = process.env.ANALYSIS_COMPARE_REPORT;

beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ANALYSIS_ENGINE;
    delete process.env.ANALYSIS_COMPARE_REPORT;
});

afterAll(() => {
    if (savedEngine === undefined) delete process.env.ANALYSIS_ENGINE;
    else process.env.ANALYSIS_ENGINE = savedEngine;
    if (savedReport === undefined) delete process.env.ANALYSIS_COMPARE_REPORT;
    else process.env.ANALYSIS_COMPARE_REPORT = savedReport;
});

describe('analysis engine selection', () => {
    it('uses GNUbg by default without starting Hedgehog', async () => {
        const expected = { engineAvailable: true, moves: [{ move: '8/5 6/5', equity: 0.1 }] };
        runGnuBgAnalysis.mockResolvedValue(expected);

        await expect(analyzePosition({ matchId: 'position:match' })).resolves.toBe(expected);
        expect(runGnuBgAnalysis).toHaveBeenCalledTimes(1);
        expect(runHedgehogAnalysis).not.toHaveBeenCalled();
    });

    it('uses Hedgehog only when explicitly selected', async () => {
        process.env.ANALYSIS_ENGINE = 'hedgehog';
        const expected = { engine: 'hedgehog', engineAvailable: true, moves: [] };
        runHedgehogAnalysis.mockResolvedValue(expected);

        await expect(analyzePosition({ matchId: 'position:match' })).resolves.toBe(expected);
        expect(runHedgehogAnalysis).toHaveBeenCalledTimes(1);
        expect(runGnuBgAnalysis).not.toHaveBeenCalled();
    });

    it('keeps GNUbg authoritative and attaches diagnostics in compare mode', async () => {
        process.env.ANALYSIS_ENGINE = 'compare';
        const gnu = {
            engineAvailable: true,
            moves: [
                { move: '8/5 6/5', equity: 0.12 },
                { move: '24/21 6/5', equity: 0.08 }
            ]
        };
        const hedgehog = {
            engine: 'hedgehog',
            engineAvailable: true,
            ogid: 'test-ogid',
            engineMetadata: { engineVersion: 'test-version', ply: 2, hashes: { model: 'abc' } },
            moves: [
                { move: '6/5 8/5', equity: 0.14 },
                { move: '24/21 6/5', equity: 0.07 }
            ]
        };
        runGnuBgAnalysis.mockResolvedValue(gnu);
        runHedgehogAnalysis.mockResolvedValue(hedgehog);

        const result = await analyzePosition({
            matchId: 'position:match',
            dice: { die1: 3, die2: 1 },
            playedMove: [{ from: 24, to: 21 }, { from: 6, to: 5 }]
        });

        expect(result.moves).toBe(gnu.moves);
        expect(result.comparison.authoritativeEngine).toBe('gnubg');
        expect(result.comparison.bestMoveAgreement).toBe(true);
        expect(result.comparison.gnu.playedMoveRecognized).toBe(true);
        expect(result.comparison.hedgehog.playedMoveRecognized).toBe(true);
        expect(result.comparison.gnu.playedMoveRank).toBe(2);
        expect(result.comparison.hedgehog.identity).toEqual({
            engineVersion: 'test-version',
            ply: 2,
            hashes: { model: 'abc' }
        });
    });

    it('records a Hedgehog failure without replacing a valid GNUbg result', async () => {
        process.env.ANALYSIS_ENGINE = 'compare';
        const gnu = { engineAvailable: true, moves: [{ move: '8/5 6/5', equity: 0.12 }] };
        runGnuBgAnalysis.mockResolvedValue(gnu);
        runHedgehogAnalysis.mockRejectedValue(new Error('model unavailable'));

        const result = await analyzePosition({ matchId: 'position:match' });
        expect(result.moves).toBe(gnu.moves);
        expect(result.comparison.hedgehog.available).toBe(false);
        expect(result.comparison.hedgehog.error).toBe('model unavailable');
    });

    it('rejects unknown engine names', async () => {
        await expect(analyzePosition({}, { engine: 'mystery' }))
            .rejects.toThrow("Unknown ANALYSIS_ENGINE 'mystery'");
    });
});
