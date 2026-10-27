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

  async function ensureTab(t: SheetTarget, rowsNeeded: number) {
    const meta = await api.spreadsheets.get({
      spreadsheetId: t.spreadsheetId,
      fields: 'sheets.properties.title,sheets.properties.sheetId,sheets.properties.gridProperties.rowCount',
    });
    const tab = meta.data.sheets?.find((s) => s.properties?.title === t.tab)?.properties;
    if (!tab) {
      await api.spreadsheets.batchUpdate({
        spreadsheetId: t.spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: t.tab } } }] },
      });
      return;
    }
    const rowCount = tab.gridProperties?.rowCount ?? 0;
    if (rowsNeeded > rowCount) {
      await api.spreadsheets.batchUpdate({
        spreadsheetId: t.spreadsheetId,
        requestBody: {
          requests: [
            {
              appendDimension: {
                sheetId: tab.sheetId,
                dimension: 'ROWS',
                length: rowsNeeded - rowCount + 500,
              },
            },
          ],
        },
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

    // Writes into the first free row instead of inserting one: inserted rows shift formulas that point at the tab.
    async appendRow(t, row) {
      const existing = await readAll(t).catch(() => [] as string[][]);
      const values = existing.length === 0 ? [SHEET_HEADER, row] : [row];
      await ensureTab(t, existing.length + values.length);
      await api.spreadsheets.values.update({
        spreadsheetId: t.spreadsheetId,
        range: range(t.tab, `A${existing.length + 1}`),
        valueInputOption: 'RAW',
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
