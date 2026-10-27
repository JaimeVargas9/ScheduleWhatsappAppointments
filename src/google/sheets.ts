import { auth, sheets } from '@googleapis/sheets';

export const SHEET_HEADER = [
  'ID cita',
  'Fecha creación',
  'Cliente',
  'Teléfono',
  'Servicio',
  'Profesional',
  'Ubicación',
  'Dirección',
  'Inicio',
  'Fin',
  'Estado',
  'Notas',
];

export type SheetTarget = { spreadsheetId: string; tab: string };

export interface SheetsClient {
  appendRow(target: SheetTarget, row: string[]): Promise<void>;
  updateRow(target: SheetTarget, id: string, row: string[]): Promise<void>;
  readAll(target: SheetTarget): Promise<string[][]>;
}

const range = (tab: string, a1: string) => `'${tab.replace(/'/g, "''")}'!${a1}`;

export function googleSheets(authClient: InstanceType<typeof auth.GoogleAuth>): SheetsClient {
  const api = sheets({ version: 'v4', auth: authClient });

  async function ensureTab(t: SheetTarget) {
    const meta = await api.spreadsheets.get({
      spreadsheetId: t.spreadsheetId,
      fields: 'sheets.properties.title',
    });
    if (!meta.data.sheets?.some((s) => s.properties?.title === t.tab)) {
      await api.spreadsheets.batchUpdate({
        spreadsheetId: t.spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: t.tab } } }] },
      });
    }
  }

  async function readAll(t: SheetTarget) {
    const res = await api.spreadsheets.values.get({
      spreadsheetId: t.spreadsheetId,
      range: range(t.tab, 'A:L'),
    });
    return (res.data.values ?? []) as string[][];
  }

  return {
    readAll,

    async appendRow(t, row) {
      await ensureTab(t);
      const values = (await readAll(t)).length === 0 ? [SHEET_HEADER, row] : [row];
      await api.spreadsheets.values.append({
        spreadsheetId: t.spreadsheetId,
        range: range(t.tab, 'A1'),
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
      });
    },

    async updateRow(t, id, row) {
      const rows = await readAll(t);
      const index = rows.findIndex((r) => r[0] === id);
      if (index < 0) {
        await this.appendRow(t, row);
        return;
      }
      await api.spreadsheets.values.update({
        spreadsheetId: t.spreadsheetId,
        range: range(t.tab, `A${index + 1}`),
        valueInputOption: 'RAW',
        requestBody: { values: [row] },
      });
    },
  };
}
