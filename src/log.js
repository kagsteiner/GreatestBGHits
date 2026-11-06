'use strict';

function log(message) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    // eslint-disable-next-line no-console
    console.log(`${date} ${time}: ${message}`);
}

module.exports = { log };
