'use strict';

/**
 * Import a single match from DailyGammon and add its quizzes to the database.
 *
 * Usage:
 *   node scripts/import-match.js <match-id> <username> [options]
 *
 * Arguments:
 *   match-id          DailyGammon match ID (e.g., 5151240)
 *   username          Username to store quizzes under
 *
 * Options:
 *   --threshold, -t   Mistake threshold for quiz generation (default: 0.08)
 *   --force, -f       Force re-analysis even if match was already processed
 *   --debug, -d       Enable debug output
 *
 * Examples:
 *   node scripts/import-match.js 5151240 myuser
 *   node scripts/import-match.js 5151240 myuser --threshold 0.05 --force
 */

require('dotenv').config();

const axios = require('axios');
const BackgammonParser = require('../backgammon-parser');
const { buildGamePositions, loadQuizzes, saveQuizzes } = require('../src/gameCore');
const userStorage = require('../src/storage');
const { DEFAULT_MISTAKE_THRESHOLD } = require('../src/constants');
const crypto = require('crypto');

// Parse command line arguments
function parseArgs() {
    const args = process.argv.slice(2);
    const result = {
        matchId: null,
        username: null,
        threshold: DEFAULT_MISTAKE_THRESHOLD,
        force: false,
        debug: false
    };

    const positional = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--threshold' || arg === '-t') {
            result.threshold = parseFloat(args[++i]);
        } else if (arg === '--force' || arg === '-f') {
            result.force = true;
        } else if (arg === '--debug' || arg === '-d') {
            result.debug = true;
        } else if (arg === '--help' || arg === '-h') {
            printUsage();
            process.exit(0);
        } else if (!arg.startsWith('-')) {
            positional.push(arg);
        }
    }

    // First positional arg is match ID, second is username
    if (positional.length >= 1) {
        result.matchId = extractMatchId(positional[0]);
    }
    if (positional.length >= 2) {
        result.username = positional[1];
    }

    return result;
}

function printUsage() {
    console.log(`
Import a single match from DailyGammon and add its quizzes to the database.

Usage:
  node scripts/import-match.js <match-id> <username> [options]

Arguments:
  match-id               DailyGammon match ID (e.g., 5151240) or full URL
  username               Username to store quizzes under

Options:
  --threshold, -t <val>  Mistake threshold for quiz generation (default: 0.08)
  --force, -f            Force re-analysis even if match was already processed
  --debug, -d            Enable debug output
  --help, -h             Show this help message

Examples:
  node scripts/import-match.js 5151240 myuser
  node scripts/import-match.js 5151240 myuser --threshold 0.05
  node scripts/import-match.js 5151240 myuser --force --debug
`);
}

/**
 * Extract match ID from various input formats:
 * - Just the ID: "5151240"
 * - Export URL: "http://dailygammon.com/bg/export/5151240"
 * - Game URL: "http://dailygammon.com/bg/game/5151240/..."
 */
function extractMatchId(input) {
    if (!input) return null;

    // If it's just a number, return it
    if (/^\d+$/.test(input)) {
        return input;
    }

    // Try to extract from export URL
    const exportMatch = input.match(/\/bg\/export\/(\d+)/);
    if (exportMatch) return exportMatch[1];

    // Try to extract from game URL
    const gameMatch = input.match(/\/bg\/game\/(\d+)/);
    if (gameMatch) return gameMatch[1];

    return null;
}

/**
 * Build the public URL for downloading match data
 */
function getMatchUrl(matchId) {
    return `http://dailygammon.com/bg/game/${matchId}/0/list`;
}

/**
 * Compute a stable quiz-position identifier based on deterministic context.
 */
function computePositionId(p) {
    const key =
        String(p?.gnuId || '') +
        '|' +
        String(p?.context?.player || '') +
        '|' +
        String(p?.context?.gameNumber ?? '') +
        '|' +
        String(p?.context?.plyIndex ?? '') +
        '|' +
        String(p?.user?.name || '');
    const h = crypto.createHash('sha1').update(key).digest('hex');
    return h.slice(0, 16);
}

/**
 * Ensure quiz bookkeeping fields exist on a position.
 */
function ensureQuizFields(p) {
    if (!p) return p;
    if (!p.quiz || typeof p.quiz !== 'object') {
        p.quiz = { playCount: 0, correctAnswers: 0 };
    } else {
        const pc = Number.isFinite(p.quiz.playCount) ? p.quiz.playCount : 0;
        const ca = Number.isFinite(p.quiz.correctAnswers) ? p.quiz.correctAnswers : 0;
        p.quiz.playCount = pc;
        p.quiz.correctAnswers = ca;
    }
    if (!p.id) {
        p.id = computePositionId(p);
    }
    return p;
}

async function main() {
    const opts = parseArgs();

    // Validate required arguments
    if (!opts.matchId) {
        console.error('Error: Match ID is required.\n');
        printUsage();
        process.exit(1);
    }

    if (!opts.username) {
        console.error('Error: Username is required.\n');
        printUsage();
        process.exit(1);
    }

    const matchId = opts.matchId;
    const url = getMatchUrl(matchId);

    console.log(`\n=== Import Match Script ===`);
    console.log(`Match ID: ${matchId}`);
    console.log(`Match URL: ${url}`);
    console.log(`Username: ${opts.username}`);
    console.log(`Threshold: ${opts.threshold}`);
    console.log(`Force re-analysis: ${opts.force}`);
    console.log('');

    // Enable debug logging if requested
    if (opts.debug) {
        process.env.DEBUG_ADD_QUIZ = '1';
    }

    // Normalize the username for storage
    const userKey = userStorage.normalizeUsername(opts.username);
    if (!userKey) {
        console.error('Error: Invalid username');
        process.exit(1);
    }

    try {
        // Check if match was already analyzed (unless force is set)
        if (!opts.force) {
            const analyzedMatches = userStorage.readAnalyzedMatches(userKey);
            const matchIds = Array.isArray(analyzedMatches?.matches) ? analyzedMatches.matches : [];
            if (matchIds.includes(matchId)) {
                console.log(`Match ${matchId} was already analyzed for user ${opts.username}.`);
                console.log('Use --force to re-analyze.');
                process.exit(0);
            }
        }

        // Step 1: Download and parse the match (no auth needed - public URL)
        console.log(`Downloading match from ${url}...`);

        // Create a simple axios instance for the request
        const session = axios.create({
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const parser = new BackgammonParser();
        const match = await parser.downloadAndParseMatch(url, session);

        const player1 = match?.players?.player1 || match?.games?.[0]?.players?.player1 || 'player1';
        const player2 = match?.players?.player2 || match?.games?.[0]?.players?.player2 || 'player2';
        const gameCount = match?.games?.length || 0;

        console.log(`Match parsed successfully.`);
        console.log(`  Players: ${player1} vs ${player2}`);
        console.log(`  Games: ${gameCount}`);
        console.log(`  Match length: ${match?.matchLength || 'unknown'} points\n`);

        // Step 2: Load existing quizzes
        console.log('Loading existing quizzes...');
        const quizzes = await loadQuizzes(userKey);
        const seenIds = new Set(quizzes.positions.map(p => p.id).filter(Boolean));
        console.log(`Found ${quizzes.positions.length} existing quizzes.\n`);

        // Step 3: Analyze the match and collect quiz positions
        console.log('Analyzing match positions...');
        let addedCount = 0;

        await buildGamePositions(match, {
            threshold: opts.threshold,
            dgGameId: matchId,
            onPosition: async (pos) => {
                ensureQuizFields(pos);
                if (!pos.id) return;

                if (seenIds.has(pos.id)) {
                    // Already present; don't re-add
                    if (opts.debug) {
                        console.log(`  Skipped: ${pos.id} (already exists)`);
                    }
                    return;
                }

                quizzes.positions.push(pos);
                seenIds.add(pos.id);
                addedCount++;

                // Save after each new quiz (same as gameCore does)
                await saveQuizzes(userKey, quizzes);

                const equityDiff = pos.context?.equityDiff?.toFixed(3) || '?';
                const userName = pos.user?.name || '?';
                const userMove = pos.user?.move || '?';
                const bestMove = pos.best?.move || '?';

                console.log(`  Added quiz #${addedCount}: ${userName} played "${userMove}" (best: "${bestMove}", equity loss: ${equityDiff})`);
            }
        });

        console.log(`\nAnalysis complete. Quizzes added: ${addedCount}\n`);

        // Step 4: Mark match as analyzed
        console.log('Marking match as analyzed...');
        const analyzedMatches = userStorage.readAnalyzedMatches(userKey);
        const matchIds = new Set(Array.isArray(analyzedMatches?.matches) ? analyzedMatches.matches : []);
        matchIds.add(matchId);
        userStorage.writeAnalyzedMatches(userKey, { matches: Array.from(matchIds).sort() });
        console.log('Done.\n');

        // Summary
        console.log('=== Summary ===');
        console.log(`Match: ${matchId} (${player1} vs ${player2})`);
        console.log(`Quizzes added: ${addedCount}`);
        console.log(`Total quizzes for ${opts.username}: ${quizzes.positions.length}`);
        console.log('');

    } catch (error) {
        console.error('\nError:', error.message);
        if (opts.debug) {
            console.error(error.stack);
        }
        process.exit(1);
    }
}

main().catch((e) => {
    console.error('Unexpected error:', e);
    process.exit(1);
});
