import { logger } from './logger.js';
import { attendanceKeyboard, getMessageSnapshot, renderGroupMessageHtml } from './participants.js';

export async function refreshMessage({ db, bot, scheduledMessageId }) {
  const snap = getMessageSnapshot(db, scheduledMessageId);
  if (!snap) return;
  if (!snap.msg.tg_message_id) return;

  const html = renderGroupMessageHtml(snap);

  try {
    await bot.editMessageText(html, {
      chat_id: snap.msg.chat_id,
      message_id: snap.msg.tg_message_id,
      parse_mode: 'HTML',
      reply_markup: attendanceKeyboard(scheduledMessageId),
      disable_web_page_preview: true
    });
  } catch (err) {
    // Telegram часто возвращает "message is not modified" — это не ошибка.
    const msg = String(err?.response?.body?.description || err?.message || err);
    if (!msg.toLowerCase().includes('message is not modified')) {
      throw err;
    }
  }
}

