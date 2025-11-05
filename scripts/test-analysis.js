'use strict';

const http = require('http');
const url = require('url');

const DEFAULT_ID = 'zD2DAyBsO8EIIg:8AkmAYAAGAAE';
const inputId = process.argv[2] || DEFAULT_ID;

const endpoint = process.env.ANALYZE_URL || 'http://localhost:3000/analyzePositionFromMatch';
const parsed = url.parse(endpoint);

const payload = JSON.stringify({ matchId: inputId });

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


