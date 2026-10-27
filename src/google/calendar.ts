import { auth, calendar } from '@googleapis/calendar';
import type { Busy } from '../scheduling/slots.js';

export type EventInput = {
  summary: string;
  location: string;
  description: string;
  start: string;
  end: string;
  timeZone: string;
};

export type CalendarEvent = { id: string; summary: string; start: string; end: string; transparent: boolean };

export interface CalendarClient {
  freeBusy(calendarIds: string[], from: Date, to: Date): Promise<Record<string, Busy[]>>;
  createEvent(calendarId: string, ev: EventInput): Promise<string>;
  updateEvent(
    calendarId: string,
    eventId: string,
    ev: Partial<EventInput> & { cancelled?: boolean },
  ): Promise<void>;
  listEvents(calendarId: string, from: Date, to: Date): Promise<CalendarEvent[]>;
}

export function googleCalendar(authClient: InstanceType<typeof auth.GoogleAuth>): CalendarClient {
  const api = calendar({ version: 'v3', auth: authClient });
  const times = (ev: Partial<EventInput>) => ({
    ...(ev.start && { start: { dateTime: ev.start, timeZone: ev.timeZone } }),
    ...(ev.end && { end: { dateTime: ev.end, timeZone: ev.timeZone } }),
  });

  return {
    async freeBusy(calendarIds, from, to) {
      const res = await api.freebusy.query({
        requestBody: {
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          items: calendarIds.map((id) => ({ id })),
        },
      });
      const out: Record<string, Busy[]> = {};
      for (const id of calendarIds) {
        const cal = res.data.calendars?.[id];
        if (cal?.errors?.length) {
          throw new Error(
            `Google Calendar no deja leer "${id}" (${cal.errors[0]?.reason}). ¿Está compartido con la cuenta de servicio?`,
          );
        }
        out[id] = (cal?.busy ?? []).map((b) => ({ start: Date.parse(b.start!), end: Date.parse(b.end!) }));
      }
      return out;
    },

    async createEvent(calendarId, ev) {
      const res = await api.events.insert({
        calendarId,
        requestBody: {
          summary: ev.summary,
          location: ev.location,
          description: ev.description,
          ...times(ev),
        },
      });
      return res.data.id!;
    },

    async updateEvent(calendarId, eventId, ev) {
      await api.events.patch({
        calendarId,
        eventId,
        requestBody: {
          ...(ev.summary !== undefined && { summary: ev.summary }),
          ...(ev.location !== undefined && { location: ev.location }),
          ...(ev.description !== undefined && { description: ev.description }),
          ...(ev.cancelled && { transparency: 'transparent' }),
          ...times(ev),
        },
      });
    },

    async listEvents(calendarId, from, to) {
      const res = await api.events.list({
        calendarId,
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 2500,
      });
      return (res.data.items ?? [])
        .filter((e) => e.status !== 'cancelled')
        .map((e) => ({
          id: e.id!,
          summary: e.summary ?? '(sin título)',
          start: e.start?.dateTime ?? e.start?.date ?? '',
          end: e.end?.dateTime ?? e.end?.date ?? '',
          transparent: e.transparency === 'transparent',
        }));
    },
  };
}
