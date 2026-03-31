import TelegramBot from 'node-telegram-bot-api';
import { logger } from './logger.js';

function isDuplicatePollingConflict(err) {
  const code = err?.response?.body?.error_code;
  const desc = String(err?.response?.body?.description || err?.message || '');
  return code === 409 || desc.includes('other getUpdates request');
}

/**
 * Polling starts only after dropping Telegram's pending update queue, so restarts
 * do not replay old messages/callbacks that arrived while the bot was offline.
 */
export async function createBot(token) {
  const bot = new TelegramBot(token, {
    polling: { autoStart: false }
  });

  bot.on('polling_error', (err) => {
    if (isDuplicatePollingConflict(err)) {
      // Operational: second Node/npm process with the same token. Do not log full err (token in request URL).
      logger.debug('polling skipped: another getUpdates is active for this bot token');
      return;
    }
    logger.error({ err }, 'polling_error');
  });
  bot.on('webhook_error', (err) => logger.error({ err }, 'webhook_error'));

  await bot.deleteWebHook({ drop_pending_updates: true });
  bot.startPolling();

  return bot;
}

