import { logger } from './logger.js';
import { Bot } from 'grammy';

function isDuplicatePollingConflict(err) {
  const desc = String(err?.message || err?.description || '');
  return desc.includes('409') || desc.includes('Conflict') || desc.includes('other getUpdates request');
}

/**
 * Polling starts only after dropping Telegram's pending update queue, so restarts
 * do not replay old messages/callbacks that arrived while the bot was offline.
 */
export async function createBot(input) {
  const token = typeof input === 'string' ? input : input?.token;
  const webhookUrl = typeof input === 'string' ? null : input?.webhookUrl;

  if (!token) throw new Error('createBot: token is required');

  const grammyBot = new Bot(token);

  // --- Minimal compatibility wrapper with node-telegram-bot-api ---
  const handlerByEvent = new Map();

  function emit(event, payload) {
    const handlers = handlerByEvent.get(event);
    if (!handlers) return;
    for (const fn of handlers) fn(payload);
  }

  grammyBot.on('my_chat_member', (ctx) => emit('my_chat_member', ctx.update.my_chat_member));
  grammyBot.on('chat_member', (ctx) => emit('chat_member', ctx.update.chat_member));
  grammyBot.on('message', (ctx) => emit('message', ctx.message));
  grammyBot.on('callback_query:data', (ctx) => emit('callback_query', ctx.callbackQuery));

  grammyBot.catch((err) => {
    const e = err?.error || err;
    if (isDuplicatePollingConflict(e)) {
      logger.debug('polling skipped: another getUpdates is active for this bot token');
      return;
    }
    logger.error({ err: e }, 'telegram_error');
  });

  const bot = {
    on(event, handler) {
      if (!handlerByEvent.has(event)) handlerByEvent.set(event, []);
      handlerByEvent.get(event).push(handler);
    },

    // API surface used by this repo
    getMe: () => grammyBot.api.getMe(),
    sendMessage: (chatId, text, options) => grammyBot.api.sendMessage(chatId, text, options),
    editMessageText: (text, options) => {
      const chatId = options?.chat_id;
      const messageId = options?.message_id;
      if (!chatId || !messageId) throw new Error('editMessageText: chat_id and message_id are required');

      const { chat_id: _chatId, message_id: _messageId, ...rest } = options || {};
      return grammyBot.api.editMessageText(chatId, messageId, text, rest);
    },
    editMessageReplyMarkup: (replyMarkup, options) => {
      // node-telegram-bot-api style: editMessageReplyMarkup(replyMarkup, { chat_id, message_id })
      const chatId = options?.chat_id;
      const messageId = options?.message_id;
      if (!chatId || !messageId) throw new Error('editMessageReplyMarkup: chat_id and message_id are required');
      return grammyBot.api.editMessageReplyMarkup(chatId, messageId, replyMarkup);
    },
    answerCallbackQuery: (callbackQueryId, options) => grammyBot.api.answerCallbackQuery(callbackQueryId, options),
    getChatMember: (chatId, userId) => grammyBot.api.getChatMember(chatId, userId),
    getChatAdministrators: (chatId) => grammyBot.api.getChatAdministrators(chatId),
    setMyCommands: (commands, options) => grammyBot.api.setMyCommands(commands, options),
    pinChatMessage: (chatId, messageId, options) => grammyBot.api.pinChatMessage(chatId, messageId, options),
    unpinChatMessage: (chatId, messageId) =>
      typeof messageId === 'number' || typeof messageId === 'string'
        ? grammyBot.api.unpinChatMessage(chatId, { message_id: messageId })
        : grammyBot.api.unpinChatMessage(chatId),

    // Webhook helpers for firebase.js
    processUpdate: (update) => grammyBot.handleUpdate(update),

    // Setup
    deleteWebHook: (options) => grammyBot.api.deleteWebhook(options),
    setWebHook: (url, options) => grammyBot.api.setWebhook(url, options),
    startPolling: (options) => grammyBot.start(options),
    stopPolling: () => grammyBot.stop()
  };

  // Ensure we don't replay queued updates on restart.
  if (webhookUrl) {
    await bot.setWebHook(webhookUrl, { drop_pending_updates: true });
  } else {
    await bot.deleteWebHook({ drop_pending_updates: true });
    bot.startPolling();
  }

  return bot;
}

