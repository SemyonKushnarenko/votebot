import 'dotenv/config';

import express from 'express';

import { config } from './src/config.js';
import { logger } from './src/logger.js';
import { openDb } from './src/db.js';
import { createBot } from './src/telegram.js';
import { setChatActive, syncChatAdminsSnapshot, upsertChat, upsertChatAdminFromMember } from './src/chats.js';
import { canUseNew, handleWizardCallback, handleWizardText, startNewWizard } from './src/adminFlow.js';
import { refreshMessage } from './src/scheduler.js';
import { setParticipantStatus } from './src/participants.js';
import { registerBotCommands, renderHelp } from './src/commands.js';
import { nowMs } from './src/db.js';

async function main() {
  const app = express();

  app.get('/healthz', (_req, res) => res.status(200).type('text').send('ok'));
  app.get('/', (_req, res) => res.status(200).type('text').send('football-bot'));

  app.listen(config.port, () => logger.info({ port: config.port }, 'HTTP server listening'));

  const db = openDb();
  const bot = await createBot(config.botToken);
  const me = await bot.getMe();

  // Per-chat throttling for full admin list sync (Telegram API is rate-limited).
  const lastAdminsSyncByChat = new Map();
  const ADMINS_SYNC_COOLDOWN_MS = 2 * 60 * 1000;

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

      // Track bot's own admin status in this chat.
      if (update?.new_chat_member?.user) {
        upsertChatAdminFromMember({
          db,
          chatId: chat.id,
          user: update.new_chat_member.user,
          memberStatus: update.new_chat_member.status,
          isBot: true
        });
      }
    } catch (err) {
      logger.error({ err }, 'my_chat_member handler error');
    }
  });

  // Track users promoted/demoted (requires bot to receive chat_member updates).
  bot.on('chat_member', (update) => {
    try {
      const chat = update?.chat;
      if (!chat) return;
      upsertChat(db, chat);

      const newMember = update?.new_chat_member;
      if (!newMember?.user) return;

      upsertChatAdminFromMember({
        db,
        chatId: chat.id,
        user: newMember.user,
        memberStatus: newMember.status,
        isBot: newMember.user.id === me.id
      });
    } catch (err) {
      logger.error({ err }, 'chat_member handler error');
    }
  });

  bot.on('message', async (msg) => {
    try {
      if (msg.chat) upsertChat(db, msg.chat);

      // Middleware: keep "common groups + admins" up to date for every group message.
      if ((msg.chat?.type === 'group' || msg.chat?.type === 'supergroup') && msg.from?.id) {
        // 1) Always refresh author role (cheap).
        const member = await bot.getChatMember(msg.chat.id, msg.from.id).catch(() => null);
        if (member?.user) {
          upsertChatAdminFromMember({
            db,
            chatId: msg.chat.id,
            user: member.user,
            memberStatus: member.status,
            isBot: member.user.id === me.id
          });
        }

        // 2) Throttled full snapshot refresh (admins list).
        const last = lastAdminsSyncByChat.get(msg.chat.id) || 0;
        const now = Date.now();
        if (now - last >= ADMINS_SYNC_COOLDOWN_MS) {
          lastAdminsSyncByChat.set(msg.chat.id, now);
          const admins = await bot.getChatAdministrators(msg.chat.id).catch(() => null);
          if (admins) {
            syncChatAdminsSnapshot({ db, chatId: msg.chat.id, chatMembersAdmins: admins, botUserId: me.id });
          }
        }
      }

      if (msg.text && msg.text.startsWith('/help')) {
        await bot.sendMessage(msg.chat.id, renderHelp());
        return;
      }

      if (msg.text && msg.text.startsWith('/edittext')) {
        const text = String(msg.text || '').replace(/^\/edittext(@\w+)?\s*/i, '').trim();
        if (!text) {
          await bot.sendMessage(msg.chat.id, 'Использование: /edittext новый текст');
          return;
        }

        const ok = await canUseNew({ bot, userId: msg.from.id, chatId: msg.chat.id }).catch(() => false);
        if (!ok && (msg.chat.type === 'group' || msg.chat.type === 'supergroup')) {
          await bot.sendMessage(msg.chat.id, 'Команда доступна только администраторам или владельцу группы.');
          return;
        }

        const row = db
          .prepare(
            `
            SELECT id, tg_message_id
            FROM scheduled_messages
            WHERE chat_id = ? AND status = 'sent' AND tg_message_id IS NOT NULL
            ORDER BY sent_at DESC, id DESC
            LIMIT 1
          `
          )
          .get(msg.chat.id);

        if (!row?.id || !row?.tg_message_id) {
          await bot.sendMessage(msg.chat.id, 'Не нашёл последнее отправленное сообщение бота в этой группе.');
          return;
        }

        db.prepare('UPDATE scheduled_messages SET text = ?, created_at = ? WHERE id = ?').run(text, nowMs(), row.id);
        await refreshMessage({ db, bot, scheduledMessageId: row.id });
        await bot.sendMessage(msg.chat.id, 'Обновил текст в последнем сообщении ✅');
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

