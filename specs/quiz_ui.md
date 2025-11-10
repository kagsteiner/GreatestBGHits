# the quiz UI

## introduction

The Quiz UI's purpose is to show the user positions in a real backgammon UI, along with a multiple choice test that offers four different moves in this position. One of the moves is the best move, one is the player's (wrong) move, and two others are a better move that is not best, and a worse move that is not best. 

The player then selects one of the moves. If he selects the right one, the UI will congratulate the player. Otherwise it will tell the player that this choice was wrong, and show him the right move. Then it moves on to the next position.

## backend communication implementation

The functionality bases on these endpoints from server.js:

/getQuiz - retrieves the next quiz position.

/updateQuiz - submit an update to the quiz; either the player has picked the correct answer or a false one.

## UI implementation

The core of the UI must be a full backgammon board. The board should look clean and beautiful, and scale with the available screen size. The whole UI must be responsive and work for PCs and for mobile phones. Use blue checkers for Player 1 and red checkers for Player 2. Components of the UI:

- the core board, 24 points, typical backgammon triangle shapes. The home fields of both players are on the right side. 
- some vertical space between the upper and the lower points, about 1/4 of the size of a triangle.
- checkers on the board. Paint up to 5 checkers horizontally. If a point contains more than 5 checkers, paint 5 checkers and in the middle of the checker that is closest to the center of the board, write the number of the checkers. 
- to the left and right of the board, the container for stones that were taken off the board (bearoff), next to their home board. The left container is always empty, the stones are shown on the right side. For now just let's show a single checker there with the number of bear off stones. On the left side, only show the cube (1-64)
- in the middle an area for captured stones, ie. the bar point. The top half of the board shows the checkers of one player, the bottom half the checkers of the other player, exactly like on a normal point - up to 5 stacked, then 5 + a number.

Below the board you can see the four different moves, each with a checkbox.

Below the checkbox, a button "Rate my guess".

Below "Rate my guess" a nice label that will contain the response of the UI (congratulations or nope wrong)

## technology stack

Keep it simple, stick with HTML5 + Javascript + CSS, do not use additional client-side frameworks (like react or typescript). The app shall be small.

