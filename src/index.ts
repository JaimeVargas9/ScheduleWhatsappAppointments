import { startAdmin } from './admin/server.js';
import { OllamaProvider } from './ai/ollama.js';
import { BookingService } from './booking/service.js';
import { env } from './config/env.js';
import { openDb } from './db/client.js';
import { getTenant, listTenants } from './db/repos.js';
import { createGoogle } from './google/index.js';
import { log } from './util/log.js';
import { randomHumanDelay } from './whatsapp/inbound.js';
import { SessionManager } from './whatsapp/manager.js';

const config = env();
log.level = config.LOG_LEVEL;

const db = openDb(config.DATABASE_FILE);
const google = createGoogle(config.GOOGLE_SERVICE_ACCOUNT_KEY_FILE);
const llm = new OllamaProvider(config.OLLAMA_URL, config.OLLAMA_MODEL);
const booking = new BookingService(db, google);

const ollama = await llm.check();
if (ollama.ok) log.info(ollama.message);
else log.warn(`⚠️  ${ollama.message}`);

if (google.serviceAccountEmail) log.info(`Google: cuenta de servicio ${google.serviceAccountEmail}`);
else
  log.warn(
    `⚠️  Google sin configurar: falta ${config.GOOGLE_SERVICE_ACCOUNT_KEY_FILE}. Las citas se guardarán solo en local.`,
  );

const sessions = new SessionManager({
  db,
  llm,
  booking,
  historyMessages: config.HISTORY_MESSAGES,
  allowedTestNumbers: config.ALLOWED_TEST_NUMBERS,
  humanDelay: randomHumanDelay(),
  sessionsDir: config.SESSIONS_DIR,
  getTenant: (id) => getTenant(db, id),
});

startAdmin(
  {
    db,
    google,
    booking,
    llm,
    sessions,
    user: config.ADMIN_USER,
    password: config.ADMIN_PASSWORD,
    model: config.OLLAMA_MODEL,
  },
  config.PORT,
);
log.info(`Panel de control: http://localhost:${config.PORT}`);

const tenants = listTenants(db);
if (!tenants.length) log.warn('No hay negocios. Ejecuta "npm run seed" o crea uno desde el panel.');
await sessions.sync(tenants);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const t of listTenants(db)) sessions.stop(t.id);
    process.exit(0);
  });
}
