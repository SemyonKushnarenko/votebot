import { nowMs } from './db.js';

function displayNameFromUser(user) {
  if (!user) return 'unknown';
  const username = user.username ? String(user.username) : '';
  const dn = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return dn || username || String(user.id ?? 'unknown');
}

function isAdminStatus(status) {
  return status === 'administrator' || status === 'creator';
}

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

export function upsertChatAdminFromMember({ db, chatId, user, memberStatus, isBot = false }) {
  if (!chatId || !user || user.id === undefined) return;
  const username = user.username ? String(user.username) : null;
  const displayName = displayNameFromUser(user);
  const admin = isAdminStatus(memberStatus) ? 1 : 0;
  const status = String(memberStatus || 'unknown');

  db.prepare(
    `
    INSERT INTO chat_admins(chat_id, user_id, username, display_name, member_status, is_admin, is_bot, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, user_id) DO UPDATE SET
      username=excluded.username,
      display_name=excluded.display_name,
      member_status=excluded.member_status,
      is_admin=excluded.is_admin,
      is_bot=excluded.is_bot,
      updated_at=excluded.updated_at
  `
  ).run(chatId, user.id, username, displayName, status, admin, isBot ? 1 : 0, nowMs());
}

export function listGroupsWhereUserAndBotAreAdmins(db, userId, botUserId) {
  return db
    .prepare(
      `
      SELECT c.chat_id, c.title
      FROM chats c
      JOIN chat_admins u
        ON u.chat_id = c.chat_id
       AND u.user_id = ?
       AND u.is_admin = 1
      JOIN chat_admins b
        ON b.chat_id = c.chat_id
       AND b.user_id = ?
       AND b.is_admin = 1
       AND b.is_bot = 1
      WHERE c.is_active = 1 AND c.type IN ('group','supergroup')
      ORDER BY c.title
    `
    )
    .all(userId, botUserId);
}

/**
 * Replace admin list snapshot for a chat (best-effort).
 * Marks all known non-bot users as non-admin, then upserts current admins.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} chatId
 * @param {Array<{ user: any, status: string }>} chatMembersAdmins result of bot.getChatAdministrators()
 * @param {number} botUserId
 */
export function syncChatAdminsSnapshot({ db, chatId, chatMembersAdmins, botUserId }) {
  if (!chatId) return;
  const now = nowMs();

  // Demote everyone we previously knew about (except the bot record).
  db.prepare(
    `
    UPDATE chat_admins
    SET is_admin = 0, member_status = 'member', updated_at = ?
    WHERE chat_id = ? AND is_bot = 0
  `
  ).run(now, chatId);

  // Upsert current admins/owner.
  for (const m of chatMembersAdmins || []) {
    if (!m?.user || m.user.id === undefined) continue;
    upsertChatAdminFromMember({
      db,
      chatId,
      user: m.user,
      memberStatus: m.status,
      isBot: m.user.id === botUserId
    });
  }
}

