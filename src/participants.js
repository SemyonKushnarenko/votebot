import { escapeHtml, fmtMoney } from './format.js';
import { nowMs } from './db.js';

export function scheduledMessageExists(db, scheduledMessageId) {
  const row = db.prepare('SELECT 1 AS ok FROM scheduled_messages WHERE id = ?').get(scheduledMessageId);
  return Boolean(row);
}

/** @returns {boolean} false if parent row is missing (stale button / other DB) */
export function setParticipantStatus(db, scheduledMessageId, user, status) {
  if (!scheduledMessageExists(db, scheduledMessageId)) return false;

  const username = user.username ? String(user.username) : null;
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || username || String(user.id);
  db.prepare(
    `
    INSERT INTO message_participants(scheduled_message_id, user_id, username, display_name, status, updated_at)
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(scheduled_message_id, user_id)
    DO UPDATE SET username=excluded.username, display_name=excluded.display_name, status=excluded.status, updated_at=excluded.updated_at
  `
  ).run(scheduledMessageId, user.id, username, displayName, status, nowMs());
  return true;
}

export function getMessageSnapshot(db, scheduledMessageId) {
  const msg = db
    .prepare(
      `
      SELECT id, chat_id, send_at, price, text, status, tg_message_id
      FROM scheduled_messages
      WHERE id = ?
    `
    )
    .get(scheduledMessageId);

  if (!msg) return null;

  const participants = db
    .prepare(
      `
      SELECT user_id, username, display_name, status
      FROM message_participants
      WHERE scheduled_message_id = ?
      ORDER BY updated_at DESC
    `
    )
    .all(scheduledMessageId);

  const yes = participants.filter((p) => p.status === 'yes');
  const half = participants.filter((p) => p.status === 'half');

  const yesCount = yes.length;
  const avg = yesCount > 0 ? msg.price / yesCount : null;

  return {
    msg,
    yes,
    half,
    halfCount: half.length,
    yesCount,
    avg
  };
}

export function renderGroupMessageHtml(snapshot) {
  const base = escapeHtml(snapshot.msg.text);
  const lines = [];

  lines.push(base);
  lines.push('');

  lines.push(`<b>Буду (${snapshot.yesCount})</b>`);
  if (snapshot.yesCount === 0) {
    lines.push('—');
  } else {
    for (const p of snapshot.yes) {
      const name = escapeHtml(p.display_name);
      const uname = p.username ? ` (@${escapeHtml(p.username)})` : '';
      lines.push(`- ${name}${uname}`);
    }
  }

  lines.push('');
  lines.push(`<b>50/50 (${snapshot.halfCount})</b>`);
  if (snapshot.halfCount === 0) {
    lines.push('—');
  } else {
    for (const p of snapshot.half) {
      const name = escapeHtml(p.display_name);
      const uname = p.username ? ` (@${escapeHtml(p.username)})` : '';
      lines.push(`- ${name}${uname}`);
    }
  }

  lines.push('');
  lines.push(
    `<b>Средняя цена</b>: ${snapshot.avg === null ? '—' : fmtMoney(Math.ceil(snapshot.avg))}`
  );

  return lines.join('\n');
}

export function attendanceKeyboard(scheduledMessageId) {
  return {
    inline_keyboard: [
      [
        { text: '50 на 50', callback_data: `att:${scheduledMessageId}:half` },
        { text: 'Буду', callback_data: `att:${scheduledMessageId}:yes` },
        { text: 'Не буду', callback_data: `att:${scheduledMessageId}:no` }
      ]
    ]
  };
}

