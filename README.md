# DailyGammon Quiz

A Node.js script to improve your backgammon by answering multiple choice quizees about your worst blunders in past DailyGammon matches.

Currently this is for my entertainment only - some day I plan to make it public. You can freely use it; if you install a local Gnu Backgammon and do a bit of fiddling, you should easily get it to work.

## Features

- has a DailyGammon "crawler" that will retrieve your past matches (you can provide how many days to look back), analyze them all with Gnu Backgammon, and save positions where you or your opponent blundered as a quiz - position, best move, your move, up to 2 more possible moves.
- The main quiz UI will show you random quiz positions in a nice UI and ask you to select the right move. Depending on the move correctness you will see this quiz again soon or not.
- shows you statistics of how good you are at solving your quiz positions.

## Screenshots

![Crawler](https://github.com/kagsteiner/GreatestBGHits/blob/61910d93e9cd3349881e143acec6e5cfcb91664e/images/analyzer.png)

![Quiz](https://github.com/kagsteiner/GreatestBGHits/blob/61910d93e9cd3349881e143acec6e5cfcb91664e/images/quiz.png)

![Statistics](https://github.com/kagsteiner/GreatestBGHits/blob/61910d93e9cd3349881e143acec6e5cfcb91664e/images/statistics.png)

## Installation
TBD

## Usage

run npm server.js, then open a web browser at http://localhost:3033


### Environment Variables


1. Create a `.env` file in the project root.

2. Edit the `.env` file with your credentials:
`
    DG_USERNAME=your_dailygammon_username
   
    DG_PASSWORD=your_dailygammon_password

    DG_DAYS=30
    DG_USER_ID=36594
   
    GNU_BG_PATH="(path to your executable gnubg-cli.exe)" (or similar in other OSes. Must be the -cli executable!
   
    PORT=3033 (or whatever you like)
`
### Prerequisites

- Install GNU Backgammon locally and note the path to `gnubg.exe`
- Create `.env` from the example and set `GNU_BG_PATH`:

```bash
cp env.example .env
# Edit .env and set GNU_BG_PATH to your gnubg.exe absolute path
```

## Limitations / Backlog

- Currently only supports checker play. Double quizzes will come later
- Haven't ever checked whether there are concurrency issues if the crawler runs while I am quizzing. I don't do this and just let the crawler run once I finished new matches.
- You cannot do moves on the board but have to select the move which is inconvenient.
- Rough around the edges - e.g. no back button in crawler


## Notes
This is 100% "vibe coded" (how I hate the term). I certainly write more beautiful code. But I take 10 times as long. And I don't have 10 times as long.

Also this is a bit messy, but honestly I don't care to clean up such a tiny pet project.


