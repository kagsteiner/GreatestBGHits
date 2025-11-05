'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

/**
 * Run GNU Backgammon analysis via python bridge
 * @param {{ matchId: string, positionIndex?: number }} params
 * @returns {Promise<{ matchId: string, positionIndex?: number, engineAvailable: boolean, moves: Array<{ move: string, equity: number }>, raw?: any }>}
 */
module.exports = function runGnuBgAnalysis(params) {
    return new Promise((resolve, reject) => {
        const gnubgPath = process.env.GNU_BG_PATH;
        if (!gnubgPath) {
            return resolve({
                matchId: params.matchId,
                positionIndex: params.positionIndex,
                engineAvailable: false,
                moves: [],
                error: 'GNU_BG_PATH not set in .env. Provide absolute path to gnubg.exe.'
            });
        }

        const pythonScript = path.resolve(__dirname, '..', 'python', 'analyze_position.py');
        if (!fs.existsSync(pythonScript)) {
            return reject(new Error('Python bridge script not found at ' + pythonScript));
        }

        // Prepare temp files for input/output to avoid quoting issues on Windows
        const tmpDir = os.tmpdir();
        const inputPath = path.join(tmpDir, `gnubg_in_${uuidv4()}.json`);
        const outputPath = path.join(tmpDir, `gnubg_out_${uuidv4()}.json`);

        const inputPayload = {
            matchId: params.matchId,
            positionIndex: typeof params.positionIndex === 'number' ? params.positionIndex : null
        };

        fs.writeFileSync(inputPath, JSON.stringify(inputPayload, null, 2), 'utf8');

        const args = [
            '-p',
            pythonScript
        ];

        const child = spawn(gnubgPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                GNUBG_INPUT_JSON: inputPath,
                GNUBG_OUTPUT_JSON: outputPath
            }
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });

        child.on('error', (err) => {
            cleanup();
            reject(new Error('Failed to start gnubg: ' + err.message));
        });

        child.on('close', (code) => {
            try {
                if (!fs.existsSync(outputPath)) {
                    // Fall back: if no output file, return basic info including stderr
                    const fallback = {
                        matchId: params.matchId,
                        positionIndex: params.positionIndex,
                        engineAvailable: false,
                        moves: [],
                        raw: { stdout, stderr, exitCode: code }
                    };
                    cleanup();
                    return resolve(fallback);
                }

                const out = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
                cleanup();
                resolve(out);
            } catch (e) {
                cleanup();
                reject(new Error('Error reading gnubg output: ' + e.message + (stderr ? ` | stderr: ${stderr}` : '')));
            }
        });

        function cleanup() {
            try { fs.existsSync(inputPath) && fs.unlinkSync(inputPath); } catch (_) { }
            try { fs.existsSync(outputPath) && fs.unlinkSync(outputPath); } catch (_) { }
        }
    });
};


