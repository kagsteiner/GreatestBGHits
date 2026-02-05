# Dealing with Nackgammon 

## Situation

There is a variation of Backgammon that is called Nackgammon. This variation has exactly the same rules as Backgammon, but a different initial position where two additional checkers, taking from the 13 and 5 point, are placed on the 23 point.

The app currently seems to deal with Nackgammon games by ignoring the special line in the exported text of the match, and then trying to make the moves of the game from an initial backgammon position. 

Assumption: if it encounters a move that cannot be made, it doesn't make the move.

Conclusion: the positions that arise are mostly legal positions, albeit positions that might not be possible in a real match. Think about the sequence: 
1. first player makes move that is legal in initial backgammon position, not capturing a checker (because he can't)
2. second player makes a move like 23-xx 
3. first player makes another move

There is no way how a position where one player has made two non-capturing moves while the other player is still in initial position.

## Goal

In a first update I want to exclude Nackgammon matches from being analyzed.

This is the starting moves in an exported game:

Game 1
 magic one : 0                       Pitchofbeer : 0
  1)                                 12: Illegal play (1;0;1;0;1;magic one;Pitchofbeer;0;0;0;1;0;0;-2;-2;0;0;0;4;0;3;0;0;0;-4;4;0;0;0;-3;0;-4;0;0;0;2;2;0;5;1;)
  2) 51: 23/22 13/8                  41: 13/9 9/8

So we check whether a move starts with "Illegal play". If we find such a move, we abort with a message "Nackgammon not supported".

The question remains how we proceed with quizzes that stem from Nackgammon matches.

Ideally, we automatically or manually remove them. As the app features a button "show on DailyGammon", we could go to the respective match, download the notation, check for "Illegal play", and remove the respective quiz. This would be time-consuming but worth it.

Currently, the app should store the URL of the current position in DailyGammon in a link like this:
http://dailygammon.com/bg/game/5209171/0/72
which means "game 5209171, move 72"

To turn this into a link that contains the whole match text, change this string /bg/game/<number>/list to /bg/export/<number>

In our example:
http://dailygammon.com/bg/export/5209171

## Your task

1. add code crawler that creates new quizzes: When in a match file we detect the string "Illegal play", then stop analyzing this file, ideally with a message about Nackgammon games not being supported to the user of the Web UI.

2. Provide a button in the "add quizzes" screen that says "Remove Nackgammon Games", which then will walk through all of the quizzes of the user, read the respective DailyGammon match file, and look for "Illegal play". If the move list contains this string, remove the quiz from the quizzes of the user.