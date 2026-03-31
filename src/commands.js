import { config } from './config.js';

export async function registerBotCommands(bot) {
  const commands = [
    { command: 'new', description: 'Создать и отправить сообщение' },
    { command: 'help', description: 'Справка по командам' }
  ];

  // Показываем команды в личке и в группах.
  await bot.setMyCommands(commands, { scope: { type: 'default' } });
}

export function renderHelp() {
  return [
    'Команды:',
    '',
    '/new — создать сообщение и отправить в группу (админы/владелец)',
    '/help — справка',
    '',
    'Примечание: чтобы группа появилась в выборе, бот должен быть добавлен в группу и "увидеть" её (любое сообщение).'
  ].join('\n');
}

