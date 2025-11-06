# The game core

## Summary of what needs to be developed

The game core shall be a node.js app that uses the server.js endpoint analyzePositionFromMatch to analyze every single position in a match, determine the relative error of the user's move, and creates a sorted set of "game positions". There shall be a filtering mechanism to only look at moves from user of a certain name. If it is empty, all moves are considered.

Each game position consists of: 

### Checker moves: (type="move")

1. the gnu id (matchid:positionid) of the position in which the user made an error
2. the best move and its equity
3. the user's move and its equity
4. One randomly picked move that is higher ranked than the user's move, and its equity. If the user's move is the second best, then the third best move.
5. One randomly picked move that is lower ranked than the user's move, ideally one of the next two moves.

### doubling (type="double") and double-reaction (type="drop" or type="take")

For the first version of this app, we ignore these!

## Internal Backgammon Board 

To perform its task, the game core needs a class that represents a backgammon board incl. doubling cube, match points (how long is the match, how many points do both players have) and dice that were rolled. The data structure needs to support three use cases:

1. visualization of the board on the screen (to be implemented later)
2. generation of a gnu id from the board
3. setup of the board from a gnu id.

For 2. and 3. functions shall be implemented.
