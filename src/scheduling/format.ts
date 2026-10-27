import { DateTime } from 'luxon';

export function fechaHoraLarga(dt: DateTime): string {
  return dt.setLocale('es').toFormat("cccc d 'de' LLLL 'de' yyyy (dd/MM/yyyy), HH:mm");
}

export function huecoTexto(dt: DateTime): string {
  return dt.setLocale('es').toFormat("cccc dd/MM/yyyy 'a las' HH:mm");
}

export function fechaDma(isoDate: string): string {
  return DateTime.fromISO(isoDate).toFormat('dd/MM/yyyy');
}
