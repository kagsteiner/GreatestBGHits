'use strict';

const BackgammonBoard = require('../src/board');

/**
 * Test script to verify round-trip conversion of GNU-ids.
 * Takes a GNU-id as parameter, constructs the board, and compares
 * the original ID with the newly generated one.
 * 
 * Usage: node scripts/test-gnuid-roundtrip.js <gnuId>
 * Example: node scripts/test-gnuid-roundtrip.js "4HPwATDgc/ABMA:AAAAAAAAAAAA"
 */

function testGnuIdRoundTrip(gnuId) {
    console.log('='.repeat(70));
    console.log('Testing GNU-ID Round-Trip Conversion');
    console.log('='.repeat(70));
    console.log(`Original GNU-ID: ${gnuId}`);
    console.log('');

    try {
        // Step 1: Construct board from GNU-ID
        const board = BackgammonBoard.fromGnuId(gnuId);
        console.log('✓ Board constructed successfully');
        console.log(`  Turn: ${board.turn}`);
        console.log(`  Cube: ${board.cube}, Owner: ${board.cubeOwner || 'centered'}`);
        console.log(`  Score: Player1=${board.score.player1}, Player2=${board.score.player2}`);
        console.log(`  Match Length: ${board.matchLength || 'money game'}`);
        console.log(`  Dice: ${board.dice ? `${board.dice.die1},${board.dice.die2}` : 'none'}`);
        console.log('');

        // Step 2: Generate GNU-ID from the board
        const newGnuId = board.toGnuId();
        console.log(`Generated GNU-ID: ${newGnuId}`);
        console.log('');

        // Step 3: Compare
        const [originalPosId, originalMatchId] = gnuId.split(':');
        const [newPosId, newMatchId] = newGnuId.split(':');

        console.log('Comparison:');
        console.log(`  Position ID: ${originalPosId === newPosId ? '✓ MATCH' : '✗ MISMATCH'}`);
        if (originalPosId !== newPosId) {
            console.log(`    Original: ${originalPosId}`);
            console.log(`    New:      ${newPosId}`);
        }
        console.log(`  Match ID: ${originalMatchId === newMatchId ? '✓ MATCH' : '✗ MISMATCH'}`);
        if (originalMatchId !== newMatchId) {
            console.log(`    Original: ${originalMatchId}`);
            console.log(`    New:      ${newMatchId}`);
        }
        console.log('');

        const overallMatch = (gnuId === newGnuId);
        if (overallMatch) {
            console.log('✓✓✓ ROUND-TRIP TEST PASSED: IDs match perfectly ✓✓✓');
            return 0;
        } else {
            console.log('✗✗✗ ROUND-TRIP TEST FAILED: IDs do not match ✗✗✗');
            
            // Additional diagnostics
            console.log('');
            console.log('Board state details:');
            console.log('  Player1 points (1-24, then bar):');
            const p1Points = board.points.player1.slice(1, 26);
            console.log(`    ${p1Points.map((n, i) => `${i + 1}:${n}`).join(' ')}`);
            console.log('  Player2 points (1-24, then bar):');
            const p2Points = board.points.player2.slice(1, 26);
            console.log(`    ${p2Points.map((n, i) => `${i + 1}:${n}`).join(' ')}`);
            
            return 1;
        }
    } catch (error) {
        console.error('✗ ERROR:', error.message);
        console.error(error.stack);
        return 1;
    }
}

// Main execution
const gnuId = process.argv[2];

if (!gnuId) {
    console.error('Usage: node scripts/test-gnuid-roundtrip.js <gnuId>');
    console.error('Example: node scripts/test-gnuid-roundtrip.js "4HPwATDgc/ABMA:AAAAAAAAAAAA"');
    process.exit(1);
}

const exitCode = testGnuIdRoundTrip(gnuId);
process.exit(exitCode);

