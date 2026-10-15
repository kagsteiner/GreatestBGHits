# Quiz storage schema

Quiz data is stored per user in the `user_data.quizzes_json` column. The active
schema is version 2 and uses OGID as its only board-position identifier.

```json
{
  "schemaVersion": 2,
  "threshold": 0.08,
  "cubeThreshold": 0.08,
  "positions": [
    {
      "id": "stable-quiz-id",
      "type": "move",
      "ogid": "11ccccchhhjjjjj:66666888dddddoo:N0N:31:B:R:0:0:7:0",
      "active": true,
      "best": {
        "move": "8/5 6/5",
        "equity": 0.087,
        "evaluation": {
          "win": 0.55,
          "gammonWin": 0.15,
          "backgammonWin": 0.02,
          "gammonLoss": 0.10,
          "backgammonLoss": 0.01
        },
        "ply": 3
      },
      "user": {
        "name": "player",
        "move": "8/3 8/5",
        "rank": 4,
        "equity": -0.29,
        "evaluation": {
          "win": 0.42,
          "gammonWin": 0.09,
          "backgammonWin": 0.01,
          "gammonLoss": 0.18,
          "backgammonLoss": 0.03
        },
        "ply": 3
      },
      "higherSample": null,
      "lowerSample": null,
      "analysis": {
        "engine": "darkbghelmet",
        "engineVersion": "0.1.0",
        "network": "dbgh-h1024-ep12+cube",
        "plies": 3,
        "analyzedAt": "2026-10-10T00:00:00.000Z"
      },
      "context": {
        "gameNumber": 1,
        "plyIndex": 16,
        "player": "player1",
        "dice": { "die1": 5, "die2": 3, "isDouble": false, "total": 8 },
        "equityDiff": 0.377
      },
      "quiz": { "playCount": 3, "correctAnswers": 1 }
    }
  ]
}
```

Cube records use `type: "cube-offer"` or `type: "cube-response"`. Their
`best` and `user` values contain `action`, `label`, and `equity`; `options`
contains the two UI choices; and `cubeAnalysis` retains no-double,
double/take, and double/pass equities (money-equivalent in match play) plus
the engine's decision text. Their analysis provenance has the same fields as
checker records; `plies` is the cube search depth.

The five probabilities are stored on retained checker answer choices whenever
the engine returned them for that play. Gammon and
backgammon probabilities are inclusive: `backgammonWin <= gammonWin <= win`,
with the equivalent constraint on losses.

Re-analysis never changes quiz IDs, owners, source match metadata, or the played
move. When a new analysis changes the best move, existing learning counters
are appended to `quiz.history` and the current counters restart at zero. A
record that is no longer a qualifying mistake remains stored with
`active: false` for auditability and is not served.
