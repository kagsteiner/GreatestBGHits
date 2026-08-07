# The game core

## Summary of what needs to be developed

The game core uses the local Hedgehog adapter directly to analyze every checker-play position in a match, determine the relative error of the user's move, and create a sorted set of quiz positions. There is a filtering mechanism to only look at moves from a selected player name. If it is empty, all moves are considered.

Each game position consists of: 

### Checker moves: (type="move")

1. the OGID of the position in which the user made an error
2. the best move, its equity, outcome probabilities, and resulting OGID
3. the user's move, rank, equity, outcome probabilities, and resulting OGID
4. a deterministic higher-ranked sample, when available
5. a deterministic lower-ranked sample, when available
6. Hedgehog model, hash, engine version, ply, and analysis timestamp

### doubling (type="double") and double-reaction (type="drop" or type="take")

For the first version of this app, we ignore these!

## Internal Backgammon Board 

To perform its task, the game core needs a class that represents a backgammon board incl. doubling cube, match points (how long is the match, how many points do both players have) and dice that were rolled. The data structure needs to support three use cases:

1. visualization of the board on the screen (to be implemented later)
2. generation of an OGID from the board
3. setup of the board from stored position identifiers.

For 2. and 3. functions shall be implemented.
