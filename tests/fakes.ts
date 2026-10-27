import type { CalendarClient, CalendarEvent, EventInput } from '../src/google/calendar.js';
import type { Google } from '../src/google/index.js';
import { SHEET_HEADER, type SheetsClient } from '../src/google/sheets.js';

export class FakeCalendar implements CalendarClient {
  events = new Map<string, EventInput & { calendarId: string; cancelled?: boolean }>();
  private seq = 0;

  async freeBusy(calendarIds: string[], from: Date, to: Date) {
    const out: Record<string, { start: number; end: number }[]> = {};
    for (const id of calendarIds) {
      out[id] = [...this.events.values()]
        .filter((e) => e.calendarId === id && !e.cancelled)
        .map((e) => ({ start: Date.parse(e.start), end: Date.parse(e.end) }))
        .filter((b) => b.start < to.getTime() && b.end > from.getTime());
    }
    return out;
  }

  async createEvent(calendarId: string, ev: EventInput) {
    await new Promise((r) => setTimeout(r, 5));
    const id = `ev${++this.seq}`;
    this.events.set(id, { ...ev, calendarId });
    return id;
  }

  async updateEvent(_calendarId: string, eventId: string, ev: Partial<EventInput> & { cancelled?: boolean }) {
    const current = this.events.get(eventId);
    if (!current) throw new Error(`evento ${eventId} no existe`);
    this.events.set(eventId, { ...current, ...ev });
  }

  async listEvents(calendarId: string): Promise<CalendarEvent[]> {
    return [...this.events.entries()]
      .filter(([, e]) => e.calendarId === calendarId)
      .map(([id, e]) => ({ id, summary: e.summary, start: e.start, end: e.end, transparent: !!e.cancelled }));
  }

  block(calendarId: string, start: string, end: string) {
    this.events.set(`ext${++this.seq}`, {
      calendarId,
      summary: 'Ocupado',
      location: '',
      description: '',
      start,
      end,
      timeZone: 'Europe/Madrid',
    });
  }
}

export class FakeSheets implements SheetsClient {
  rows: string[][] = [];

  async appendRow(_t: unknown, row: string[]) {
    if (this.rows.length === 0) this.rows.push(SHEET_HEADER);
    this.rows.push(row);
  }

  async updateRow(t: unknown, id: string, row: string[]) {
    const i = this.rows.findIndex((r) => r[0] === id);
    if (i < 0) await this.appendRow(t, row);
    else this.rows[i] = row;
  }

  async readAll() {
    return this.rows;
  }
}

export function fakeGoogle() {
  const calendar = new FakeCalendar();
  const sheets = new FakeSheets();
  const google: Google = { calendar, sheets, serviceAccountEmail: 'bot@test.iam.gserviceaccount.com' };
  return { google, calendar, sheets };
}
