import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { env } from '../src/config/env.js';
import { openDb } from '../src/db/client.js';
import { getTenant, saveTenant } from '../src/db/repos.js';
import { parseTenantConfig } from '../src/tenants/schema.js';

const { values } = parseArgs({ options: { file: { type: 'string' } } });
if (!values.file) {
  console.error('Uso: npm run tenant:create -- --file negocio.json');
  process.exit(1);
}

try {
  const config = parseTenantConfig(JSON.parse(readFileSync(values.file, 'utf8')));
  const db = openDb(env().DATABASE_FILE);
  const existed = !!getTenant(db, config.id);
  saveTenant(db, config);
  console.log(`Negocio "${config.nombre}" (${config.id}) ${existed ? 'actualizado' : 'creado'}.`);
  console.log(
    'Si el programa está en marcha, reinícialo o guarda el negocio desde el panel para conectar su WhatsApp.',
  );
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
