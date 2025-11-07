'use strict';

// Usage: node scripts/inspect-gnuid.js <GNU_ID or PositionID[:MatchID]>

function base64ToBytes(text) {
    if (typeof text !== 'string' || !text) return Buffer.alloc(0);
    const padLen = (4 - (text.length % 4)) % 4;
    const padded = text + '='.repeat(padLen);
    return Buffer.from(padded, 'base64');
}

function bytesToBitsLe(bytes) {
    const bits = [];
    for (let i = 0; i < bytes.length; i++) {
        const v = bytes[i];
        for (let b = 0; b < 8; b++) bits.push((v >> b) & 1);
    }
    return bits;
}

function sliceBits(bits, start, width) {
    const arr = [];
    for (let i = 0; i < width; i++) arr.push(bits[start + i] || 0);
    return arr;
}

function binOf(bits) {
    return bits.map((b) => (b ? '1' : '0')).join('');
}

function printPositionId(posId) {
    console.log('--- Position ID ---');
    console.log('ID:', posId);
    const bytes = base64ToBytes(posId);
    console.log('Bytes (len):', bytes.length);
    if (bytes.length !== 10) {
        console.log('ERROR: Position ID should decode to 10 bytes.');
        return;
    }
    const bits = bytesToBitsLe(bytes).slice(0, 80);
    console.log('Bits (len):', bits.length);
    let ptr = 0;
    for (let side = 0; side < 2; side++) {
        const sideLabel = side === 0 ? 'P1' : 'P2';
        for (let p = 1; p <= 24; p++) {
            let ones = 0; const start = ptr;
            while (ptr < bits.length && bits[ptr] === 1) { ones++; ptr++; }
            const term = ptr < bits.length ? bits[ptr] : 0; // should be 0
            ptr++;
            const end = ptr - 1;
            console.log(`${sideLabel} Point ${p}: ones=${ones}, term=${term} [${start}..${end}]`);
        }
        // bar
        let ones = 0; const start = ptr;
        while (ptr < bits.length && bits[ptr] === 1) { ones++; ptr++; }
        const term = ptr < bits.length ? bits[ptr] : 0;
        ptr++;
        const end = ptr - 1;
        console.log(`${sideLabel} Bar: ones=${ones}, term=${term} [${start}..${end}]`);
    }
    if (ptr < bits.length) {
        console.log('Remainder bits:', binOf(bits.slice(ptr)));
    }
}

function printMatchId(mid) {
    console.log('--- Match ID ---');
    console.log('ID:', mid);
    const bytes = base64ToBytes(mid);
    console.log('Bytes (len):', bytes.length);
    if (bytes.length !== 9) {
        console.log('ERROR: Match ID should decode to 9 bytes.');
        return;
    }
    const bits = bytesToBitsLe(bytes);
    let ptr = 0;
    function read(width) {
        let v = 0;
        for (let i = 0; i < width; i++) v |= (bits[ptr + i] & 1) << i;
        const seg = sliceBits(bits, ptr, width);
        const start = ptr; ptr += width; const end = ptr - 1;
        return { v, seg, start, end };
    }

    const cubeExp = read(4);
    const cubeOwner = read(2);
    const roller = read(1);
    const crawford = read(1);
    const gameState = read(3);
    const decisionOwner = read(1);
    const doubleOffered = read(1);
    const resignation = read(2);
    const die1 = read(3);
    const die2 = read(3);
    const matchLen = read(15);
    const scoreP1 = read(15);
    const scoreP2 = read(15);

    function line(label, field) {
        console.log(`${label}: bits[${field.start}..${field.end}] ${binOf(field.seg)} => ${field.v}`);
    }

    line('Cube exponent (log2(cube))', cubeExp);
    line('Cube owner (00=P1,01=P2,11=center)', cubeOwner);
    line('Roller (0=P1,1=P2)', roller);
    line('Crawford (1=yes,0=no)', crawford);
    line('Game state (000 none,001 in progress,010 over,011 resigned,100 dropped)', gameState);
    line('Decision owner (0=P1,1=P2)', decisionOwner);
    line('Double offered (1=yes,0=no)', doubleOffered);
    line('Resignation (00 none,01 single,10 gammon,11 backgammon)', resignation);
    line('Die 1 (0=unset,1..6)', die1);
    line('Die 2 (0=unset,1..6)', die2);
    line('Match length (0=money)', matchLen);
    line('Score P1', scoreP1);
    line('Score P2', scoreP2);

    const cubeVal = 1 << cubeExp.v;
    const cubeOwnerText = cubeOwner.v === 0 ? 'P1' : (cubeOwner.v === 1 ? 'P2' : 'center');
    const rollerText = roller.v === 0 ? 'P1' : 'P2';

    console.log('Derived:');
    console.log(`  cube=${cubeVal}, owner=${cubeOwnerText}, roller=${rollerText}`);
    console.log(`  dice=${die1.v || '-'} ${die2.v || '-'}`);
    console.log(`  matchLen=${matchLen.v}, score=${scoreP1.v}-${scoreP2.v}`);
}

function main() {
    const arg = process.argv[2];
    if (!arg) {
        console.error('Usage: node scripts/inspect-gnuid.js <PositionID[:MatchID]>');
        process.exit(1);
    }
    const [posId, matchId] = arg.split(':');
    if (posId) printPositionId(posId);
    if (matchId) printMatchId(matchId);
}

main();


