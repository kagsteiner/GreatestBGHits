'use strict';

const http = require('http');
const url = require('url');
const BackgammonBoard = require('../src/board');

const die1 = process.argv[3] ? Number(process.argv[3]) : 3;
const die2 = process.argv[4] ? Number(process.argv[4]) : 1;
const board = BackgammonBoard.starting('player1');
board.dice = { die1, die2 };
const inputOgid = process.argv[2] || board.toOgid();

const endpoint = process.env.ANALYZE_URL || 'http://localhost:3000/analyzePosition';
const parsed = url.parse(endpoint);

const body = { ogid: inputOgid };
if (Number.isFinite(die1) && Number.isFinite(die2)) {
    body.dice = { die1, die2 };
}
const payload = JSON.stringify(body);

const options = {
    hostname: parsed.hostname,
    port: parsed.port || 80,
    path: parsed.path,
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
    }
};

console.log('Posting to', endpoint);
console.log('ogid =', inputOgid);
if (body.dice) {
    console.log('dice =', body.dice.die1, body.dice.die2);
}

const req = http.request(options, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
        try {
            const json = JSON.parse(body);
            console.log('\nResponse:');
            console.log(JSON.stringify(json, null, 2));
        } catch (e) {
            console.error('Non-JSON response:', body);
        }
    });
});

req.on('error', (e) => {
    console.error('Request error:', e.message);
});

req.write(payload);
req.end();

