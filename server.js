'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');
const runGnuBgAnalysis = require('./src/gnubgRunner');
const {
    getNextQuiz,
    getQuizById,
    loadQuizzes,
    saveQuizzes,
    addQuizzesAndSave
} = require('./src/gameCore');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Healthcheck
app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});

// POST /analyzePositionFromMatch
// Body: { matchId: string, positionId?: string, positionIndex?: number, dice?: { die1: number, die2: number } }
app.post('/analyzePositionFromMatch', async (req, res) => {
    try {
        const { matchId, positionId, positionIndex, dice } = req.body || {};

        if (!matchId || typeof matchId !== 'string') {
            return res.status(400).json({ error: 'matchId (string) is required' });
        }

        const result = await runGnuBgAnalysis({ matchId, positionId, positionIndex, dice });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /getQuiz - retrieve the JSON of the next quiz
app.get('/getQuiz', async (_req, res) => {
    try {
        const quiz = await getNextQuiz();
        if (!quiz) return res.status(204).end();
        res.json(quiz);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /getQuiz/:id - retrieve a quiz by its ID
app.get('/getQuiz/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!id || typeof id !== 'string') {
            return res.status(400).json({ error: 'id (string) is required' });
        }
        const quiz = await getQuizById(id);
        if (!quiz) return res.status(404).json({ error: 'quiz not found' });
        res.json(quiz);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /updateQuiz - update quiz counters
// Body: { id: string, wasCorrect?: boolean }
app.post('/updateQuiz', async (req, res) => {
    try {
        const { id, wasCorrect } = req.body || {};
        const isCorrect = Boolean(wasCorrect);
        if (!id || typeof id !== 'string') {
            return res.status(400).json({ error: 'id (string) is required' });
        }
        const quizzes = await loadQuizzes();
        const idx = (quizzes.positions || []).findIndex((p) => p && p.id === id);
        if (idx < 0) {
            return res.status(404).json({ error: 'quiz not found' });
        }
        const p = quizzes.positions[idx];
        p.quiz = p.quiz || { playCount: 0, correctAnswers: 0 };
        p.quiz.playCount = (Number(p.quiz.playCount) || 0) + 1;
        if (isCorrect) {
            p.quiz.correctAnswers = (Number(p.quiz.correctAnswers) || 0) + 1;
        }
        await saveQuizzes(quizzes);
        res.json(p);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /addLastMatchesAndSave - retrieve last matches, analyze and save
app.post('/addLastMatchesAndSave', async (_req, res) => {
    try {
        const result = await addQuizzesAndSave();
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// SSE: GET /addLastMatchesAndSave/stream - trigger long-running add with live progress
app.get('/addLastMatchesAndSave/stream', async (req, res) => {
    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    let closed = false;
    req.on('close', () => {
        closed = true;
        try { res.end(); } catch (_) { }
    });

    const send = (event, data) => {
        if (closed) return;
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const result = await addQuizzesAndSave({
            onProgress: (p) => send('progress', p)
        });
        send('done', result);
        res.end();
    } catch (error) {
        send('error', { error: error.message });
        res.end();
    }
});

app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Server listening on http://localhost:${PORT}`);
});


