'use strict';

function expandCountToken(token) {
    const match = String(token || '').match(/^([^()\s]+)\((\d+)\)$/);
    if (!match) return token ? [token] : [];

    const count = Number(match[2]);
    const base = match[1];
    const hit = base.endsWith('*');
    const plain = hit ? base.slice(0, -1) : base;
    return Array.from({ length: count }, (_, index) => (hit && index === 0 ? base : plain));
}

function normalizePoint(value) {
    const point = String(value || '').toLowerCase();
    if (point === 'bar') return 25;
    if (point === 'off') return 0;
    const parsed = Number(point);
    return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Parse ordinary GNU/Hedgehog move notation into the app's move-part format.
 * Count shorthand such as 8/5(2), bar/off, and hit markers are supported.
 */
function moveNotationToParts(moveText) {
    if (typeof moveText !== 'string' || !moveText.trim()) return [];
    const tokens = moveText.trim().split(/\s+/).flatMap(expandCountToken);
    const parts = [];

    for (const rawToken of tokens) {
        const rawPoints = rawToken.split('/');
        const points = rawPoints.map((point) => normalizePoint(point.replace(/\*/g, '')));
        if (points.length < 2 || points.some((point) => point === null)) continue;

        // A chain such as 24/18/13 is two checker movements.
        for (let index = 0; index < points.length - 1; index++) {
            parts.push({
                from: points[index],
                to: points[index + 1],
                hit: rawPoints[index + 1].includes('*')
            });
        }
    }

    return parts;
}

function partToToken(part) {
    if (!part || !Number.isFinite(part.from) || !Number.isFinite(part.to)) return null;
    const from = Number(part.from) === 25 ? 'bar' : String(Number(part.from));
    const to = Number(part.to) === 0 ? 'off' : String(Number(part.to));
    return `${from}/${to}${part.hit ? '*' : ''}`;
}

/**
 * Produce an order-insensitive signature suitable for matching the played
 * checker move to an engine candidate.
 */
function moveSignature(moveOrParts) {
    const parts = Array.isArray(moveOrParts) ? moveOrParts : moveNotationToParts(moveOrParts);
    return parts.map(partToToken).filter(Boolean).sort().join(' ');
}

module.exports = {
    moveNotationToParts,
    moveSignature
};
