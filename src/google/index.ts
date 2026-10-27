import { existsSync, readFileSync } from 'node:fs';
import { auth } from '@googleapis/calendar';
import { googleCalendar, type CalendarClient } from './calendar.js';
import { googleSheets, type SheetsClient } from './sheets.js';

export type Google = {
  calendar: CalendarClient;
  sheets: SheetsClient;
  serviceAccountEmail: string | null;
};

const notConfigured = (keyFile: string) => () =>
  Promise.reject(
    new Error(
      `Google no está configurado: falta la clave de la cuenta de servicio en ${keyFile}. Mira el README.`,
    ),
  );

export function createGoogle(keyFile: string): Google {
  if (!existsSync(keyFile)) {
    const fail = notConfigured(keyFile);
    return {
      calendar: { freeBusy: fail, createEvent: fail, updateEvent: fail, listEvents: fail },
      sheets: { appendRow: fail, updateRow: fail, readAll: fail },
      serviceAccountEmail: null,
    };
  }
  const key = JSON.parse(readFileSync(keyFile, 'utf8')) as { client_email?: string };
  const authClient = new auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/spreadsheets'],
  });
  return {
    calendar: googleCalendar(authClient),
    sheets: googleSheets(authClient),
    serviceAccountEmail: key.client_email ?? null,
  };
}
