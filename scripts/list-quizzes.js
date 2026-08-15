#!/usr/bin/env node
'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'app.db');

const db = new Database(DB_PATH, { readonly: true });
const rows = db.prepare('SELECT username, quizzes_json FROM user_data').all();

console.log('Quizzes in database:\n');
console.log('username | id | type | playCount | correctAnswers | best decision');
console.log('-'.repeat(80));

for (const row of rows) {
  let quizzes;
  try {
    quizzes = JSON.parse(row.quizzes_json);
  } catch {
    console.log(`${row.username} | (parse error)`);
    continue;
  }
  const positions = Array.isArray(quizzes?.positions) ? quizzes.positions : [];
  for (const pos of positions) {
    const id = pos?.id ?? '(no id)';
    const quiz = pos?.quiz || {};
    const playCount = quiz.playCount ?? '—';
    const correctAnswers = quiz.correctAnswers ?? '—';
    const type = pos?.type ?? 'move';
    const best = pos?.best?.move ?? pos?.best?.label ?? pos?.best?.action ?? '—';
    console.log(`${row.username} | ${id} | ${type} | ${playCount} | ${correctAnswers} | ${best}`);
  }
  if (positions.length === 0) {
    console.log(`${row.username} | (no quizzes)`);
  }
}

db.close();
console.log('\nDone.');
