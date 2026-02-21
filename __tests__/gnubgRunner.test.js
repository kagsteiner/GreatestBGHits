'use strict';

const EventEmitter = require('events');

let mockSpawn;
jest.mock('child_process', () => ({
    spawn: (...args) => mockSpawn(...args)
}));

const fs = require('fs');
const runGnuBgAnalysis = require('../src/gnubgRunner');

beforeEach(() => {
    jest.clearAllMocks();
    mockSpawn = jest.fn();
});

describe('gnubgRunner', () => {
    describe('missing GNU_BG_PATH', () => {
        it('resolves with engineAvailable: false when GNU_BG_PATH is unset', async () => {
            const saved = process.env.GNU_BG_PATH;
            delete process.env.GNU_BG_PATH;

            try {
                const result = await runGnuBgAnalysis({ matchId: 'test:id' });
                expect(result.engineAvailable).toBe(false);
                expect(result.moves).toEqual([]);
                expect(result.matchId).toBe('test:id');
            } finally {
                if (saved !== undefined) process.env.GNU_BG_PATH = saved;
            }
        });
    });

    describe('missing python script', () => {
        it('rejects when python bridge script is not found', async () => {
            const saved = process.env.GNU_BG_PATH;
            process.env.GNU_BG_PATH = '/fake/gnubg';

            const pythonScript = require('path').resolve(__dirname, '..', 'python', 'analyze_position.py');
            jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
                if (p === pythonScript) return false;
                return true;
            });

            try {
                await expect(runGnuBgAnalysis({ matchId: 'test:id' }))
                    .rejects.toThrow('Python bridge script not found');
            } finally {
                if (saved !== undefined) {
                    process.env.GNU_BG_PATH = saved;
                } else {
                    delete process.env.GNU_BG_PATH;
                }
                jest.restoreAllMocks();
            }
        });
    });

    describe('spawn error', () => {
        it('rejects when gnubg fails to start', async () => {
            const saved = process.env.GNU_BG_PATH;
            process.env.GNU_BG_PATH = '/fake/gnubg';

            const pythonScript = require('path').resolve(__dirname, '..', 'python', 'analyze_position.py');
            const existsSyncOrig = fs.existsSync;
            jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
                if (p === pythonScript) return true;
                return existsSyncOrig(p);
            });
            jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            mockSpawn.mockReturnValue(child);

            const promise = runGnuBgAnalysis({ matchId: 'test:id' });
            child.emit('error', new Error('ENOENT'));

            try {
                await expect(promise).rejects.toThrow('Failed to start gnubg');
            } finally {
                if (saved !== undefined) {
                    process.env.GNU_BG_PATH = saved;
                } else {
                    delete process.env.GNU_BG_PATH;
                }
                jest.restoreAllMocks();
            }
        });
    });

    describe('successful analysis', () => {
        it('parses output JSON and enriches moves', async () => {
            const saved = process.env.GNU_BG_PATH;
            process.env.GNU_BG_PATH = '/fake/gnubg';

            const pythonScript = require('path').resolve(__dirname, '..', 'python', 'analyze_position.py');
            const existsSyncOrig = fs.existsSync;

            let outputPath;
            jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
                if (p === pythonScript) return true;
                if (outputPath && p === outputPath) return true;
                return existsSyncOrig(p);
            });
            jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
            jest.spyOn(fs, 'readFileSync').mockImplementation((p) => {
                return JSON.stringify({
                    matchId: 'test:id',
                    engineAvailable: true,
                    moves: [
                        { move: '24/21 13/10', equity: 0.523 },
                        { move: '13/7', equity: 0.401 }
                    ]
                });
            });
            jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            mockSpawn.mockImplementation((cmd, args, opts) => {
                outputPath = opts.env.GNUBG_OUTPUT_JSON;
                return child;
            });

            const promise = runGnuBgAnalysis({ matchId: 'test:id' });

            child.stdout.emit('data', '');
            child.emit('close', 0);

            const result = await promise;
            expect(result.engineAvailable).toBe(true);
            expect(result.moves).toHaveLength(2);
            expect(result.moves[0].move).toBe('24/21 13/10');
            expect(result.moves[0].equity).toBe(0.523);
            expect(result.moves[0].moves).toBeDefined();
            expect(result.moves[0].moves).toHaveLength(2);
            expect(result.moves[0].moves[0]).toEqual({ from: 24, to: 21, hit: false });

            if (saved !== undefined) {
                process.env.GNU_BG_PATH = saved;
            } else {
                delete process.env.GNU_BG_PATH;
            }
            jest.restoreAllMocks();
        });
    });

    describe('no output file fallback', () => {
        it('returns engineAvailable false when no output file exists', async () => {
            const saved = process.env.GNU_BG_PATH;
            process.env.GNU_BG_PATH = '/fake/gnubg';

            const pythonScript = require('path').resolve(__dirname, '..', 'python', 'analyze_position.py');
            const existsSyncOrig = fs.existsSync;

            jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
                if (p === pythonScript) return true;
                return false;
            });
            jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
            jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            mockSpawn.mockReturnValue(child);

            const promise = runGnuBgAnalysis({ matchId: 'test:id' });

            child.stdout.emit('data', 'some output');
            child.stderr.emit('data', 'some error');
            child.emit('close', 1);

            const result = await promise;
            expect(result.engineAvailable).toBe(false);
            expect(result.moves).toEqual([]);

            if (saved !== undefined) {
                process.env.GNU_BG_PATH = saved;
            } else {
                delete process.env.GNU_BG_PATH;
            }
            jest.restoreAllMocks();
        });
    });
});
