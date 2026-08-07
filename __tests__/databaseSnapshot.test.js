'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createSnapshot } = require('../scripts/snapshot-database');

describe('database snapshot', () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'secondroll-snapshot-test-'));
    const sourcePath = path.join(temporaryDirectory, 'source.db');
    const outputPath = path.join(temporaryDirectory, 'snapshot.db');

    beforeAll(() => {
        const db = new Database(sourcePath);
        db.exec(`
            CREATE TABLE user_data (
                username TEXT PRIMARY KEY,
                quizzes_json TEXT NOT NULL,
                analyzed_matches_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        `);
        db.prepare('INSERT INTO user_data VALUES (?, ?, ?, ?)').run(
            'alice',
            JSON.stringify({ schemaVersion: 2, threshold: 0.08, positions: [] }),
            JSON.stringify({ matches: [] }),
            new Date(0).toISOString()
        );
        db.close();
    });

    afterAll(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

    it('creates and verifies a standalone snapshot', async () => {
        const report = await createSnapshot({ sourcePath, outputPath });
        expect(report).toMatchObject({ sqliteIntegrity: 'ok', users: 1 });
        expect(report.bytes).toBeGreaterThan(0);
        expect(report.sha256).toMatch(/^[a-f0-9]{64}$/);

        const snapshot = new Database(outputPath, { readonly: true });
        expect(snapshot.prepare('SELECT username FROM user_data').get().username).toBe('alice');
        snapshot.close();
    });

    it('refuses to overwrite an existing snapshot', async () => {
        await expect(createSnapshot({ sourcePath, outputPath }))
            .rejects.toThrow('Refusing to overwrite existing snapshot');
    });
});
