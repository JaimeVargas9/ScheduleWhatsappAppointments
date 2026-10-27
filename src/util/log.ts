import pino from 'pino';

export const log = pino({
  level: process.env.VITEST ? 'silent' : (process.env.LOG_LEVEL ?? 'info'),
  transport: process.env.VITEST
    ? undefined
    : { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } },
});

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 5) return '***';
  return `${digits.slice(0, 5)}***${digits.slice(-3)}`;
}
