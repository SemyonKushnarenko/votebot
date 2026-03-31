import { listKnownGroups } from './chats.js';
import { clearSession, loadSession, saveSession } from './state.js';
import { escapeHtml, fmtMoney } from './format.js';
import { nowMs } from './db.js';
import { attendanceKeyboard } from './participants.js';
import { refreshMessage } from './scheduler.js';
import { config } from './config.js';
import { logger } from './logger.js';

const Steps = {
  pickGroup: 'pickGroup',
  enterPrice: 'enterPrice',
  enterText: 'enterText',
  preview: 'preview'
};

function backStep(step) {
  switch (step) {
    case Steps.enterPrice:
      return Steps.pickGroup;
    case Steps.enterText:
      return Steps.enterPrice;
    case Steps.preview:
      return Steps.enterText;
    default:
      return Steps.pickGroup;
  }
}

export async function startNewWizard({ db, bot, from, chat }) {
  // Wizard is per-user; keep the chat where wizard is running to avoid cross-chat confusion.
  const data = { wizardChatId: chat.id };
  saveSession(db, from.id, Steps.pickGroup, data);
  await showGroupPicker({ db, bot, from, chat, data });
}

export async function handleWizardText({ db, bot, msg }) {
  const from = msg.from;
  if (!from) return;
  const sess = loadSession(db, from.id);
  if (!sess) return;
  if (sess.data?.wizardChatId && sess.data.wizardChatId !== msg.chat.id) return;

  const text = (msg.text || '').trim();
  if (!text) return;

  switch (sess.step) {
    case Steps.enterPrice: {
      const price = Number(String(text).replace(/\s+/g, '').replace(',', '.'));
      if (!Number.isFinite(price) || price <= 0) {
        await bot.sendMessage(msg.chat.id, 'Введите цену числом (например, 1200).', { reply_markup: backKb() });
        return;
      }
      // Цена по ТЗ "числовая", для простоты храним в целых (рублях).
      const next = { ...sess.data, price: Math.round(price) };
      saveSession(db, from.id, Steps.enterText, next);
      await askText({ bot, chatId: msg.chat.id });
      return;
    }
    case Steps.enterText: {
      const next = { ...sess.data, text };
      saveSession(db, from.id, Steps.preview, next);
      await showPreview({ db, bot, from, chatId: msg.chat.id, data: next });
      return;
    }
    default:
      // If user types while on pickGroup/preview, ignore with gentle hint.
      return;
  }
}

export async function handleWizardCallback({ db, bot, query }) {
  const from = query.from;
  const msg = query.message;
  if (!from || !msg) return;

  const sess = loadSession(db, from.id);
  if (!sess) return;
  if (sess.data?.wizardChatId && sess.data.wizardChatId !== msg.chat.id) return;

  const dataStr = query.data || '';
  if (!dataStr.startsWith('new:')) return;

  const parts = dataStr.split(':');
  const action = parts[1];

  try {
    if (action === 'back') {
      const prev = backStep(sess.step);
      saveSession(db, from.id, prev, sess.data);
      await renderStep({ db, bot, from, chatId: msg.chat.id, step: prev, data: sess.data });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (action === 'cancel') {
      clearSession(db, from.id);
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: msg.chat.id, message_id: msg.message_id }).catch(
        () => {}
      );
      await bot.sendMessage(msg.chat.id, 'Ок, отменил создание сообщения.');
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (action === 'group') {
      const chatId = Number(parts[2]);
      if (!Number.isFinite(chatId)) {
        await bot.answerCallbackQuery(query.id, { text: 'Некорректная группа.' });
        return;
      }

      const ok = await isGroupAdmin({ bot, userId: from.id, chatId });
      if (!ok) {
        await bot.answerCallbackQuery(query.id, { text: 'Нет прав администратора или владельца в этой группе.' });
        return;
      }

      const known = listKnownGroups(db).find((g) => g.chat_id === chatId);
      const next = { ...sess.data, targetChatId: chatId, targetChatTitle: known?.title || String(chatId) };
      saveSession(db, from.id, Steps.enterPrice, next);
      await askPrice({ bot, chatId: msg.chat.id });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (action === 'send') {
      const d = sess.data || {};
      if (!d.targetChatId || !d.price || !d.text) {
        await bot.answerCallbackQuery(query.id, { text: 'Не хватает данных для отправки.' });
        return;
      }

      const ok = await canUseNew({ bot, userId: from.id, chatId: d.targetChatId });
      if (!ok) {
        await bot.answerCallbackQuery(query.id, { text: 'Нет доступа (админ-права).' });
        return;
      }

      const now = nowMs();
      const res = db
        .prepare(
          `
          INSERT INTO scheduled_messages(chat_id, created_by, send_at, price, text, status, created_at, sent_at)
          VALUES(?, ?, ?, ?, ?, 'sent', ?, ?)
        `
        )
        .run(d.targetChatId, from.id, now, d.price, d.text, now, now);

      const scheduledMessageId = Number(res.lastInsertRowid);
      const sent = await bot.sendMessage(d.targetChatId, d.text, {
        parse_mode: 'HTML',
        reply_markup: attendanceKeyboard(scheduledMessageId),
        disable_web_page_preview: true
      });
      db.prepare('UPDATE scheduled_messages SET tg_message_id=? WHERE id=?').run(sent.message_id, scheduledMessageId);

      await refreshMessage({ db, bot, scheduledMessageId });

      await replacePinnedAttendanceMessage({
        db,
        bot,
        chatId: d.targetChatId,
        newMessageId: sent.message_id,
        scheduledMessageId
      });

      clearSession(db, from.id);
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: msg.chat.id, message_id: msg.message_id }).catch(
        () => {}
      );
      await bot.sendMessage(
        msg.chat.id,
        `Отправлено ✅\n\nГруппа: ${d.targetChatTitle}\nЦена: ${fmtMoney(d.price)}`
      );
      await bot.answerCallbackQuery(query.id);
      return;
    }
  } catch (e) {
    await bot.answerCallbackQuery(query.id, { text: 'Ошибка. Попробуйте ещё раз.' }).catch(() => {});
    throw e;
  }
}

export async function renderStep({ db, bot, from, chatId, step, data }) {
  switch (step) {
    case Steps.pickGroup:
      await showGroupPicker({ db, bot, from, chat: { id: chatId }, data });
      return;
    case Steps.enterPrice:
      await askPrice({ bot, chatId });
      return;
    case Steps.enterText:
      await askText({ bot, chatId });
      return;
    case Steps.preview:
      await showPreview({ db, bot, from, chatId, data });
      return;
    default:
      await showGroupPicker({ db, bot, from, chat: { id: chatId }, data });
  }
}

async function showGroupPicker({ db, bot, from, chat, data }) {
  const groups = listKnownGroups(db);
  const rows = [];

  for (const g of groups) {
    // Only those where BOTH user and bot are admins/owners (best-effort).
    const okUser = await isGroupAdmin({ bot, userId: from.id, chatId: g.chat_id }).catch(() => false);
    if (!okUser) continue;
    const okBot = await isBotAdmin({ bot, chatId: g.chat_id }).catch(() => false);
    if (!okBot) continue;
    rows.push([{ text: g.title, callback_data: `new:group:${g.chat_id}` }]);
  }

  if (rows.length === 0) {
    await bot.sendMessage(
      chat.id,
      'Я не вижу групп, где вы и бот являетесь администратором/владельцем, или бот ещё не добавлен в вашу группу.\n\nДобавьте бота в нужную группу, дайте права на отправку, редактирование и закрепление сообщений, затем повторите /new.'
    );
    return;
  }

  await bot.sendMessage(chat.id, 'Выберите группу для отправки:', {
    reply_markup: { inline_keyboard: rows }
  });
}

async function askPrice({ bot, chatId }) {
  await bot.sendMessage(chatId, 'Введите цену числом (например, 1200):', { reply_markup: backKb() });
}

async function askText({ bot, chatId }) {
  await bot.sendMessage(chatId, 'Введите текст сообщения:', { reply_markup: backKb() });
}

async function showPreview({ db, bot, from, chatId, data }) {
  const html = [
    '<b>Предпросмотр</b>',
    '',
    `<b>Группа</b>: ${escapeHtml(data.targetChatTitle || '—')}`,
    `<b>Цена</b>: ${escapeHtml(fmtMoney(data.price || '—'))}`,
    '',
    '<b>Текст</b>:',
    escapeHtml(data.text || '—')
  ].join('\n');

  const ok = data.targetChatId ? await canUseNew({ bot, userId: from.id, chatId: data.targetChatId }) : false;
  const keyboard = {
    inline_keyboard: [
      [{ text: '⬅️ Назад', callback_data: 'new:back' }],
      [
        { text: ok ? '📩 Отправить' : '📩 Отправить (нет прав)', callback_data: ok ? 'new:send' : 'new:noop' },
        { text: '✖️ Отмена', callback_data: 'new:cancel' }
      ]
    ]
  };

  await bot.sendMessage(chatId, html, { parse_mode: 'HTML', reply_markup: keyboard });
}

function backKb() {
  return {
    inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'new:back' }], [{ text: '✖️ Отмена', callback_data: 'new:cancel' }]]
  };
}

export async function canUseNew({ bot, userId, chatId }) {
  if (config.superadmins.size > 0 && config.superadmins.has(userId)) return true;
  return await isGroupAdmin({ bot, userId, chatId });
}

async function isGroupAdmin({ bot, userId, chatId }) {
  const member = await bot.getChatMember(chatId, userId);
  return member && (member.status === 'administrator' || member.status === 'creator');
}

let cachedMe = null;
async function getMe(bot) {
  if (cachedMe) return cachedMe;
  cachedMe = await bot.getMe();
  return cachedMe;
}

async function isBotAdmin({ bot, chatId }) {
  const me = await getMe(bot);
  const member = await bot.getChatMember(chatId, me.id);
  return member && (member.status === 'administrator' || member.status === 'creator');
}

/** Снимает закрепление с предыдущего «объявления» бота в этом чате и закрепляет новое. */
async function replacePinnedAttendanceMessage({ db, bot, chatId, newMessageId, scheduledMessageId }) {
  try {
    const prev = db
      .prepare(
        `
        SELECT tg_message_id
        FROM scheduled_messages
        WHERE chat_id = ? AND status = 'sent' AND tg_message_id IS NOT NULL AND id != ?
        ORDER BY sent_at DESC, id DESC
        LIMIT 1
      `
      )
      .get(chatId, scheduledMessageId);

    if (prev?.tg_message_id && prev.tg_message_id !== newMessageId) {
      await bot.unpinChatMessage(chatId, prev.tg_message_id).catch(() => {});
    }

    await bot.pinChatMessage(chatId, newMessageId, { disable_notification: true });
  } catch (err) {
    logger.warn({ err, chatId, newMessageId }, 'pin/unpin failed');
  }
}

