'use strict';

const BackgammonBoard = require('../src/board');

const board = BackgammonBoard.starting('player1');
const posId = board.toPositionId();
console.log('Position-ID:', posId);


