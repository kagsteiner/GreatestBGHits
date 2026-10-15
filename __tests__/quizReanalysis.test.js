'use strict';

const { needsAnalysis, parseArgs } = require('../scripts/reanalyze-quizzes');

const evaluation = { win: 0.5, gammonWin: 0.1, backgammonWin: 0.01, gammonLoss: 0.1, backgammonLoss: 0.01 };
const choice = (move, equity) => ({ move, equity, evaluation, ply: 3 });

describe('quiz reanalysis command', () => {
    it('requires apply mode before excluding unrecognized played moves', () => {
        expect(() => parseArgs(['--exclude-unrecognized'])).toThrow('requires --apply');
        expect(parseArgs(['--apply', '--exclude-unrecognized'])).toMatchObject({
            apply: true,
            excludeUnrecognized: true
        });
    });

    it('validates the depth option', () => {
        expect(parseArgs(['--plies', '4']).plies).toBe(4);
        expect(() => parseArgs(['--plies', '9'])).toThrow('--plies must be an integer from 1 to 7');
    });

    it('selects quizzes not yet analysed by the current engine network', () => {
        const current = {
            type: 'move',
            active: true,
            analysis: { engine: 'darkbghelmet', network: 'net-a' },
            best: choice('8/5 6/5', 0.2),
            user: choice('13/9', -0.05),
            higherSample: null,
            lowerSample: choice('24/23 13/10', -0.1)
        };
        expect(needsAnalysis(current, 'net-a')).toBe(false);
        expect(needsAnalysis(current, 'net-b')).toBe(true);
        expect(needsAnalysis({ ...current, analysis: { engine: 'hedgehog' } }, 'net-a')).toBe(true);
        expect(needsAnalysis({ ...current, user: { move: '13/9' } }, 'net-a')).toBe(true);
        expect(needsAnalysis({
            type: 'cube-offer',
            active: false,
            inactiveReason: 'cube-not-available',
            analysis: { engine: 'darkbghelmet', network: 'net-a' }
        }, 'net-a')).toBe(false);
        expect(needsAnalysis({
            type: 'cube-offer',
            active: true,
            analysis: { engine: 'darkbghelmet', network: 'net-a' },
            cubeAnalysis: { noDoubleEquity: 0.1, doubleTakeEquity: 0.3 }
        }, 'net-a')).toBe(true);
    });
});
