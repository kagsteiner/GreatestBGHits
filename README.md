# DailyGammon Match Retriever

A Node.js script to automatically login to DailyGammon.com and retrieve export links for finished backgammon matches.

## Features

- Simulates login to DailyGammon.com using username/password
- Retrieves finished matches within a specified time range
- Extracts export links for match analysis
- **NEW: Downloads and parses match files into structured JSON**
- **NEW: Handles all backgammon notation including doubles, takes, drops**
- **NEW: Supports empty moves and special game situations**
- Handles session cookies and HTTP authentication
- Configurable parameters for days and user ID
- Saves parsed matches to JSON files for further analysis

## Installation

1. Install dependencies:
```bash
npm install
```

## Usage

### Environment Variables

You can set your DailyGammon credentials in multiple ways:

#### Option 1: Using .env file (Recommended)

1. Create a `.env` file in the project root:
```bash
# Copy the example file
cp env.example .env
```

2. Edit the `.env` file with your credentials:
```
DG_USERNAME=your_dailygammon_username
DG_PASSWORD=your_dailygammon_password
DG_DAYS=30
DG_USER_ID=36594
```

3. Run the script:
```bash
node index.js
```

#### Option 2: Environment Variables

Set your DailyGammon credentials as environment variables:

```bash
export DG_USERNAME="your_username"
export DG_PASSWORD="your_password"
export DG_DAYS=30  # Optional: days to look back (default: 30)
export DG_USER_ID=36594  # Optional: user ID (default: 36594)
```

### Run the Script

```bash
# Using .env file or environment variables
node index.js

# Or set variables inline (overrides .env)
DG_USERNAME=myusername DG_PASSWORD=mypassword node index.js
```

### Using as a Module

```javascript
const DailyGammonRetriever = require('./index.js');

async function getMatches() {
    const retriever = new DailyGammonRetriever();
    const exportLinks = await retriever.getFinishedMatches('username', 'password', 30, '36594');
    console.log('Export links:', exportLinks);
}
```

## API

### DailyGammonRetriever

#### Methods

- `login(username, password)` - Login to DailyGammon
- `getFinishedMatches(username, password, days, userId)` - Get export links for finished matches
- `getAndParseMatches(username, password, days, userId)` - Download and parse all matches to JSON
- `parseExportLinks(html)` - Parse HTML to extract export links
- `getFullExportUrls(exportHrefs)` - Convert relative URLs to full URLs

### BackgammonParser

#### Methods

- `parseMatch(fileContent)` - Parse a match file into structured JSON
- `downloadAndParseMatch(exportUrl, session)` - Download and parse a single match
- `parseMultipleMatches(exportUrls, session)` - Parse multiple matches in parallel

#### Parameters

- `username` (string) - DailyGammon username
- `password` (string) - DailyGammon password
- `days` (number) - Number of days to look back (default: 30)
- `userId` (string) - DailyGammon user ID (default: '36594')

## Example Output

```
Attempting to login as myusername...
Login successful!
Retrieving matches for the last 30 days...
Found 5 export links

Export links found:
1. http://dailygammon.com/bg/export/5151240
2. http://dailygammon.com/bg/export/5151241
3. http://dailygammon.com/bg/export/5151242
4. http://dailygammon.com/bg/export/5151243
5. http://dailygammon.com/bg/export/5151244

Downloading and parsing matches...
Downloading match from: http://dailygammon.com/bg/export/5151240
Downloading match from: http://dailygammon.com/bg/export/5151241
Parsing 5 matches...
Successfully parsed 5 matches

Parsed matches saved to: parsed_matches_2024-01-15.json
```

## JSON Structure

The parser creates a structured JSON format for each match:

```json
{
  "matchLength": 7,
  "players": {
    "player1": "hape42",
    "player2": "darkhelmet"
  },
  "games": [
    {
      "gameNumber": 1,
      "players": {
        "player1": "hape42",
        "player2": "darkhelmet"
      },
      "startingScore": {
        "player1": 0,
        "player2": 0
      },
      "moves": [
        {
          "moveNumber": 1,
          "player1": {
            "type": "move",
            "dice": {
              "die1": 6,
              "die2": 1,
              "isDouble": false,
              "total": 7
            },
            "moves": [
              {"from": 13, "to": 7, "hit": false},
              {"from": 8, "to": 7, "hit": false}
            ]
          },
          "player2": {
            "type": "move",
            "dice": {
              "die1": 5,
              "die2": 1,
              "isDouble": false,
              "total": 6
            },
            "moves": [
              {"from": 24, "to": 23, "hit": false},
              {"from": 13, "to": 8, "hit": false}
            ]
          }
        }
      ],
      "result": {
        "points": 1,
        "isMatchEnd": false
      }
    }
  ],
  "finalScore": {
    "player1": 2,
    "player2": 5
  },
  "winner": "darkhelmet"
}
```

### Special Move Types

- `"type": "move"` - Regular dice roll and moves
- `"type": "double"` - Doubling cube offer
- `"type": "take"` - Accepting a double
- `"type": "drop"` - Refusing a double
- `"type": "win"` - Game/match win
- `"type": "no_move"` - Empty move (player can't move or doesn't go first)

## Technical Details

- Uses axios for HTTP requests with session cookie management
- Uses cheerio for HTML parsing
- Handles the old-fashioned HTML form-based authentication
- Supports the URL pattern: `/bg/user/{userId}?days_to_view={days}&active=1&finished=1`
- Extracts export links matching pattern: `/bg/export/{matchId}`

## Security Note

This script is designed for the simple HTTP-based DailyGammon site without modern security measures. It handles basic session cookies and form-based authentication as described in the original requirements. 

## GNU Backgammon Analysis Service

This project includes a minimal HTTP service exposing an endpoint to analyze a position from a DailyGammon match using a local installation of GNU Backgammon.

### Prerequisites

- Install GNU Backgammon locally and note the path to `gnubg.exe`
- Create `.env` from the example and set `GNU_BG_PATH`:

```bash
cp env.example .env
# Edit .env and set GNU_BG_PATH to your gnubg.exe absolute path
```

### Run the server

```bash
npm install
npm run start
# Server listens on http://localhost:3000 by default
```

### Endpoint: POST /analyzePositionFromMatch

Body:

```json
{
  "matchId": "5151240",
  "positionIndex": 0
}
```

Response (example):

```json
{
  "matchId": "5151240",
  "positionIndex": 0,
  "engineAvailable": false,
  "moves": [
    { "move": "24/18 13/9", "equity": -0.1234 },
    { "move": "24/20 13/9", "equity": -0.1456 },
    { "move": "13/7 6/2", "equity": -0.1678 }
  ]
}
```

Notes:

- If `GNU_BG_PATH` is not configured or GNU Backgammon fails to run, `engineAvailable` will be `false` and the moves will be a stub. Once properly configured, the Python bridge can be extended to reconstruct positions and query GNUBG for true equities.
