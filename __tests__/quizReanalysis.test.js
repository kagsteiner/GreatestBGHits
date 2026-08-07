'use strict';

const { parseArgs } = require('../scripts/reanalyze-quizzes');

describe('quiz reanalysis command', () => {
    it('requires apply mode before excluding unrecognized played moves', () => {
        expect(() => parseArgs(['--exclude-unrecognized'])).toThrow('requires --apply');
        expect(parseArgs(['--apply', '--exclude-unrecognized'])).toMatchObject({
            apply: true,
            excludeUnrecognized: true
        });
    });
});
