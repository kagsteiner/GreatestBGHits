# a simple data storage for quiz positions

Implement a data storage for quiz positions and methods to add / update them. For our MVP we keep it really simple and 
represent the database as a single JSON file, and only one user adds positions and plays the quiz. Later we will have to
make it possible for different users to add their matches and play the quiz on their matches or on other people's matches.

## storage: 

The position database shall contain a list of positions as created by gameCore.buildGamePositions. The format is shown below.

The JSON shall contain an additional sub-structure like "context":
"quiz": {
    "playCount": <how often this quiz was shown>
    "correctAnswers": <how often this quiz was solved>
}

This JSON is an example of the data to be stored.

{
  "engineAvailable": true,
  "threshold": 0.08,
  "positions": [
    {
      "type": "move",
      "gnuId": "3ZcBgMA5dw0AAA:MIEOAAAAAAAA",
      "best": {
        "move": "8/3 6/3",
        "equity": 0.087
      },
      "user": {
        "name": "hape42",
        "move": "8/3 8/5",
        "equity": -0.29,
        "rank": 9
      },
      "higherSample": {
        "move": "8/3 6/3",
        "equity": 0.087
      },
      "lowerSample": null,
      "context": {
        "gameNumber": 1,
        "plyIndex": 16,
        "player": "player1",
        "dice": {
          "die1": 5,
          "die2": 3,
          "isDouble": false,
          "total": 8
        },
        "equityDiff": 0.377
      }
    },
    {
      "type": "move",
      "gnuId": "jLuDAQbQ88EBKA:cAkKAAAAAAAA",
      "best": {
        "move": "24/20 23/21",
        "equity": -0.86
      },
      "user": {
        "name": "darkhelmet",
        "move": "24/20 5/3",
        "equity": -1,
        "rank": 4
      },
      "higherSample": {
        "move": "24/20 8/6",
        "equity": -1
      },
      "lowerSample": {
        "move": "8/2",
        "equity": -1
      },
      "context": {
        "gameNumber": 1,
        "plyIndex": 3,
        "player": "player2",
        "dice": {
          "die1": 4,
          "die2": 2,
          "isDouble": false,
          "total": 6
        },
        "equityDiff": 0.14
      }
    },
    {
      "type": "move",
      "gnuId": "xPPBARGMu4MBBg:MAEHAAAAAAAA",
      "best": {
        "move": "8/2* 6/5*",
        "equity": 0.609
      },
      "user": {
        "name": "hape42",
        "move": "21/15 21/20",
        "equity": 0.49,
        "rank": 3
      },
      "higherSample": {
        "move": "8/2* 6/5*",
        "equity": 0.609
      },
      "lowerSample": {
        "move": "8/2* 7/6",
        "equity": 0.436
      },
      "context": {
        "gameNumber": 1,
        "plyIndex": 4,
        "player": "player1",
        "dice": {
          "die1": 6,
          "die2": 1,
          "isDouble": false,
          "total": 7
        },
        "equityDiff": 0.119
      }
    }
  ]
}


## implementation

Add these methods to gameCore:

loadQuizzes() - loads the quizzes from .\quizzes.json
saveQuizzes() - saves them to .\quizzes.json. IMPORTANT: checks for duplicates
getNextQuiz() - retrieves the next quiz: for every quiz position, evaluate the importance by this rule: importance = equityLossOfUserPosition / #successFulPlays. Retrieve the position with the highest importance.
addQuizzesAndSave() - connects to DailyGammon and retrieves the  