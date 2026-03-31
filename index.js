import 'dotenv/config';

import { config } from './src/config.js';
import { logger } from './src/logger.js';
import { openDb } from './src/db.js';
import { createBot } from './src/telegram.js';
import { setChatActive, upsertChat } from './src/chats.js';
import { canUseNew, handleWizardCallback, handleWizardText, startNewWizard } from './src/adminFlow.js';
import { refreshMessage } from './src/scheduler.js';
import { setParticipantStatus } from './src/participants.js';
import { registerBotCommands, renderHelp } from './src/commands.js';

async function main() {
  const db = openDb();
  const bot = await createBot(config.botToken);

  registerBotCommands(bot).catch((err) => logger.error({ err }, 'setMyCommands failed'));

  // Track chats even if nobody writes messages (e.g. bot added to a group).
  bot.on('my_chat_member', (update) => {
    try {
      const chat = update?.chat;
      if (!chat) return;
      upsertChat(db, chat);

      const newStatus = update?.new_chat_member?.status;
      if (newStatus === 'kicked' || newStatus === 'left') {
        setChatActive(db, chat.id, false);
      }
    } catch (err) {
      logger.error({ err }, 'my_chat_member handler error');
    }
  });

  bot.on('message', async (msg) => {
    try {
      if (msg.chat) upsertChat(db, msg.chat);

      if (msg.text && msg.text.startsWith('/help')) {
        await bot.sendMessage(msg.chat.id, renderHelp());
        return;
      }

      if (msg.text && msg.text.startsWith('/new')) {
        const ok = await canUseNew({ bot, userId: msg.from.id, chatId: msg.chat.id }).catch(() => false);
        if (!ok && (msg.chat.type === 'group' || msg.chat.type === 'supergroup')) {
          await bot.sendMessage(msg.chat.id, 'Команда доступна только администраторам или владельцу группы.');
          return;
        }

        await startNewWizard({ db, bot, from: msg.from, chat: msg.chat });
        return;
      }

      // Wizard text input (price/text)
      if (msg.text) {
        await handleWizardText({ db, bot, msg });
      }
    } catch (err) {
      logger.error({ err }, 'message handler error');
      if (msg?.chat?.id) {
        await bot.sendMessage(msg.chat.id, 'Произошла ошибка. Попробуйте ещё раз позже.').catch(() => {});
      }
    }
  });

  bot.on('callback_query', async (query) => {
    const data = query.data || '';

    try {
      // Wizard callbacks (new:*)
      if (data.startsWith('new:')) {
        await handleWizardCallback({ db, bot, query });
        return;
      }

      // Attendance callbacks: att:<scheduledMessageId>:<half|yes|no>
      if (data.startsWith('att:')) {
        const parts = data.split(':');
        const scheduledMessageId = Number(parts[1]);
        const status = parts[2];
        if (!Number.isFinite(scheduledMessageId) || !['half', 'yes', 'no'].includes(status)) {
          await bot.answerCallbackQuery(query.id, { text: 'Некорректная кнопка.' }).catch(() => {});
          return;
        }

        const applied = setParticipantStatus(db, scheduledMessageId, query.from, status);
        if (!applied) {
          await bot
            .answerCallbackQuery(query.id, {
              text: 'Сообщение устарело или данные недоступны на этом сервере. Отправьте новое через /new.'
            })
            .catch(() => {});
          return;
        }

        await refreshMessage({ db, bot, scheduledMessageId });

        await bot.answerCallbackQuery(query.id, { text: status === 'yes' ? 'Записал ✅' : status === 'half' ? '50/50 ✅' : 'Убрал ✅' }).catch(
          () => {}
        );
        return;
      }

      await bot.answerCallbackQuery(query.id).catch(() => {});
    } catch (err) {
      logger.error({ err, data }, 'callback handler error');
      await bot.answerCallbackQuery(query.id, { text: 'Ошибка. Попробуйте ещё раз.' }).catch(() => {});
    }
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  logger.info('Bot started');
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});

