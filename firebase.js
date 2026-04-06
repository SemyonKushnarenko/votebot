import 'dotenv/config';

import express from 'express';
import { onRequest } from 'firebase-functions/v2/https';

import { config } from './src/config.js';
import { logger } from './src/logger.js';
import { getDb } from './src/firestore.js';
import { createBot } from './src/telegram.js';
import { registerBotCommands, renderHelp } from './src/commands.js';
import { setParticipantStatus } from './src/participants.js';
import { refreshMessage } from './src/scheduler.js';
import { canUseNew, handleWizardCallback, handleWizardText, startNewWizard } from './src/adminFlow.js';
import { setChatActive, syncChatAdminsSnapshot, upsertChat, upsertChatAdminFromMember } from './src/chats.js';

let boot = null;

async function getBoot() {
  if (boot) return boot;
  const db = getDb();
  const bot = await createBot({ token: config.botToken, webhookUrl: config.webhookUrl });
  const me = await bot.getMe();

  const lastAdminsSyncByChat = new Map();
  const ADMINS_SYNC_COOLDOWN_MS = 2 * 60 * 1000;

  // Track chats even if nobody writes messages (e.g. bot added to a group).
  bot.on('my_chat_member', (update) => {
    try {
      const chat = update?.chat;
      if (!chat) return;
      void upsertChat(db, chat).catch((err) => logger.error({ err }, 'upsertChat failed'));

      const newStatus = update?.new_chat_member?.status;
      if (newStatus === 'kicked' || newStatus === 'left') {
        void setChatActive(db, chat.id, false).catch((err) => logger.error({ err }, 'setChatActive failed'));
      }

      if (update?.new_chat_member?.user) {
        void upsertChatAdminFromMember({
          db,
          chatId: chat.id,
          user: update.new_chat_member.user,
          memberStatus: update.new_chat_member.status,
          isBot: true
        }).catch((err) => logger.error({ err }, 'upsertChatAdminFromMember failed'));
      }
    } catch (err) {
      logger.error({ err }, 'my_chat_member handler error');
    }
  });

  bot.on('chat_member', (update) => {
    try {
      const chat = update?.chat;
      if (!chat) return;
      void upsertChat(db, chat).catch((err) => logger.error({ err }, 'upsertChat failed'));

      const newMember = update?.new_chat_member;
      if (!newMember?.user) return;

      void upsertChatAdminFromMember({
        db,
        chatId: chat.id,
        user: newMember.user,
        memberStatus: newMember.status,
        isBot: newMember.user.id === me.id
      }).catch((err) => logger.error({ err }, 'upsertChatAdminFromMember failed'));
    } catch (err) {
      logger.error({ err }, 'chat_member handler error');
    }
  });

  bot.on('message', async (msg) => {
    try {
      if (msg.chat) void upsertChat(db, msg.chat).catch((err) => logger.error({ err }, 'upsertChat failed'));

      if ((msg.chat?.type === 'group' || msg.chat?.type === 'supergroup') && msg.from?.id) {
        const member = await bot.getChatMember(msg.chat.id, msg.from.id).catch(() => null);
        if (member?.user) {
          void upsertChatAdminFromMember({
            db,
            chatId: msg.chat.id,
            user: member.user,
            memberStatus: member.status,
            isBot: member.user.id === me.id
          }).catch((err) => logger.error({ err }, 'upsertChatAdminFromMember failed'));
        }

        const last = lastAdminsSyncByChat.get(msg.chat.id) || 0;
        const now = Date.now();
        if (now - last >= ADMINS_SYNC_COOLDOWN_MS) {
          lastAdminsSyncByChat.set(msg.chat.id, now);
          const admins = await bot.getChatAdministrators(msg.chat.id).catch(() => null);
          if (admins) {
            void syncChatAdminsSnapshot({ db, chatId: msg.chat.id, chatMembersAdmins: admins, botUserId: me.id }).catch((err) =>
              logger.error({ err }, 'syncChatAdminsSnapshot failed')
            );
          }
        }
      }

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
      if (data.startsWith('new:')) {
        await handleWizardCallback({ db, bot, query });
        return;
      }

      if (data.startsWith('att:')) {
        const parts = data.split(':');
        const scheduledMessageId = String(parts[1] || '');
        const status = parts[2];
        if (!scheduledMessageId || !['half', 'yes', 'no'].includes(status)) {
          await bot.answerCallbackQuery(query.id, { text: 'Некорректная кнопка.' }).catch(() => {});
          return;
        }

        const applied = await setParticipantStatus(db, scheduledMessageId, query.from, status);
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

  registerBotCommands(bot).catch((err) => logger.error({ err }, 'setMyCommands failed'));

  boot = { db, bot };
  logger.info('Bot booted (firebase)');
  return boot;
}

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/healthz', (_req, res) => res.status(200).type('text').send('ok'));
app.get('/', (_req, res) => res.status(200).type('text').send('football-bot'));

app.post('/telegram/webhook', async (req, res) => {
  try {
    const { bot } = await getBoot();
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    logger.error({ err }, 'webhook processUpdate failed');
    res.sendStatus(500);
  }
});

export const api = onRequest({ region: 'europe-west1' }, app);

