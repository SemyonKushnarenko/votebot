import TelegramBot from 'node-telegram-bot-api';
import { logger } from './logger.js';

function isDuplicatePollingConflict(err) {
  const code = err?.response?.body?.error_code;
  const desc = String(err?.response?.body?.description || err?.message || '');
  return code === 409 || desc.includes('other getUpdates request');
}

/**
 * Starts Telegram bot either in webhook mode (preferred on servers) or polling mode.
 * In both modes, we drop pending updates on startup to avoid replay.
 */
export async function createBot({ token, webhookUrl }) {
  const bot = new TelegramBot(token, { polling: false });

  bot.on('polling_error', (err) => {
    if (isDuplicatePollingConflict(err)) {
      // Operational: second Node/npm process with the same token. Do not log full err (token in request URL).
      logger.debug('polling skipped: another getUpdates is active for this bot token');
      return;
    }
    logger.error({ err }, 'polling_error');
  });
  bot.on('webhook_error', (err) => logger.error({ err }, 'webhook_error'));

  const url = String(webhookUrl || '').trim();
  if (url) {
    await bot.setWebHook(url, { drop_pending_updates: true });
    logger.info({ webhookUrl: url }, 'Webhook enabled');
  } else {
    await bot.deleteWebHook({ drop_pending_updates: true });
    bot.startPolling();
    logger.info('Polling enabled');
  }

  return bot;
}

