'use strict';

require('dotenv').config();
const { DEFAULT_MISTAKE_THRESHOLD } = require('./constants');

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

/**
 * Analyze a full match JSON via GNU Backgammon in python mode.
 * @param {object} matchJson Parsed match JSON (from backgammon-parser.js)
 * @param {{ threshold?: number, maxCandidates?: number }} [options]
 * @returns {Promise<{ engineAvailable: boolean, threshold: number, mistakes: Array<any> }>} Result with sorted mistakes
 */
async function analyzeMatch(matchJson, options = {}) {
    const gnubgPath = process.env.GNU_BG_PATH;
    if (!gnubgPath) {
        return {
            engineAvailable: false,
            threshold: typeof options.threshold === 'number' ? options.threshold : DEFAULT_MISTAKE_THRESHOLD,
            mistakes: [],
            error: 'GNU_BG_PATH not set in environment.'
        };
    }

    const pythonScript = path.resolve(__dirname, '..', 'python', 'analyze_match.py');
    if (!fs.existsSync(pythonScript)) {
        throw new Error('Python match analyzer not found at ' + pythonScript);
    }

    const tmpDir = os.tmpdir();
    const inputPath = path.join(tmpDir, `gnubg_match_in_${uuidv4()}.json`);
    const outputPath = path.join(tmpDir, `gnubg_match_out_${uuidv4()}.json`);

    const payload = {
        match: matchJson,
        threshold: typeof options.threshold === 'number' ? options.threshold : DEFAULT_MISTAKE_THRESHOLD,
        maxCandidates: typeof options.maxCandidates === 'number' ? options.maxCandidates : 8
    };

    fs.writeFileSync(inputPath, JSON.stringify(payload, null, 2), 'utf8');

    const args = ['-p', pythonScript];

    return new Promise((resolve, reject) => {
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
        child.stdout.on('data', (d) => {
            const s = d.toString();
            stdout += s;
            // Stream logs to console for visibility
            process.stdout.write(s);
        });
        child.stderr.on('data', (d) => {
            const s = d.toString();
            stderr += s;
            process.stderr.write(s);
        });

        child.on('error', (err) => {
            cleanup();
            reject(new Error('Failed to start gnubg: ' + err.message));
        });

        child.on('close', () => {
            try {
                if (!fs.existsSync(outputPath)) {
                    cleanup();
                    return resolve({ engineAvailable: false, threshold: payload.threshold, mistakes: [], raw: { stdout, stderr } });
                }
                const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
                cleanup();
                resolve(result);
            } catch (e) {
                cleanup();
                reject(e);
            }
        });

        function cleanup() {
            try { fs.existsSync(inputPath) && fs.unlinkSync(inputPath); } catch (_) { }
            try { fs.existsSync(outputPath) && fs.unlinkSync(outputPath); } catch (_) { }
        }
    });
}

module.exports = analyzeMatch;


