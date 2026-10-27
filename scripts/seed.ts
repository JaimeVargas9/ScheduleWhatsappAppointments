import { readFileSync } from 'node:fs';
import { env } from '../src/config/env.js';
import { openDb } from '../src/db/client.js';
import { getTenant, saveTenant } from '../src/db/repos.js';
import { parseTenantConfig } from '../src/tenants/schema.js';

const config = parseTenantConfig(JSON.parse(readFileSync('examples/negocio.ejemplo.json', 'utf8')));
const db = openDb(env().DATABASE_FILE);

if (getTenant(db, config.id)) {
  console.log(`El negocio "${config.id}" ya existe; no se modifica.`);
} else {
  saveTenant(db, config);
  console.log(`Negocio de prueba "${config.nombre}" (${config.id}) creado en modo ${config.modo}.`);
}
