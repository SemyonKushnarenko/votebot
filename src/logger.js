import pino from 'pino';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function canUsePretty() {
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.PINO_PRETTY === '0') return false;
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: canUsePretty()
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' }
      }
    : undefined
});

