# Bar and Bearoff Move Parsing Fix

## Problem Summary

Moves from the BAR (point 25) and bearoff moves (to point 0) were never appearing in quizzes because they were being silently dropped during the initial parsing of match files when text notation was used.

## Root Cause

In `backgammon-parser.js`, the `parseMoves()` function used a regex that only matched purely numeric moves:

```javascript
// OLD (BROKEN) regex:
const moveMatch = part.match(/^(\d+)\/(\d+)(\*)?$/);
```

This regex matched numeric moves but **completely ignored text notation**:
- ✓ Matched: `13/7`, `24/21*`, `25/23`, `4/0` (all numeric)
- ✗ Ignored: `bar/21`, `bar/20*` (text: entering from the bar)
- ✗ Ignored: `6/off`, `1/off` (text: bearing off)

## Impact

1. All bar entries and bearoff moves were dropped during parsing
2. Board state became incorrect after such moves were skipped
3. Positions with bar/bearoff moves never made it into the quiz database
4. Users never saw these types of moves in quizzes

## Solution

Updated the regex in `backgammon-parser.js` line 254 to handle **BOTH** numeric and text notation:

```javascript
// NEW (FIXED) regex:
const moveMatch = part.match(/^(bar|\d+)\/(off|\d+)(\*)?$/i);
```

This regex now matches **both formats**:

### DailyGammon Format (Numeric)
- Bar entries: `25/23`, `25/20`, `25/24`
- Bearoff moves: `4/0`, `2/0`, `1/0`
- Regular moves: `13/7`, `24/21*`

### GNUBG Format (Text)
- Bar entries: `bar/21`, `bar/20*`, `Bar/23` (case-insensitive)
- Bearoff moves: `6/off`, `1/off`, `2/OFF` (case-insensitive)
- Regular moves: `13/7`, `24/21*`

The parser normalizes both formats to internal representation:
- `bar` or `25` → 25 (internal representation)
- `off` or `0` → 0 (internal representation)

## Internal Representation

Throughout the codebase, the board uses a 26-element array per player:
- **Index 0** = Borne off (bearoff)
- **Index 1-24** = Board points
- **Index 25** = Bar

This representation was already correct everywhere except the initial parsing step.

## Verification

Created and ran comprehensive tests covering **both formats**:

### DailyGammon Format Tests (Numeric: 25, 0)
- Bar entries: `25/23`, `25/20`, `25/24`
- Bearoff moves: `4/0`, `2/0`, `1/0`
- Real examples from `game1.txt`
- Multiple bearoffs: `5/0 5/0 1/0 1/0`

### GNUBG Format Tests (Text: bar, off)
- Bar entries: `bar/21`, `bar/21*`
- Bearoff moves: `6/off`, `1/off`, `2/off`
- Case variations: `bar`, `Bar`, `BAR`, `off`, `OFF`, `Off`
- Mixed combinations: `bar/21* 13/11`, `5/3 1/off`

**All 14 tests passed** (8 DailyGammon format, 4 GNUBG format, 2 mixed/edge cases)

## Next Steps

To see bar and bearoff moves in your quizzes:

1. **Re-analyze your matches**: The existing quizzes in `quizzes.json` were generated with the broken parser. You'll need to:
   - Clear or backup `quizzes.json`
   - Clear or backup `analyzed_matches.json`
   - Run the quiz import again to re-analyze your matches

2. **The fix is forward-compatible**: Any new matches analyzed after this fix will correctly include bar and bearoff moves.

## Files Modified

- `backgammon-parser.js` - Fixed the `parseMoves()` function to handle bar/off notation

## Files Verified as Correct

These files already handled bar/bearoff correctly:
- `src/board.js` - Correct internal representation (0=bearoff, 25=bar)
- `src/gameCore.js` - Correct conversion between numeric and text notation
- `src/gnubgRunner.js` - Correct parsing of GNUBG output
- `public/quiz.js` - Correct display and rendering

## Technical Details

### Move Notation Formats

The codebase handles **three** notation formats:

1. **Internal (numeric)**: Used in board state and move objects
   - Bar = 25
   - Bearoff = 0
   - Points = 1-24

2. **DailyGammon Export (numeric)**: Used in match export files
   - Bar = "25"
   - Bearoff = "0"
   - Points = "1"-"24"

3. **GNUBG Output (text)**: Used in engine communication and display
   - Bar = "bar"
   - Bearoff = "off"
   - Points = "1"-"24"

### Conversion Flow

The conversion happens in multiple places:
- `backgammon-parser.js:parseMoves()` - **NOW FIXED** to accept BOTH numeric (`25`, `0`) AND text (`bar`, `off`)
- `gameCore.js:convertTokenForGnuBg()` - Converts numeric to text for GNUBG
- `gnubgRunner.js:tokenToPart()` - Converts text back to numeric from GNUBG output

All conversions are now working correctly across the entire codebase, supporting both DailyGammon's numeric notation and GNUBG's text notation.

