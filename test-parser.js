const BackgammonParser = require('./backgammon-parser');

// Test data from the user's examples
const testMatch1 = ` 7 point match

 Game 1
 hape42 : 0                          darkhelmet : 0
  1) 61: 13/7 8/7                    51: 24/23 13/8
  2) 33: 24/21 24/21 6/3 6/3         51: 13/8 6/5
  3) 65: 13/7 13/8                   42: 24/20 5/3
  4) 61: 21/15 21/20                 41: 8/4 4/3
  5) 43: 20/16 16/13                 65: 13/7 8/3
  6) 32: 8/5* 7/5                    62: 25/23 8/2
  7) 52: 15/10 10/8                  64: 8/2 8/4
  8) 43: 13/9 9/6                    21: 6/4 6/5
  9) 61: 8/7 7/1                     55: 13/8 13/8 8/3 7/2
 10) 43: 13/9 9/6                    66: 8/2
 11) 32: 6/3 3/1                     61: 2/1
 12) 51: 13/8 6/5                    63: 5/2
 13) 65: 8/3 7/1                     55: 23/18* 23/18 18/13 13/8
 14) 54: 25/20 20/16                 55: 18/13 13/8 8/3 8/3
 15) 64: 16/10 10/6                  42: 4/0 2/0
 16) 53: 8/3 8/5                      Doubles => 2
 17)  Drops                          Wins 1 point

 Game 2
 hape42 : 0                          darkhelmet : 1
  1) 61: 13/7 8/7                    61: 13/7 8/7
  2) 54: 24/20 13/8                  54: 24/20 13/8
  3) 41: 24/20 8/7                   64: 24/20 13/7
  4) 64: 13/7 7/3                    33: 13/10 13/10 6/3 6/3
  5) 33: 13/10 13/10 7/4 6/3         61: 20/14 14/13
  6) 33: 10/7 8/5* 8/5 7/4           32: 25/23 13/10
  7) 51: 10/5 5/4                    53: 8/3 7/4
  8) 31: 6/3 3/2*                    51: 25/24 6/1
  9) 51: 6/1* 2/1                    43:
 10) 65: 20/14 14/9                  64:
 11) 31: 9/6 4/3                     65:
 12) 41: 6/2 3/2                     63:
 13) 32: 7/4 7/5                     65:
 14) 21: 4/2 2/1                     51:
 15) 54: 20/16 16/11                 51:
 16) 54: 11/6 6/2                    63:
 17) 55: 6/1 6/1 5/0 5/0             21:
 18) 41: 5/1 1/0                     11:
 19) 64: 4/0 4/0                     54: 25/20 10/6
 20) 51: 3/0 1/0                     42: 20/16 8/6
 21) 65: 3/0 2/0                     64: 16/10 10/6
 22) 42: 2/0 2/0                     64: 10/4 10/6
 23) 53: 1/0 1/0                     32: 8/5 7/5
      Wins 2 points`;

const testMatch2 = ` 11 point match

 Game 1
 nno : 0                             darkhelmet : 0
  1)                                 32: 24/21 13/11
  2) 43: 8/4* 4/1*                   63: 25/22
  3) 32: 6/3* 3/1                    11:
  4)  Doubles => 2                    Drops
      Wins 1 point

 Game 2
 nno : 1                             darkhelmet : 0
  1) 54: 24/20 13/8                  53: 13/8 8/5*
  2) 62: 25/23 24/18                 52: 8/3 5/3
  3) 64: 18/14 14/8                  64: 8/2* 6/2
  4) 41: 25/21 21/20                 43: 13/9 8/5*
  5) 21: 25/24 8/6                   54: 9/5 6/1*
  6) 22:                             52: 24/22 6/1
  7) 51:                             42: 24/20 22/20
  8) 64: 25/21 21/15                 41: 13/9 9/8
  9) 52: 15/10 10/8                  41: 8/4 5/4
 10) 64: 8/2 6/2                     61: 20/14 14/13
 11) 61: 13/7 8/7                     Doubles => 2
 12)  Takes                          54: 20/15 15/11
 13) 21: 8/6 7/6                     43: 13/9 9/6
 14) 42: 13/9 8/6                    41: 11/7 6/5
 15) 53: 9/4 7/4                     55: 13/8 13/8 8/3 7/2
 16) 52: 13/8 13/11                  32: 8/5 2/0
 17) 32: 8/5 8/6                     63: 6/0 3/0
 18) 53: 11/6 6/3                    43: 4/0 3/0
 19) 31: 3/0 2/1                     64: 6/0 4/0
 20) 54: 5/0 4/0                     51: 5/0 1/0
 21) 54: 6/1 4/0                     65: 5/0 5/0
 22) 11: 2/1 1/0 1/0 1/0             42: 3/0 2/0
                                      Wins 2 points`;

function testParser() {
    console.log('Testing Backgammon Parser...\n');

    const parser = new BackgammonParser();

    // Test first match
    console.log('=== Testing 7-point match ===');
    try {
        const match1 = parser.parseMatch(testMatch1);
        console.log('Match Length:', match1.matchLength);
        console.log('Players:', match1.players);
        console.log('Number of Games:', match1.games.length);
        console.log('Final Score:', match1.finalScore);

        // Show first game details
        const game1 = match1.games[0];
        console.log('\nGame 1 Details:');
        console.log('- Players:', game1.players);
        console.log('- Starting Score:', game1.startingScore);
        console.log('- Number of Moves:', game1.moves.length);
        console.log('- First Move:', JSON.stringify(game1.moves[0], null, 2));
        console.log('- Last Move:', JSON.stringify(game1.moves[game1.moves.length - 1], null, 2));
        console.log('- Result:', game1.result);

        console.log('\nMatch 1 parsed successfully! ✓');
    } catch (error) {
        console.error('Error parsing match 1:', error.message);
    }

    console.log('\n' + '='.repeat(50) + '\n');

    // Test second match
    console.log('=== Testing 11-point match ===');
    try {
        const match2 = parser.parseMatch(testMatch2);
        console.log('Match Length:', match2.matchLength);
        console.log('Players:', match2.players);
        console.log('Number of Games:', match2.games.length);
        console.log('Final Score:', match2.finalScore);

        // Show special moves (doubles, takes, drops)
        const game1 = match2.games[0];
        console.log('\nGame 1 Special Moves:');
        game1.moves.forEach((move, index) => {
            if (move.player1.type === 'double' || move.player1.type === 'drop' ||
                move.player2.type === 'double' || move.player2.type === 'drop') {
                console.log(`Move ${move.moveNumber}:`,
                    `P1: ${move.player1.type}`,
                    `P2: ${move.player2.type}`);
            }
        });

        // Show game 2 with empty moves
        const game2 = match2.games[1];
        console.log('\nGame 2 - moves with empty dice:');
        game2.moves.slice(5, 8).forEach(move => {
            console.log(`Move ${move.moveNumber}:`,
                `P1: ${move.player1.type}${move.player1.dice ? ' (' + move.player1.dice.die1 + move.player1.dice.die2 + ')' : ''}`,
                `P2: ${move.player2.type}${move.player2.dice ? ' (' + move.player2.dice.die1 + move.player2.dice.die2 + ')' : ''}`);
        });

        console.log('\nMatch 2 parsed successfully! ✓');
    } catch (error) {
        console.error('Error parsing match 2:', error.message);
    }

    console.log('\n' + '='.repeat(50));
    console.log('Parser testing completed!');
}

// Run the tests
if (require.main === module) {
    testParser();
}

module.exports = { testParser, testMatch1, testMatch2 }; 