# multiuser support

Your task: perform the necessary changes to turn this app from a POC for a single user to an app that can be used productively by multiple users. This requires three sub-tasks:

1. login mechanism
2. convert the JSON persistence to a database
3. synchronization of crawling

## login mechanism

Note: this is an app to be used in conjunction with the backgammon site "DailyGammon" which has notoriously poor security - still uses HTTP, even for the login screen. Do not over-invest into this login mechanism. I suggest to store the user / password in the localStorage of the browser.

When no user and password are stored, index.html shall show a modal that forces the user to login before they can use the app.

## database

Note: I assume the app will have less than 100 users. I suggest sqlite.

The database needs the user name as key, and needs to store the contents of quizzes.json and the contents of analyzed_matches.json.

Ensure that updates of the database are atomic, particularly write access by the crawler who adds new quizzes and by the player who makes a quiz and adds new statistical data to the quiz about his progress. Of course it is not an issue that the same record can be affected. Analyze how to cover the endpoint that selects the next quiz for the user.

## synchronization of crawling

Please turn the endpoint to look for new matches into a queue. A new user's request has to wait until the queue is empty. We shall have only one GnuBG instance running at a certain point in time, no concurrency - the app will run on a server without much computing power and memory.

Enhance the app so that the UI writes a sentence to the screen with the number of users in the queue before him and updates it this number until it's the user's turn.
