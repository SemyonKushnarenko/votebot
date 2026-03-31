import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { logger } from './logger.js';

export function openDb() {
  const abs = path.resolve(process.cwd(), config.dbPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const db = new Database(abs);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrate(db);
  logger.info({ dbPath: abs }, 'SQLite opened');
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      chat_id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_seen_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      created_by INTEGER NOT NULL,
      send_at INTEGER NOT NULL,
      price INTEGER NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','scheduled','sent','cancelled','failed')) DEFAULT 'scheduled',
      tg_message_id INTEGER,
      created_at INTEGER NOT NULL,
      sent_at INTEGER,
      last_error TEXT,
      FOREIGN KEY(chat_id) REFERENCES chats(chat_id)
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due
      ON scheduled_messages(status, send_at);

    CREATE TABLE IF NOT EXISTS message_participants (
      scheduled_message_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      username TEXT,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('half','yes','no')),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(scheduled_message_id, user_id),
      FOREIGN KEY(scheduled_message_id) REFERENCES scheduled_messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      user_id INTEGER PRIMARY KEY,
      step TEXT NOT NULL,
      data_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

export function nowMs() {
  return Date.now();
}

