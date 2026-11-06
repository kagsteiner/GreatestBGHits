'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');
const { addQuizzesAndSave } = require('./src/gameCore');
const CrawlerQueue = require('./src/crawlerQueue');
const { getBridges } = require('./src/engineBridge');
const engineBridgeRoutes = require('./src/routes/engineBridge');
const statusRoutes = require('./src/routes/status');
const { createQuizRoutes } = require('./src/routes/quiz');
const playRoutes = require('./src/routes/play');
const analysisRoutes = require('./src/routes/analysis');
const friendRoutes = require('./src/routes/friend');

const app = express();
const PORT = process.env.PORT || 3033;
const crawlerQueue = new CrawlerQueue(addQuizzesAndSave);
app.locals.crawlerQueue = crawlerQueue;

// The engine in the browser (src/engineBridge.js). Its pages are cross-origin
// isolated, which lets the engine use several threads; they load nothing from
// other sites.
const ENGINE_PAGES = new Set(['/quiz.html', '/play.html', '/friend.html', '/review.html']);
app.use((req, res, next) => {
    if (ENGINE_PAGES.has(req.path) || req.path.startsWith('/engine/')) {
        res.set('Cross-Origin-Opener-Policy', 'same-origin');
        res.set('Cross-Origin-Embedder-Policy', 'require-corp');
    }
    next();
});
app.use(engineBridgeRoutes);
app.use(express.json({ limit: '100kb' }));
// Engine work of these requests runs in the requesting page's browser, if it has
// the engine. After the body parser: its stream callbacks would lose the context.
app.use(['/quizAnalysis', '/legalPlays', '/evaluateMove', '/analysis', '/play', '/friend'], getBridges().middleware());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/shared', express.static(path.join(__dirname, 'shared')));

app.use(statusRoutes);
app.use(createQuizRoutes(crawlerQueue));
app.use(playRoutes);
app.use(analysisRoutes);
app.use(friendRoutes);

if (require.main === module) {
    app.listen(PORT, () => {
        // eslint-disable-next-line no-console
        console.log(`Server listening on http://localhost:${PORT}`);
    });
}

module.exports = app;
