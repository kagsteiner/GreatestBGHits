'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const BackgammonParser = require('../backgammon-parser');
const { buildGamePositions } = require('../src/gameCore');
const BackgammonBoard = require('../src/board');

// Enable debug logging
process.env.DEBUG_ADD_QUIZ = 'true';

async function main() {
    const inputPath = process.argv[2] || path.join(__dirname, '..', 'game_testcase.txt');
    
    console.log(`Reading test case from: ${inputPath}\n`);
    const fileContent = fs.readFileSync(inputPath, 'utf8');
    
    // Parse the match
    console.log('=== Parsing Match ===');
    const parser = new BackgammonParser();
    const match = parser.parseMatch(fileContent);
    
    console.log('Match Length:', match.matchLength);
    console.log('Players:', match.players);
    console.log('Number of Games:', match.games.length);
    console.log('');
    
    // Focus on Game 1, move 3 (the problematic move)
    const game1 = match.games[0];
    console.log('=== Game 1 Details ===');
    console.log('Players:', game1.players);
    console.log('Number of Moves:', game1.moves.length);
    console.log('');
    
    // Show move 3 details
    const move3 = game1.moves[2]; // 0-indexed, so move 3 is index 2
    console.log('=== Move 3 (Problematic Move) ===');
    console.log('Player1 move:', JSON.stringify(move3.player1, null, 2));
    console.log('');
    
    // Build board state up to move 3
    console.log('=== Building Board State ===');
    let board = BackgammonBoard.starting('player1');
    board.matchLength = match.matchLength;
    
    // Apply moves up to (but not including) move 3
    for (let i = 0; i < 2; i++) {
        const moveRec = game1.moves[i];
        if (moveRec?.player1?.type === 'move') {
            board.turn = 'player1';
            board.dice = moveRec.player1.dice || null;
            console.log(`Before move ${i + 1}: ${board.toGnuId()}`);
            board.applyMoveParts('player1', moveRec.player1.moves || []);
        }
        if (moveRec?.player2?.type === 'move') {
            board.turn = 'player2';
            board.dice = moveRec.player2.dice || null;
            board.applyMoveParts('player2', moveRec.player2.moves || []);
        }
    }
    
    // Show position before move 3
    board.turn = 'player1';
    board.dice = move3.player1.dice || null;
    const beforeGnuId = board.toGnuId();
    console.log(`\nPosition BEFORE move 3: ${beforeGnuId}`);
    console.log('Expected: 4HPwQSDI58gBIg:MIEkAVAAOAAA');
    console.log('Match:', beforeGnuId === '4HPwQSDI58gBIg:MIEkAVAAOAAA' ? '✓' : '✗');
    console.log('');
    
    // Show board state
    console.log('Board state before move 3:');
    console.log(board.toString ? board.toString() : JSON.stringify(board.points, null, 2));
    console.log('');
    
    // Apply move 3
    console.log('=== Applying Move 3 ===');
    console.log('Move parts:', JSON.stringify(move3.player1.moves, null, 2));
    board.applyMoveParts('player1', move3.player1.moves || []);
    
    // Show position after move 3
    board.turn = 'player2'; // Turn switches after player1's move
    const afterGnuId = board.toGnuId();
    console.log(`\nPosition AFTER move 3: ${afterGnuId}`);
    console.log('Expected: mLfIASLgc/ABUA:cAkgAVAAOAAA');
    console.log('Got:      mLfIASLgc/BBIA:cIkmAVAAOAAA (WRONG)');
    console.log('Match:', afterGnuId === 'mLfIASLgc/ABUA:cAkgAVAAOAAA' ? '✓' : '✗');
    console.log('');
    
    // Show board state after
    console.log('Board state after move 3:');
    console.log(board.toString ? board.toString() : JSON.stringify(board.points, null, 2));
    console.log('');
    
    // Now try analyzing the full match
    console.log('=== Analyzing Full Match ===');
    const result = await buildGamePositions(match, { 
        userName: 'hape42',
        threshold: 0.01 
    });
    
    console.log(`\nTotal positions found: ${result.positions.length}`);
    if (result.positions.length > 0) {
        console.log('\nFirst few positions:');
        result.positions.slice(0, 3).forEach((pos, idx) => {
            console.log(`\nPosition ${idx + 1}:`);
            console.log(`  GNU-ID: ${pos.gnuId}`);
            console.log(`  User move: ${pos.user?.move}`);
            console.log(`  Best move: ${pos.best?.move}`);
            console.log(`  Equity diff: ${pos.context?.equityDiff}`);
        });
    }
}

main().catch((e) => {
    console.error('Error:', e);
    console.error(e.stack);
    process.exit(1);
});

