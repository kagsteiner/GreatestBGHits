'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NOTICE_FILE = path.resolve(__dirname, '..', 'admin-notice.txt');
const REFRESH_INTERVAL_MS = 5000;
const MAX_NOTICE_CHARS = 1000;

let cache = {
    checkedAtMs: 0,
    exists: false,
    mtimeMs: 0,
    notice: null
};
let lastErrorSig = '';

function hashText(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeNoticeText(rawText) {
    if (typeof rawText !== 'string') return '';
    const trimmed = rawText.trim();
    if (!trimmed) return '';
    if (trimmed.length > MAX_NOTICE_CHARS) {
        return trimmed.slice(0, MAX_NOTICE_CHARS);
    }
    return trimmed;
}

function readNoticeFromDisk() {
    const now = Date.now();
    if (now - cache.checkedAtMs < REFRESH_INTERVAL_MS) {
        return cache.notice;
    }
    cache.checkedAtMs = now;

    let stats;
    try {
        stats = fs.statSync(NOTICE_FILE);
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            cache = { checkedAtMs: now, exists: false, mtimeMs: 0, notice: null };
            return null;
        }
        const sig = `stat:${error && error.code ? error.code : 'UNKNOWN'}`;
        if (sig !== lastErrorSig) {
            // eslint-disable-next-line no-console
            console.warn('[adminNotice] Failed to stat notice file:', error.message);
            lastErrorSig = sig;
        }
        return cache.notice;
    }

    if (!stats.isFile()) {
        cache = { checkedAtMs: now, exists: false, mtimeMs: 0, notice: null };
        return null;
    }

    if (cache.exists && cache.mtimeMs === stats.mtimeMs) {
        return cache.notice;
    }

    try {
        const raw = fs.readFileSync(NOTICE_FILE, 'utf8');
        const text = normalizeNoticeText(raw);
        const notice = text ? { text, hash: hashText(text) } : null;
        cache = {
            checkedAtMs: now,
            exists: true,
            mtimeMs: stats.mtimeMs,
            notice
        };
        lastErrorSig = '';
        return notice;
    } catch (error) {
        const sig = `read:${error && error.code ? error.code : 'UNKNOWN'}`;
        if (sig !== lastErrorSig) {
            // eslint-disable-next-line no-console
            console.warn('[adminNotice] Failed to read notice file:', error.message);
            lastErrorSig = sig;
        }
        return cache.notice;
    }
}

function getActiveAdminNotice() {
    return readNoticeFromDisk();
}

module.exports = {
    getActiveAdminNotice
};

