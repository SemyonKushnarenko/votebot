import process from 'node:process';

function getEnv(name, { required = false, fallback = undefined } = {}) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (required) throw new Error(`Missing env ${name}`);
    return fallback;
  }
  return v;
}

export const config = {
  botToken: getEnv('BOT_TOKEN', { required: true }),
  tz: getEnv('TZ', { fallback: 'Europe/Moscow' }),
  superadmins: new Set(
    String(getEnv('SUPERADMINS', { fallback: '' }))
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x))
  ),
  dataDir: 'data',
  dbPath: 'data/bot.sqlite'
};

