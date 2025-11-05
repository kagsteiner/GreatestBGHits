This specification defines a key component of a node.js app to help a player of the site "DailyGammon" to improve their strenght with multiple-choice quizzes about positions in their actual games where they made a poor move.

The goal of this app is to provide an node.js endpoint that uses a local installation of Gnu Backgammon and its command-line argument 

-p, --python=FILE            Start in Python mode or evaluate code in FILE and exit

along with local python files in our project directory ./python (to be written by you) to achieve a match-based analysis of every position in a JSON file created by backgammon-parser.js.

Please create an endpoint "analyzePositionFromMatch" that takes a GNU Backgammon match ID and returns a list of possible moves in this position - move in backgammon notation + equity after move.

The path to GNU Backgammon is stored in .env with key GNU_BG_PATH. It is an absolute windows path pointing to the Gnu Backgammon Executable, e.g. "C:\Users\agste\AppData\Local\gnubg\gnubg.exe"

As a first IMPORTANT step, please analyze whether this plan is the most viable one. There is also a GNU Backgammon CLI; if communicating with GNU Backgammon via this CLI is more efficient, this is another option. 

