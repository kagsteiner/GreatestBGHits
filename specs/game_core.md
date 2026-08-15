# The game core

## Summary of what needs to be developed

The game core uses the local Hedgehog adapter directly to analyze checker plays and every legal pre-roll cube decision in a match, determine the relative error of the user's action, and create a sorted set of quiz positions. There is a filtering mechanism to only look at actions from a selected player name. If it is empty, all actions are considered.

Each game position consists of: 

### Checker moves: (type="move")

1. the OGID of the position in which the user made an error
2. the best move, its equity, outcome probabilities, and resulting OGID
3. the user's move, rank, equity, outcome probabilities, and resulting OGID
4. a deterministic higher-ranked sample, when available
5. a deterministic lower-ranked sample, when available
6. Hedgehog model, hash, engine version, ply, and analysis timestamp

### Cube offers (type="cube-offer")

Binary double/no-double quizzes retain the three Hedgehog equities for no
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
