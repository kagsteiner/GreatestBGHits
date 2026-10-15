# The game core

## Summary of what needs to be developed

The game core uses the DarkBGHelmet engine (`src/engines/bgEngine.js`, an HTTP client for the VPS-local engine) to analyze checker plays and every legal pre-roll cube decision in a match, determine the relative error of the user's action, and create a sorted set of quiz positions. There is a filtering mechanism to only look at actions from a selected player name. If it is empty, all actions are considered.

Each game position consists of: 

### Checker moves: (type="move")

1. the OGID of the position in which the user made an error
2. the best move, its equity, outcome probabilities, and search depth
3. the user's move, rank, equity, outcome probabilities, and search depth, judged by the engine at full depth
4. a deterministic higher-ranked alternative, when available
5. a deterministic lower-ranked alternative, when available
6. engine, engine version, network, search depth (plies), and analysis timestamp

For an actual mistake, the two alternatives are re-evaluated at the full depth so
that all answer options have comparable equities.

### Cube offers (type="cube-offer")

Binary double/no-double quizzes retain the three engine equities (money-equivalent in match play) for no
double, double/take, and double/pass plus the recommended action.

### Cube responses (type="cube-response")

Binary take/pass quizzes reuse the offer analysis and express choice equities
from the responder's perspective. Accepted doubles update cube value and assign
ownership to the taker before checker replay continues. The opening roll and
Crawford games never generate cube decisions.

## Internal Backgammon Board 

To perform its task, the game core needs a class that represents a backgammon board incl. doubling cube, match points (how long is the match, how many points do both players have) and dice that were rolled. The data structure needs to support three use cases:

1. visualization of the board on the screen (to be implemented later)
2. generation of an OGID from the board
3. setup of the board from stored position identifiers.

For 2. and 3. functions shall be implemented.
