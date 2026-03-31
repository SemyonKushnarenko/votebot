import { nowMs } from './db.js';

export function upsertChat(db, chat) {
  if (!chat || chat.id === undefined) return;
  const title = chat.title || chat.username || String(chat.id);
  const type = chat.type || 'unknown';
  db.prepare(
    `
    INSERT INTO chats(chat_id, title, type, last_seen_at, is_active)
    VALUES(?, ?, ?, ?, 1)
    ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title, type=excluded.type, last_seen_at=excluded.last_seen_at, is_active=1
  `
  ).run(chat.id, title, type, nowMs());
}

export function setChatActive(db, chatId, isActive) {
  if (chatId === undefined || chatId === null) return;
  const v = isActive ? 1 : 0;
  db.prepare('UPDATE chats SET is_active = ?, last_seen_at = ? WHERE chat_id = ?').run(v, nowMs(), chatId);
}

export function listKnownGroups(db) {
  return db
    .prepare("SELECT chat_id, title, type FROM chats WHERE is_active = 1 AND type IN ('group','supergroup') ORDER BY title")
    .all();
}

