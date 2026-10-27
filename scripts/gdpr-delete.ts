import { parseArgs } from 'node:util';
import { BookingService } from '../src/booking/service.js';
import { env } from '../src/config/env.js';
import { openDb } from '../src/db/client.js';
import { addLog, deleteClientData, getTenant } from '../src/db/repos.js';
import { createGoogle } from '../src/google/index.js';
import { maskPhone } from '../src/util/log.js';

const { values } = parseArgs({ options: { tenant: { type: 'string' }, phone: { type: 'string' } } });
const phone = values.phone?.replace(/\D/g, '');
if (!values.tenant || !phone) {
  console.error('Uso: npm run gdpr:delete -- --tenant <id-negocio> --phone 34600111222');
  process.exit(1);
}

const config = env();
const db = openDb(config.DATABASE_FILE);
const tenant = getTenant(db, values.tenant);
if (!tenant) {
  console.error(`No existe el negocio "${values.tenant}".`);
  process.exit(1);
}

const booking = new BookingService(db, createGoogle(config.GOOGLE_SERVICE_ACCOUNT_KEY_FILE));
const deleted = deleteClientData(db, tenant.id, phone);
let googleErrors = 0;
for (const cita of deleted.appointments) {
  try {
    await booking.anonymize(tenant, cita);
  } catch (e) {
    googleErrors++;
    console.error(`No se pudo anonimizar en Google la cita ${cita.id}: ${(e as Error).message}`);
  }
}
addLog(db, 'info', 'gdpr_borrado', tenant.id, {
  telefono: maskPhone(phone),
  citas: deleted.appointments.length,
});

console.log(
  `Borrado de ${maskPhone(phone)} en "${tenant.id}": ${deleted.conversations} conversación(es) y ${deleted.appointments.length} cita(s) eliminadas de la BD.`,
);
const usesGoogle = !!(tenant.google.calendar_id || tenant.google.spreadsheet_id);
console.log(
  !deleted.appointments.length || !usesGoogle
    ? 'No había nada que anonimizar en Google.'
    : `En Google Calendar y Sheets se han anonimizado nombre y teléfono${googleErrors ? ` (con ${googleErrors} error(es))` : ''}.`,
);
