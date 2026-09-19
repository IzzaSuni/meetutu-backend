import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type AppDatabase = Database.Database

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  duration INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  parts_count INTEGER NOT NULL DEFAULT 0,
  audio_url TEXT NOT NULL,
  has_transcription INTEGER NOT NULL DEFAULT 0,
  has_summary INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions (created_at DESC);

CREATE TABLE IF NOT EXISTS transcripts (
  session_id INTEGER PRIMARY KEY,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS summaries (
  session_id INTEGER PRIMARY KEY,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis_jobs (
  session_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL,
  error TEXT,
  provider TEXT,
  updated_at TEXT NOT NULL
);
`

/**
 * Opens (and migrates) the SQLite database. The schema is idempotent, so a
 * restart against an existing file keeps every row.
 */
export function openDatabase(path: string): AppDatabase {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }

  const db = new Database(path)
  // WAL lets the analysis job write results while a status poll reads.
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}
