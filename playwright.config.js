'use strict';

const { defineConfig } = require('@playwright/test');

const PORT = 3055;

// The pages in real browsers, against a server with its own throwaway data
// (scripts/e2e-server.js). Chromium stands for Android and desktop, WebKit for
// iPhone and iPad. Tests that change the shared friend table run one at a time.
module.exports = defineConfig({
    testDir: './e2e',
    workers: 1,
    timeout: 30000,
    outputDir: 'test-results',
    reporter: [['list']],
    use: { baseURL: `http://localhost:${PORT}` },
    webServer: {
        command: 'node scripts/e2e-server.js',
        url: `http://localhost:${PORT}/health`,
        reuseExistingServer: false,
        // So that it removes its throwaway data.
        gracefulShutdown: { signal: 'SIGTERM', timeout: 2000 },
        env: { PORT: String(PORT) }
    },
    projects: [
        { name: 'chromium', use: { browserName: 'chromium' } },
        { name: 'webkit', use: { browserName: 'webkit' } }
    ]
});
