import { readFileSync } from 'node:fs';
import { runAgent } from '../src/ai/agent.js';
import { OllamaProvider } from '../src/ai/ollama.js';
import { BookingService } from '../src/booking/service.js';
import { env } from '../src/config/env.js';
import { openDb } from '../src/db/client.js';
import { getOrCreateConversation, messagesAfter, saveTenant } from '../src/db/repos.js';
import { parseTenantConfig } from '../src/tenants/schema.js';
import { fakeGoogle } from '../tests/fakes.js';

const tenant = parseTenantConfig({
  ...JSON.parse(readFileSync('examples/negocio.ejemplo.json', 'utf8')),
  google: { calendar_id: 'cal', spreadsheet_id: 'sheet', pestana: 'Citas' },
});
const db = openDb(':memory:');
saveTenant(db, tenant);
const g = fakeGoogle();
const booking = new BookingService(db, g.google);
const llm = new OllamaProvider(env().OLLAMA_URL, env().OLLAMA_MODEL);
console.log(await llm.check());
const conv = getOrCreateConversation(db, tenant.id, '34600111222', '34600111222@s.whatsapp.net');

for (const text of process.argv.slice(2)) {
  const t0 = Date.now();
  const reply = await runAgent(
    { db, llm, booking, historyMessages: 20 },
    {
      tenant,
      conversationId: conv.id,
      phone: '34600111222',
      text,
      handoff: async (r) => console.log('HANDOFF', r),
    },
  );
  console.log(`\n> ${text}\n< ${reply}   (${Date.now() - t0} ms)`);
}
console.log('\nTraza:');
for (const m of messagesAfter(db, conv.id, 0)) {
  console.log(m.role, m.toolCalls ? JSON.stringify(m.toolCalls) : m.content.slice(0, 300));
}
console.log(
  'Eventos:',
  [...g.calendar.events.values()].map((e) => `${e.summary} ${e.start}`),
);
console.log('Filas hoja:', g.sheets.rows);
