# DailyGammon Quiz

A Node.js app for improving your backgammon by turning mistakes from past
DailyGammon matches into multiple-choice quizzes.

## Features

- Retrieves completed DailyGammon matches and analyzes checker plays and cube
  decisions with the DarkBGHelmet engine.
- Saves significant mistakes as quizzes containing the best move, the played
  move, and nearby alternatives.
- Schedules quizzes according to prior answers and shows learning statistics.
- Offers separate checker, cube, and mixed training modes.
- Supports standard backgammon and Nackgammon, including Crawford games.

## Installation

```sh
npm install
```

The app needs Node.js 20 (see `.nvmrc`, which matches production). Analysis is
done by the DarkBGHelmet engine, a separate native program that runs as the pm2
app `bgengine` on the same server and listens on `127.0.0.1:3050` only. Its
HTTP API is described in [CLIENT_GUIDE.md](CLIENT_GUIDE.md). With the engine
running, check the connection with:

```sh
npm run test:engine
```

For local development, build and start the engine from its own repository, for
example `./build/bgserver --host 127.0.0.1 --port 3050 --net nets/latest.bgnn
--data data --threads 2 --plies 3 --cube-extra 0`.

## Configuration

Create `.env` in the project root. DailyGammon credentials are normally supplied
by the login UI; the relevant server and analysis settings, with their
defaults, are:

```dotenv
PORT=3033

BG_ENGINE_URL=http://127.0.0.1:3050
BG_ENGINE_PLIES=3
BG_ENGINE_DEEP_PLIES=4
BG_ENGINE_TIMEOUT_MS=60000
BG_ENGINE_DEEP_TIMEOUT_MS=300000
BG_ENGINE_MAX_PENDING=8
```

Depths follow the XG convention: 1-ply is the static network evaluation, 3-ply
looks two rolls ahead (comparable to GNU Backgammon's 2-ply “World Class”).
Imported matches are analyzed at `BG_ENGINE_PLIES`; the quiz page's “Deep
Analysis” button re-analyzes one quiz at `BG_ENGINE_DEEP_PLIES`. Cube decisions
use the same depth as checker plays. Requests are sent to the engine one at a
time; at most `BG_ENGINE_MAX_PENDING` may wait, and a connection error is
retried once, because the engine restarts within seconds after an update.

Each checker quiz grades the played move with the engine's full-depth `played`
evaluation. When the move is a mistake, the two alternative answers are
re-evaluated at the same depth, so all four options have comparable equities.
Cube quizzes are graded from the no double / double-take / double-pass
equities, which are money-equivalent (EMG) in match play.

## Existing quiz migration

Do not copy `app.db`, `app.db-wal`, and `app.db-shm` one after another while
the production process is writing to them. Create one consistent SQLite
snapshot instead; SQLite's backup API includes committed data currently held in
the WAL:

```sh
npm run snapshot:db -- --source data/app.db --output /tmp/app-production-snapshot.db
```

The command refuses to overwrite an existing file and verifies the resulting
snapshot with `PRAGMA integrity_check`. Transfer that single snapshot file and
keep it under a distinct local name such as `data/production-snapshot.db`.

Before starting this version against an existing database, stop the old app and
run the structural migration. It is a dry run unless `--apply` is supplied:

```sh
npm run migrate:quizzes -- --db data/app.db
npm run migrate:quizzes -- --db data/app.db --audit
npm run migrate:quizzes -- --db data/app.db --exclude-invalid
npm run migrate:quizzes -- --db data/app.db --apply --exclude-invalid
```

The apply command creates a timestamped SQLite backup, converts every stored
position to OGID in one transaction, checks SQLite integrity, and verifies with
a SHA-256 digest that all data outside the identifier/schema conversion stayed
unchanged. It refuses malformed JSON, duplicate quiz IDs, non-canonical OGIDs,
checker collisions, and dice mismatches.
The optional audit reports every structurally invalid quiz without writing to
the database; the normal dry run and apply modes stop at the first error.
`--exclude-invalid` removes exactly the position-level findings from that same
audit while migrating, records every exclusion in the command report, and still
refuses row-level corruption. Apply mode creates its backup before any write.

Next, re-analyze every quiz with the DarkBGHelmet engine. This step is
resumable and commits one quiz at a time, so it may run while the app is
online. A quiz is not served until this step has completed successfully for it,
and quizzes analyzed with an older network are picked up again after the engine
network changes:

```sh
npm run reanalyze:quizzes -- --db data/app.db
npm run reanalyze:quizzes -- --db data/app.db --audit
npm run reanalyze:quizzes -- --db data/app.db --apply --exclude-unrecognized
npm run verify:quizzes -- --db data/app.db
```

`--plies N` overrides the depth (default `BG_ENGINE_PLIES`). Each stored answer
includes equity and, where the engine returned them, win, gammon-win,
backgammon-win, gammon-loss, and backgammon-loss probabilities, plus the engine
version, network, and depth. If the new analysis changes a best move, prior
learning counters are archived in the quiz history and reset. Quizzes that are
no longer mistakes are retained for auditability but marked inactive.

The optional `--audit` mode runs every pending position through the engine
without changing the database and reports all move-recognition or evaluation
errors instead of stopping at the first one.
During apply, `--exclude-unrecognized` removes only quizzes whose stored played
move the engine rejects as illegal. Connection failures, timeouts, invalid
evaluations, and other errors still stop immediately.

## Usage

Run `npm start`, then open `http://localhost:3033` (or the configured port).
`/health` reports the engine connection. Positions are stored as OpenGammon
IDs (OGID) throughout the application and converted to the engine's board
format for each request. The only legacy decoder is
quarantined in the one-time schema migration and can be removed after every
deployed database has been verified on schema version 2.

The match-analysis tracker is versioned. After upgrading from a checker-only
release, the next "Add New Quizzes" run reprocesses matches in the selected date
window so cube mistakes can be added. Stable checker IDs prevent duplicate
checker quizzes during that pass.

## Limitations

- Match analysis speed depends on the search depth and the server's CPU.
- Quiz answers are selected from a list rather than played on the board.

## Notes

This is a private hobby and training project. It has been developed with extensive
LLM assistance and is intentionally pragmatic rather than polished.
