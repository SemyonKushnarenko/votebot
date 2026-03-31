import { nowMs } from './db.js';

export function loadSession(db, userId) {
  const row = db
    .prepare('SELECT user_id, step, data_json, updated_at FROM admin_sessions WHERE user_id = ?')
    .get(userId);
  if (!row) return null;
  try {
    return { userId: row.user_id, step: row.step, data: JSON.parse(row.data_json), updatedAt: row.updated_at };
  } catch {
    return { userId: row.user_id, step: row.step, data: {}, updatedAt: row.updated_at };
  }
}

export function saveSession(db, userId, step, data) {
  const stmt = db.prepare(`
    INSERT INTO admin_sessions(user_id, step, data_json, updated_at)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET step=excluded.step, data_json=excluded.data_json, updated_at=excluded.updated_at
  `);
  stmt.run(userId, step, JSON.stringify(data ?? {}), nowMs());
}

export function clearSession(db, userId) {
  db.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(userId);
}

