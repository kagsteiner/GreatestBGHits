const axios = require('axios');

/**
 * Backgammon Match File Parser
 * Parses DailyGammon export files into structured JSON format
 */
class BackgammonParser {
    constructor() {
        this.movePattern = /^(\d+)\)\s*(.*)$/;
        this.rollMovePattern = /^(\d{1,2}):\s*(.*)$/;
        this.scorePattern = /^(.+?)\s*:\s*(\d+)\s+(.+?)\s*:\s*(\d+)$/;
    }

    /**
     * Parse a complete backgammon match file
     * @param {string} fileContent - The raw text content of the match file
     * @returns {Object} - Structured match data
     */
    parseMatch(fileContent) {
        const lines = fileContent.split('\n').map(line => line.trim()).filter(line => line);

        const match = {
            matchLength: null,
            games: [],
            players: {
                player1: null,
                player2: null
            },
            finalScore: {
                player1: 0,
                player2: 0
            },
            winner: null
        };

        let currentGame = null;
        let currentLine = 0;

        // Parse match length from first line
        if (lines[0]) {
            const matchLengthMatch = lines[0].match(/(\d+)\s+point\s+match/i);
            if (matchLengthMatch) {
                match.matchLength = parseInt(matchLengthMatch[1]);
                currentLine = 1;
            }
        }

        while (currentLine < lines.length) {
            const line = lines[currentLine];

            // Check for game header
            if (line.startsWith('Game ')) {
                if (currentGame) {
                    match.games.push(currentGame);
                }

                const gameNumber = parseInt(line.match(/Game (\d+)/)[1]);
                currentGame = {
                    gameNumber,
                    players: {
                        player1: null,
                        player2: null
                    },
                    startingScore: {
                        player1: 0,
                        player2: 0
                    },
                    moves: [],
                    result: null,
                    doubleValue: 1
                };
                currentLine++;
                continue;
            }

            // Check for player names and scores line
            if (currentGame && this.scorePattern.test(line)) {
                const scoreMatch = line.match(this.scorePattern);
                if (scoreMatch) {
                    currentGame.players.player1 = scoreMatch[1].trim();
                    currentGame.startingScore.player1 = parseInt(scoreMatch[2]);
                    currentGame.players.player2 = scoreMatch[3].trim();
                    currentGame.startingScore.player2 = parseInt(scoreMatch[4]);

                    // Set match-level player names if not set
                    if (!match.players.player1) {
                        match.players.player1 = currentGame.players.player1;
                        match.players.player2 = currentGame.players.player2;
                    }
                }
                currentLine++;
                continue;
            }

            // Check for move lines
            if (currentGame && this.movePattern.test(line)) {
                const move = this.parseMoveLine(line);
                if (move) {
                    currentGame.moves.push(move);
                }
                currentLine++;
                continue;
            }

            // Check for game result lines
            if (currentGame && (line.includes('Wins') || line.includes('and the match'))) {
                currentGame.result = this.parseGameResult(line);
                if (line.includes('and the match')) {
                    match.winner = this.determineWinner(line, match.players);
                }
                currentLine++;
                continue;
            }

            currentLine++;
        }

        // Add the last game
        if (currentGame) {
            match.games.push(currentGame);
        }

        // Calculate final scores
        this.calculateFinalScores(match);

        return match;
    }

    /**
     * Parse a single move line
     * @param {string} line - The move line to parse
     * @returns {Object|null} - Parsed move object
     */
    parseMoveLine(line) {
        const moveMatch = line.match(this.movePattern);
        if (!moveMatch) return null;

        const moveNumber = parseInt(moveMatch[1]);
        const moveContent = moveMatch[2];

        // Split into player 1 and player 2 moves
        const parts = moveContent.split(/\s{2,}/); // Split on multiple spaces

        const move = {
            moveNumber,
            player1: this.parsePlayerMove(parts[0] || ''),
            player2: this.parsePlayerMove(parts[1] || '')
        };

        return move;
    }

    /**
     * Parse an individual player's move
     * @param {string} moveText - The move text for one player
     * @returns {Object} - Parsed player move
     */
    parsePlayerMove(moveText) {
        moveText = moveText.trim();

        if (!moveText) {
            return { type: 'no_move' };
        }

        // Handle special moves
        if (moveText.includes('Doubles')) {
            const doubleMatch = moveText.match(/Doubles\s*=>\s*(\d+)/);
            return {
                type: 'double',
                value: doubleMatch ? parseInt(doubleMatch[1]) : 2
            };
        }

        if (moveText.includes('Takes')) {
            return { type: 'take' };
        }

        if (moveText.includes('Drops')) {
            return { type: 'drop' };
        }

        if (moveText.includes('Wins')) {
            const winMatch = moveText.match(/Wins\s+(\d+)\s+points?/);
            return {
                type: 'win',
                points: winMatch ? parseInt(winMatch[1]) : 1
            };
        }

        // Handle regular moves with dice roll
        const rollMatch = moveText.match(this.rollMovePattern);
        if (rollMatch) {
            const dice = rollMatch[1];
            const moves = rollMatch[2].trim();

            return {
                type: 'move',
                dice: this.parseDice(dice),
                moves: moves ? this.parseMoves(moves) : []
            };
        }

        // Handle moves without dice (when player can't move)
        if (moveText.includes(':')) {
            return {
                type: 'move',
                dice: null,
                moves: []
            };
        }

        return { type: 'unknown', text: moveText };
    }

    /**
     * Parse dice notation
     * @param {string} dice - Dice string (e.g., "61", "33")
     * @returns {Object} - Parsed dice
     */
    parseDice(dice) {
        if (dice.length === 2) {
            const die1 = parseInt(dice[0]);
            const die2 = parseInt(dice[1]);
            return {
                die1,
                die2,
                isDouble: die1 === die2,
                total: die1 + die2
            };
        }
        return null;
    }

    /**
     * Parse move notation (e.g., "13/7 8/7" or "24/21* 24/21 6/3 6/3")
     * Also handles bar entries (e.g., "bar/21") and bearoffs (e.g., "6/off")
     * @param {string} movesText - The moves portion of a turn
     * @returns {Array} - Array of individual moves
     */
    parseMoves(movesText) {
        if (!movesText || movesText.trim() === '') {
            return [];
        }

        const moves = [];
        const moveParts = movesText.split(/\s+/);

        moveParts.forEach(part => {
            part = part.trim();
            if (!part) return;

            // Match moves: numeric/numeric, bar/numeric, numeric/off, bar/off (all with optional *)
            // Examples: "13/7", "bar/21*", "6/off", "24/21*"
            const moveMatch = part.match(/^(bar|\d+)\/(off|\d+)(\*)?$/i);
            if (moveMatch) {
                // Convert 'bar' to 25 and 'off' to 0 for internal representation
                let from = moveMatch[1].toLowerCase() === 'bar' ? 25 : parseInt(moveMatch[1]);
                let to = moveMatch[2].toLowerCase() === 'off' ? 0 : parseInt(moveMatch[2]);

                moves.push({
                    from: from,
                    to: to,
                    hit: !!moveMatch[3] // * indicates hitting opponent's checker
                });
            }
        });

        return moves;
    }

    /**
     * Parse game result line
     * @param {string} line - Result line
     * @returns {Object} - Game result
     */
    parseGameResult(line) {
        const winMatch = line.match(/Wins\s+(\d+)\s+points?/);
        const points = winMatch ? parseInt(winMatch[1]) : 1;
        const isMatch = line.includes('and the match');

        return {
            points,
            isMatchEnd: isMatch
        };
    }

    /**
     * Determine match winner from result line
     * @param {string} line - Result line containing winner info
     * @param {Object} players - Player names
     * @returns {string} - Winner name
     */
    determineWinner(line, players) {
        // The winner is typically the player who made the winning move
        // This would need to be determined by tracking the current player
        // For now, we'll return null and let the caller determine
        return null;
    }

    /**
     * Calculate final match scores
     * @param {Object} match - Match object to update
     */
    calculateFinalScores(match) {
        let score1 = 0;
        let score2 = 0;

        match.games.forEach(game => {
            if (game.result) {
                // Determine which player won based on the move structure
                // This is simplified - in practice you'd track which player made the winning move
                const lastMove = game.moves[game.moves.length - 1];
                if (lastMove) {
                    if (lastMove.player1 && lastMove.player1.type === 'win') {
                        score1 += lastMove.player1.points || game.result.points;
                    } else if (lastMove.player2 && lastMove.player2.type === 'win') {
                        score2 += lastMove.player2.points || game.result.points;
                    }
                }
            }
        });

        match.finalScore.player1 = score1;
        match.finalScore.player2 = score2;
    }

    /**
     * Download and parse a match file from DailyGammon
     * @param {string} exportUrl - Full URL to the export file
     * @param {Object} session - Axios session with authentication
     * @returns {Promise<Object>} - Parsed match data
     */
    async downloadAndParseMatch(exportUrl, session) {
        try {
            console.log(`Downloading match from: ${exportUrl}`);

            const response = await session.get(exportUrl);
            const fileContent = response.data;

            if (typeof fileContent !== 'string') {
                throw new Error('Expected text content, got: ' + typeof fileContent);
            }

            return this.parseMatch(fileContent);
        } catch (error) {
            console.error(`Error downloading/parsing match ${exportUrl}:`, error.message);
            throw error;
        }
    }

    /**
     * Parse multiple matches from export URLs
     * @param {string[]} exportUrls - Array of export URLs
     * @param {Object} session - Authenticated axios session
     * @returns {Promise<Object[]>} - Array of parsed matches
     */
    async parseMultipleMatches(exportUrls, session) {
        const matches = [];

        for (const url of exportUrls) {
            try {
                const match = await this.downloadAndParseMatch(url, session);
                matches.push({
                    url,
                    match,
                    parseDate: new Date().toISOString()
                });
            } catch (error) {
                console.error(`Failed to parse match from ${url}:`, error.message);
                matches.push({
                    url,
                    error: error.message,
                    parseDate: new Date().toISOString()
                });
            }
        }

        return matches;
    }
}

module.exports = BackgammonParser; 