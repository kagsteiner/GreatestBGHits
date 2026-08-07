# DailyGammon Quiz

A Node.js app for improving your backgammon by turning mistakes from past
DailyGammon matches into multiple-choice quizzes.

## Features

- Retrieves completed DailyGammon matches and analyzes checker plays locally
  with the Hedgehog engine.
- Saves significant mistakes as quizzes containing the best move, the played
  move, and nearby alternatives.
- Schedules quizzes according to prior answers and shows learning statistics.
- Supports standard backgammon and Nackgammon checker play.

## Installation

Install Node.js dependencies and the pinned Hedgehog runtime plus the default
Aureus model:

```sh
npm install
npm run hedgehog:install
npm run test:hedgehog
```

The installer verifies every downloaded asset against the SHA-256 values in
`vendor/hedgehog/manifest.json`. Engine files remain local and must be copied
to the VPS with the application; the running server does not download them.
Review the [Hedgehog community terms](https://hedgehog-bg.com/community) before
deploying the assets.

## Configuration

Create `.env` in the project root. DailyGammon credentials are normally supplied
by the login UI; the relevant server and analysis settings are:

```dotenv
PORT=3033

HEDGEHOG_MODEL=aureus-v0.1
HEDGEHOG_PLY=2
HEDGEHOG_TIMEOUT_MS=120000
HEDGEHOG_MAX_PENDING=4
```

Available pinned model profiles are:

- `aureus-v0.1` — default; strongest result in current testing, but relatively slow at 2-ply.
- `fox-v0.3` — fast and promising; retained for continued evaluation.
- `fox-v0.32` — available for reproducibility, but not preferred because testing found it weaker.

Install or smoke-test a particular model with:

```sh
npm run hedgehog:install -- fox-v0.3
npm run test:hedgehog -- fox-v0.3
```

Restart the server after changing `HEDGEHOG_MODEL`. Optional path overrides are
`HEDGEHOG_ASSET_DIR`, `HEDGEHOG_MODULE_PATH`, `HEDGEHOG_WASM_PATH`,
`HEDGEHOG_MODEL_PATH`, and `HEDGEHOG_MANIFEST_PATH`.

## Existing quiz migration

Before starting this version against an existing database, stop the old app and
run the structural migration. It is a dry run unless `--apply` is supplied:

```sh
npm run migrate:quizzes -- --db data/app.db
npm run migrate:quizzes -- --db data/app.db --apply
```

The apply command creates a timestamped SQLite backup, converts every stored
position to OGID in one transaction, checks SQLite integrity, and verifies with
a SHA-256 digest that all data outside the identifier/schema conversion stayed
unchanged. It refuses malformed JSON, duplicate quiz IDs, non-canonical OGIDs,
and dice mismatches.

Next, re-analyze every quiz with the selected pinned Hedgehog model. This step
is resumable and commits one quiz at a time, so it may run while the app is
online. A quiz is not served until this step has completed successfully for it:

```sh
npm run reanalyze:quizzes -- --db data/app.db --model aureus-v0.1
npm run reanalyze:quizzes -- --db data/app.db --model aureus-v0.1 --apply
npm run verify:quizzes -- --db data/app.db --model aureus-v0.1
```

Each stored answer includes equity and win, gammon-win, backgammon-win,
gammon-loss, and backgammon-loss probabilities plus model/version/hash
provenance. If the new model changes a best move, prior learning counters are
archived in the quiz history and reset. Quizzes that are no longer mistakes are
retained for auditability but marked inactive.

## Usage

Run `npm start`, then open `http://localhost:3033` (or the configured port).
Hedgehog runs inside a persistent worker thread in the Node.js process. Analysis
uses OGID directly throughout the active application. The only legacy decoder is
quarantined in the one-time schema migration and can be removed after every
deployed database has been verified on schema version 2.

## Limitations

- Only checker play is analyzed; cube decisions are not yet quiz types.
- Match analysis can take a long time, especially with Aureus at 2-ply.
- Quiz answers are selected from a list rather than played on the board.

## Notes

This is a private hobby and training project. It has been developed with extensive
LLM assistance and is intentionally pragmatic rather than polished.
