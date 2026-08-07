# Nackgammon Support Specification

Add support for the backgammon variant Nackgammon. The only difference between Nackgammon and Backgammon is a different starting position. For every player, two checkers are placed differently.

**Backgammon**
- 5 checkers on the 13 point
- 5 checkers on the 6 point

**Nackgammon**
- 4 checkers on the 13 point
- 4 checkers on the 6 point
- 2 checkers on the 23 point

## How to detect Nackgammon matches
Match export files from DailyGammon contain a special "illegal play" in the beginning. 

### Examples:

These are the beginning of exported files of Nackgammon matches. 

### Player 1 moves first:
1 point match

 Game 1
 doright : 0                         Deb22 : 0
  1)                                 12: Illegal play (1;0;1;0;1;doright;Deb22;0;0;0;1;0;0;-2;-2;0;0;0;4;0;3;0;0;0;-4;4;0;0;0;-3;0;-4;0;0;0;2;2;0;6;4;)
  2) 64: 24/18 18/14                 43: 24/20 23/20
  3) 43: 14/10 13/10                 62: 24/18 20/18
  4) 62: 24/18 18/16                 32: 23/20 6/4

The match starts with the move 64 by Player 1. The 1) and 12 roll: illegal play are there to mark it as Nackgammon. 

 ### Player 2 moves first:
1 point match

 Game 1
 langdon79 : 0                       William8 : 0
  1) 12: Illegal play (1;0;1;0;0;William8;langdon79;0;0;0;1;0;0;-2;-2;0;0;0;4;0;3;0;0;0;-4;4;0;0;0;-3;0;-4;0;0;0;2;2;0;6;1;) 61: 13/7 8/7
  2) 31: 8/5 6/5                     62: 23/21 13/7
  3) 66: 13/7 13/7 8/2* 8/2          52:
  4) 63: 24/21 21/15                 44: 25/21 21/17 13/9 13/9
  5) 21: 15/13 6/5                   41: 9/5 6/5

The match starts with move 61 by the second player. The 12 is a non-existing roll.

### Conclusion
I have no clue what exactly the semicolon-separated numbers in brackets mean. It is probably a position log, but as Nackgammon is, according to my knowledge, the only situation where such an illegal play is used, I suggest we identify a Nackgammon by a 12 roll with an Illegal play first. If we detect this, we initialize the board with the Nackgammon position and then continue like we would analyze a Backgammon match.

## Other considerations
Except for the starting position, information in the internet says that strategy for a Nackgammon match is subtly different, so we need to make it clear whether a quiz is a Nackgammon or Backgammon quiz. 

The headline of the quiz includes text like this:

Match to 11 points, 1 : 2

I suggest we change it to
Nack Match to 11 points, 1 : 2

for Nackgammon