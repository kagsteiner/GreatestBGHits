'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

/**
 * Convert a single GNUBG move token to numeric from/to with hit flag.
 * - Expands 'bar' to 25 and 'off' to 0
 * - Keeps trailing '*'
 */
function tokenToPart(token) {
    if (!token) return null;
    let hit = false;
    if (token.endsWith('*')) {
        hit = true;
        token = token.slice(0, -1);
    }
    if (!token.includes('/')) return null;
    let [from, to] = token.split('/');
    if (from.toLowerCase() === 'bar') from = '25';
    if (to.toLowerCase() === 'off') to = '0';
    const fromNum = Number(from);
    const toNum = Number(to);
    if (!Number.isFinite(fromNum) || !Number.isFinite(toNum)) return null;
    return { from: fromNum, to: toNum, hit };
}

/**
 * Expand GNUBG shorthand counts like 8/5(2) into two tokens '8/5 8/5'.
 */
function expandCounts(token) {
    const m = token.match(/^([^()\s]+)\((\d+)\)$/);
    if (!m) return [token];
    const base = m[1];
    const count = Number(m[2]);
    const out = [];
    for (let i = 0; i < count; i++) out.push(base);
    return out;
}

/**
 * Convert a GNUBG move text like '24/21(2) 13/10(2)' into
 * an array of parts: [{from,to,hit}, ...], expanded and normalized.
 */
function expandAndParseMoveToParts(moveText) {
    if (typeof moveText !== 'string' || !moveText.trim()) return [];
    const rawTokens = moveText.trim().split(/\s+/);
    const tokens = [];
    for (const t of rawTokens) tokens.push(...expandCounts(t));
    const parts = [];
    for (const tok of tokens) {
        const part = tokenToPart(tok);
        if (part) parts.push(part);
    }
    return parts;
}

/**
 * Run GNU Backgammon analysis via python bridge
 * @param {{ matchId: string, positionId?: string, positionIndex?: number, dice?: { die1: number, die2: number } }} params
 * @returns {Promise<{ matchId: string, positionIndex?: number, engineAvailable: boolean, moves: Array<{ move: string, equity?: number, mwc?: number, moves?: Array<{from:number,to:number,hit:boolean}> }>, raw?: any }>}
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

        // Allow callers to pass either a full GNU ID (posId:matchId) in matchId,
        // or provide positionId separately to be combined here.
        let combinedId = params.matchId;
        if (typeof params.positionId === 'string' && params.positionId && !combinedId.includes(':')) {
            combinedId = `${params.positionId}:${combinedId}`;
        }

        const inputPayload = {
            matchId: combinedId,
            positionIndex: typeof params.positionIndex === 'number' ? params.positionIndex : null,
            dice: params.dice && typeof params.dice === 'object' ? params.dice : undefined
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
                out.raw = { stdout, stderr, exitCode: code };

                // If Python side couldn't parse moves, try parsing from stdout here
                if ((!out.moves || out.moves.length === 0) && stdout) {
                    const parsed = [];
                    const lines = stdout.split(/\r?\n/);
                    const rankRegex = /^\s*(\d+)[\.)]/;
                    for (const line of lines) {
                        if (!rankRegex.test(line)) continue;
                        const eqMatch = line.match(/Eq\.\s*:\s*([+\-]?\d+[\.,]\d+)/);
                        const mwcMatch = line.match(/MWC\s*:\s*([0-9]+[\.,][0-9]+)\s*%/i);
                        let equity = undefined;
                        let mwc = undefined;
                        if (eqMatch) {
                            const eqStr = eqMatch[1].replace(',', '.');
                            equity = Number(eqStr);
                        } else if (mwcMatch) {
                            const mwcStr = mwcMatch[1].replace(',', '.');
                            mwc = Number(mwcStr) / 100; // fraction 0..1
                        } else {
                            continue;
                        }

                        const idxEq = line.indexOf('Eq.');
                        const idxMWC = line.indexOf('MWC');
                        const cutIdx = idxEq >= 0 ? idxEq : (idxMWC >= 0 ? idxMWC : -1);
                        let left = cutIdx > 0 ? line.slice(0, cutIdx) : line;
                        // Collapse spaces
                        left = left.replace(/\s+/g, ' ').trim();
                        // Strip descriptive prefixes like 'Cubeful 3-ply', 'Cubeless', 'Rollout'
                        left = left.replace(/^(Cubeful|Cubeless|Rollout)\b[^A-Za-z0-9\/]*[A-Za-z0-9\- ]*\s+/i, '');
                        // Find first token containing a slash or 'bar'/'off'
                        const tokens = left.split(' ');
                        let moveStart = 0;
                        for (let i = 0; i < tokens.length; i++) {
                            const t = tokens[i];
                            if (t.includes('/') || /^(bar|off)/i.test(t)) { moveStart = i; break; }
                        }
                        const move = tokens.slice(moveStart).join(' ').trim();
                        if (move && (Number.isFinite(equity) || Number.isFinite(mwc))) {
                            const item = { move };
                            if (Number.isFinite(equity)) item.equity = equity;
                            if (Number.isFinite(mwc)) item.mwc = mwc;
                            item.moves = expandAndParseMoveToParts(move);
                            parsed.push(item);
                        }
                    }
                    if (parsed.length) {
                        out.moves = parsed;
                    }
                }

                // Always enrich any existing move entries with parsed move parts
                if (Array.isArray(out.moves)) {
                    out.moves = out.moves.map((m) => {
                        if (m && typeof m === 'object') {
                            const moveText = m.move || m.moveText || '';
                            if (!m.moves && typeof moveText === 'string' && moveText) {
                                return { ...m, moves: expandAndParseMoveToParts(moveText) };
                            }
                        }
                        return m;
                    });
                }
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


