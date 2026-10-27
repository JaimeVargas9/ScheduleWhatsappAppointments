import { existsSync } from 'node:fs';
import { z } from 'zod';

const phoneList = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((p) => p.replace(/\D/g, ''))
      .filter(Boolean),
  );

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  ADMIN_USER: z.string().min(1),
  ADMIN_PASSWORD: z.string().min(8, 'ADMIN_PASSWORD debe tener al menos 8 caracteres'),
  OLLAMA_URL: z.url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().min(1).default('qwen3:8b'),
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE: z.string().default('./credentials/google-key.json'),
  ALLOWED_TEST_NUMBERS: phoneList,
  DATABASE_FILE: z.string().default('./data/bot.db'),
  SESSIONS_DIR: z.string().default('./sessions'),
  HISTORY_MESSAGES: z.coerce.number().int().min(4).max(100).default(20),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(
      `Configuración .env inválida:\n${lines.join('\n')}\nRevisa .env (plantilla en .env.example).`,
    );
  }
  return result.data;
}

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    if (existsSync('.env')) process.loadEnvFile('.env');
    cached = parseEnv(process.env);
  }
  return cached;
}
