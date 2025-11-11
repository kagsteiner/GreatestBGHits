/**
 * Test that parser handles BOTH DailyGammon (numeric) and GNUBG (text) notation
 */

const BackgammonParser = require('./backgammon-parser');

function testBothNotations() {
    const parser = new BackgammonParser();
    
    console.log('Testing BOTH numeric (DailyGammon) and text (GNUBG) notation...\n');
    
    const testCases = [
        {
            name: 'DailyGammon: Bar entry (numeric 25)',
            input: '25/23 8/2',
            expected: [
                { from: 25, to: 23, hit: false },
                { from: 8, to: 2, hit: false }
            ]
        },
        {
            name: 'DailyGammon: Bar entry with hit (numeric 25)',
            input: '25/20 20/16',
            expected: [
                { from: 25, to: 20, hit: false },
                { from: 20, to: 16, hit: false }
            ]
        },
        {
            name: 'DailyGammon: Bearoff (numeric 0)',
            input: '4/0 2/0',
            expected: [
                { from: 4, to: 0, hit: false },
                { from: 2, to: 0, hit: false }
            ]
        },
        {
            name: 'DailyGammon: Multiple bearoffs',
            input: '5/0 5/0 1/0 1/0',
            expected: [
                { from: 5, to: 0, hit: false },
                { from: 5, to: 0, hit: false },
                { from: 1, to: 0, hit: false },
                { from: 1, to: 0, hit: false }
            ]
        },
        {
            name: 'GNUBG: Bar entry (text bar)',
            input: 'bar/21 13/11',
            expected: [
                { from: 25, to: 21, hit: false },
                { from: 13, to: 11, hit: false }
            ]
        },
        {
            name: 'GNUBG: Bar entry with hit',
            input: 'bar/21* 6/4',
            expected: [
                { from: 25, to: 21, hit: true },
                { from: 6, to: 4, hit: false }
            ]
        },
        {
            name: 'GNUBG: Bearoff (text off)',
            input: '2/off 1/off',
            expected: [
                { from: 2, to: 0, hit: false },
                { from: 1, to: 0, hit: false }
            ]
        },
        {
            name: 'GNUBG: Mixed bearoff and regular',
            input: '5/3 1/off',
            expected: [
                { from: 5, to: 3, hit: false },
                { from: 1, to: 0, hit: false }
            ]
        },
        {
            name: 'Real DailyGammon example from game1.txt line 10',
            input: '25/23 8/2',
            expected: [
                { from: 25, to: 23, hit: false },
                { from: 8, to: 2, hit: false }
            ]
        },
        {
            name: 'Real DailyGammon example from game1.txt line 19',
            input: '4/0 2/0',
            expected: [
                { from: 4, to: 0, hit: false },
                { from: 2, to: 0, hit: false }
            ]
        },
        {
            name: 'Real DailyGammon example from game1.txt line 32',
            input: '25/24 6/1',
            expected: [
                { from: 25, to: 24, hit: false },
                { from: 6, to: 1, hit: false }
            ]
        },
        {
            name: 'Real DailyGammon example from game1.txt line 41',
            input: '6/1 6/1 5/0 5/0',
            expected: [
                { from: 6, to: 1, hit: false },
                { from: 6, to: 1, hit: false },
                { from: 5, to: 0, hit: false },
                { from: 5, to: 0, hit: false }
            ]
        },
        {
            name: 'Mixed notation (if ever encountered)',
            input: 'bar/21 6/0',
            expected: [
                { from: 25, to: 21, hit: false },
                { from: 6, to: 0, hit: false }
            ]
        },
        {
            name: 'Edge case: 0 as regular point (should work)',
            input: '1/0 2/0',
            expected: [
                { from: 1, to: 0, hit: false },
                { from: 2, to: 0, hit: false }
            ]
        }
    ];
    
    let passed = 0;
    let failed = 0;
    let dailyGammonTests = 0;
    let gnubgTests = 0;
    
    testCases.forEach(test => {
        const result = parser.parseMoves(test.input);
        const success = JSON.stringify(result) === JSON.stringify(test.expected);
        
        if (test.name.includes('DailyGammon')) dailyGammonTests++;
        if (test.name.includes('GNUBG')) gnubgTests++;
        
        if (success) {
            console.log(`✓ PASS: ${test.name}`);
            console.log(`  Input: "${test.input}"`);
            passed++;
        } else {
            console.log(`✗ FAIL: ${test.name}`);
            console.log(`  Input: "${test.input}"`);
            console.log(`  Expected: ${JSON.stringify(test.expected)}`);
            console.log(`  Got:      ${JSON.stringify(result)}`);
            failed++;
        }
        console.log('');
    });
    
    console.log('=====================================');
    console.log(`Total tests: ${testCases.length}`);
    console.log(`  - DailyGammon format (numeric): ${dailyGammonTests}`);
    console.log(`  - GNUBG format (text): ${gnubgTests}`);
    console.log(`  - Mixed/Edge cases: ${testCases.length - dailyGammonTests - gnubgTests}`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log('=====================================\n');
    
    if (failed === 0) {
        console.log('✓ Success! Parser handles BOTH formats:');
        console.log('  • DailyGammon: 25 (bar), 0 (off)');
        console.log('  • GNUBG: bar, off');
        return true;
    } else {
        console.log('✗ Some tests failed. Please review the results above.');
        return false;
    }
}

const success = testBothNotations();
process.exit(success ? 0 : 1);

