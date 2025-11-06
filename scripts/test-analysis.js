'use strict';

const http = require('http');
const url = require('url');

const DEFAULT_ID = '4PPgASjg2+ABMA:MIHtAAAAAAAE';
const inputId = process.argv[2] || DEFAULT_ID;
const die1 = process.argv[3] ? Number(process.argv[3]) : undefined;
const die2 = process.argv[4] ? Number(process.argv[4]) : undefined;

const endpoint = process.env.ANALYZE_URL || 'http://localhost:3000/analyzePositionFromMatch';
const parsed = url.parse(endpoint);

const body = { matchId: inputId };
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
console.log('matchId =', inputId);
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


