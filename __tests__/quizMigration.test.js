'use strict';

const BackgammonBoard = require('../src/board');
const { auditRows, convertRows, parseArgs } = require('../scripts/migrate-quiz-schema');

function rowWithPositions(positions) {
    return {
        username: 'alice',
        quizzes_json: JSON.stringify({
            engineAvailable: true,
            threshold: 0.08,
            customTopLevelData: { keep: true },
            positions
        }),
        analyzed_matches_json: JSON.stringify({ matches: ['123'] }),
        updated_at: '2026-01-01T00:00:00.000Z'
    };
}

describe('quiz schema migration', () => {
    it('converts a legacy position while preserving every unrelated field', () => {
        const original = {
            id: 'q1',
            gnuId: 'WF+DIAngc/ABUA:cAn3ABAAAAAA',
            user: { name: 'alice', move: '8/3 8/5', rank: 9, custom: 'keep' },
            best: { move: '8/3 6/3', equity: 0.087 },
            context: { gameNumber: 1, plyIndex: 16, player: 'player1' },
            quiz: { playCount: 7, correctAnswers: 4 },
            dgGameId: '123',
            arbitrary: { nested: ['data'] }
        };

        const converted = convertRows([rowWithPositions([original])]);
        const payload = JSON.parse(converted.rows[0].quizzes_json);
        const position = payload.positions[0];

        expect(converted.report).toMatchObject({ users: 1, quizzes: 1, converted: 1, alreadyNative: 0 });
        expect(payload.schemaVersion).toBe(2);
        expect(payload.engineAvailable).toBeUndefined();
        expect(payload.customTopLevelData).toEqual({ keep: true });
        expect(position.gnuId).toBeUndefined();
        expect(BackgammonBoard.fromOgid(position.ogid).toOgid()).toBe(position.ogid);
        const { gnuId: _legacy, ...expected } = original;
        expect(position).toEqual({ ...expected, ogid: position.ogid });
    });

    it('is idempotent for native schema-v2 records', () => {
        const board = BackgammonBoard.starting();
        board.dice = { die1: 3, die2: 1 };
        const native = { id: 'q1', ogid: board.toOgid(), user: { move: '8/5 6/5' }, context: {} };
        const first = convertRows([rowWithPositions([native])]);
        const second = convertRows(first.rows);
        expect(second.report.alreadyNative).toBe(1);
        expect(second.rows[0].quizzes_json).toBe(first.rows[0].quizzes_json);
    });

    it('refuses duplicate IDs, malformed IDs, and dice mismatches', () => {
        const legacy = { id: 'q1', gnuId: 'WF+DIAngc/ABUA:cAn3ABAAAAAA', context: {} };
        expect(() => convertRows([rowWithPositions([legacy, legacy])])).toThrow('duplicate quiz ID');
        expect(() => convertRows([rowWithPositions([{ id: 'q1', gnuId: 'bad' }])])).toThrow('positionId:matchId');
        expect(() => convertRows([rowWithPositions([{
            ...legacy,
            context: { dice: { die1: 6, die2: 6 } }
        }])])).toThrow('dice that disagree');
        const board = BackgammonBoard.starting();
        expect(() => convertRows([rowWithPositions([{
            ...legacy,
            ogid: board.toOgid()
        }])])).toThrow("User 'alice' quiz 'q1' cannot be migrated: has conflicting legacy and OGID");
    });

    it('refuses legacy positions where both players occupy one pip', () => {
        expect(() => convertRows([rowWithPositions([{
            id: 'q1',
            gnuId: 'bO4WEgDQc9gBAw:MIGmAEAAIAAA',
            context: { dice: { die1: 5, die2: 1 } }
        }])])).toThrow('both players on absolute pip 13');
    });

    it('audits every legacy position without stopping at the first error', () => {
        const invalid = [
            { id: 'q1', gnuId: 'bO4WEgDQc9gBAw:MIGmAEAAIAAA', context: {} },
            { id: 'q2', gnuId: 'Q8/BASLIV/ABIg:cAl3AWAASAAA', context: {} }
        ];
        const report = auditRows([rowWithPositions(invalid)]);

        expect(report).toMatchObject({ users: 1, quizzes: 2, errorCount: 2 });
        expect(report.errors.map((error) => error.id)).toEqual(['q1', 'q2']);
    });

    it('keeps structural audit read-only and mutually exclusive with apply', () => {
        expect(parseArgs(['--audit']).audit).toBe(true);
        expect(() => parseArgs(['--audit', '--apply'])).toThrow('cannot be combined');
    });
});
