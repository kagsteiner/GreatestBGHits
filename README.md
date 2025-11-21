# DailyGammon Quiz

A Node.js script to improve your backgammon by answering multiple choice quizees about your worst blunders in past DailyGammon matches.

Currently this is for my entertainment only - some day I plan to make it public. You can freely use it; if you install a local Gnu Backgammon and do a bit of fiddling, you should easily get it to work.

## Features

- has a DailyGammon "crawler" that will retrieve your past matches (you can provide how many days to look back), analyze them all with Gnu Backgammon, and save positions where you or your opponent blundered as a quiz - position, best move, your move, up to 2 more possible moves.
- The main quiz UI will show you random quiz positions in a nice UI and ask you to select the right move. Depending on the move correctness you will see this quiz again soon or not.
- shows you statistics of how good you are at solving your quiz positions.
  
## Installation
TBD

## Usage

run npm server.js, then open a web broser at http://localhost:3033


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
### Prerequisites

- Install GNU Backgammon locally and note the path to `gnubg.exe`
- Create `.env` from the example and set `GNU_BG_PATH`:

```bash
cp env.example .env
# Edit .env and set GNU_BG_PATH to your gnubg.exe absolute path
```

# Notes
This is 100% "vibe coded" (how I hate the term). I certainly write more beautiful code. But I take 10 times as long. And I don't have 10 times as long.



