import { DateTime } from 'luxon';

export function fechaHoraLarga(dt: DateTime): string {
  return dt.setLocale('es').toFormat("cccc d 'de' LLLL 'de' yyyy, HH:mm");
}

export function huecoTexto(dt: DateTime): string {
  return dt.setLocale('es').toFormat("cccc d 'de' LLLL 'a las' HH:mm");
}

export function fechaCorta(dt: DateTime): string {
  return dt.setLocale('es').toFormat("cccc d 'de' LLLL");
}
