import { readFileSync } from 'node:fs';
import { openDb } from '../src/db/client.js';
import { saveTenant } from '../src/db/repos.js';
import { parseTenantConfig, type TenantConfig } from '../src/tenants/schema.js';

export function exampleTenant(overrides: Partial<TenantConfig> = {}): TenantConfig {
  const raw = JSON.parse(readFileSync('examples/negocio.ejemplo.json', 'utf8'));
  return parseTenantConfig({ ...raw, ...overrides });
}

export function testDb(tenant: TenantConfig = exampleTenant()) {
  const db = openDb(':memory:');
  saveTenant(db, tenant);
  return db;
}
