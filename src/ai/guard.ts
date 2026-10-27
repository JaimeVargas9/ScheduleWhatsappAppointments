import { DateTime } from 'luxon';
import { norm, times } from './tools/resolve.js';

const DAY_DATE = /\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\s+(?:dia\s+)?(\d{1,2})\b/g;
const PARTICIPLE =
  '(?:cread|reservad|confirmad|agendad|cancelad|registrad|programad|reprogramad|apuntad|anotad|movid|cambiad)[ao]s?';
const CLAIMED = new RegExp(
  `\\b(?:he|hemos)\\s+(?:creado|reservado|agendado|confirmado|cancelado|movido|cambiado|registrado|programado|apuntado|anotado)\\b` +
    `|\\b(?:ha sido|han sido|esta|estan|queda|quedan|ha quedado|ya)\\s+(?:\\w+\\s+){0,2}${PARTICIPLE}\\b` +
    `|\\bya tienes (?:tu |la )?cita\\b`,
);
const CONFIRMED = new RegExp(`\\b(?:${PARTICIPLE}|reservamos|agendamos|te espero|nos vemos el)\\b`);

const PROMISED_LIST =
  /\b(estos|estas|siguientes|alguno de los|alguna de las)\s+(horarios|huecos|opciones|horas|alternativas)\b/;

function dayDates(text: string): Set<string> {
  return new Set([...norm(text).matchAll(DAY_DATE)].map((m) => `${m[1]} ${Number(m[2])}`));
}

export type GuardInput = {
  reply: string;
  toolResults: string[];
  scheduleText: string;
  bookingDone: boolean;
};

export function checkReply({ reply, toolResults, scheduleText, bookingDone }: GuardInput): string | null {
  const grounding = [...toolResults, scheduleText].join('\n');
  const known = times(grounding);
  const invented = [...times(reply)].filter((t) => !known.has(t));
  if (invented.length) {
    return `Aviso interno: has mencionado la hora ${invented.join(', ')} sin comprobarla. No respondas todavía al cliente: llama AHORA a la herramienta consultar_disponibilidad (fecha_desde con formato AAAA-MM-DDTHH:MM, tomando la fecha del calendario de próximos días) y después responde usando solo lo que devuelva.`;
  }
  if (PROMISED_LIST.test(norm(reply)) && times(reply).size === 0) {
    return 'Aviso interno: dices que le ofreces unas opciones, pero no has escrito ninguna. Escribe las opciones que devolvió consultar_disponibilidad, cada una con el día de la semana, la fecha y la hora.';
  }
  const knownDates = dayDates(grounding);
  const wrongDates = [...dayDates(reply)].filter((d) => !knownDates.has(d));
  if (wrongDates.length) {
    return `Aviso interno: la fecha "${wrongDates.join(', ')}" no coincide con el calendario ni con lo que devolvieron las herramientas. Usa el calendario de los próximos días y consulta disponibilidad. No menciones este aviso al cliente.`;
  }
  const text = norm(reply);
  if (!bookingDone && (CLAIMED.test(text) || (CONFIRMED.test(text) && !reply.includes('?')))) {
    return 'Aviso interno: das la cita por hecha, pero no has llamado con éxito a crear_cita, cancelar_cita o reprogramar_cita. Si el cliente ya lo ha confirmado y tienes todos los datos (incluido el nombre), llama ahora a la herramienta; si no, pregunta lo que falte sin dar la cita por hecha. No menciones este aviso al cliente.';
  }
  return null;
}

const MESES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];
const pad = (n: number) => String(n).padStart(2, '0');

export function toDayMonthYear(text: string, now: DateTime): string {
  const yearFor = (day: number, month: number) => {
    const candidate = DateTime.fromObject({ year: now.year, month, day }, { zone: now.zone });
    return candidate < now.startOf('day').minus({ days: 1 }) ? now.year + 1 : now.year;
  };
  return text
    .replace(/\b(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?\b/g, '$3/$2/$1 a las $4:$5')
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, '$3/$2/$1')
    .replace(
      new RegExp(`\\b(\\d{1,2}) de (${MESES.join('|')})(?: de (\\d{4}))?`, 'gi'),
      (_m, d: string, mes: string, y?: string) => {
        const day = Number(d);
        const month = MESES.indexOf(mes.toLowerCase()) + 1;
        return `${pad(day)}/${pad(month)}/${y ?? yearFor(day, month)}`;
      },
    )
    .replace(/(\d{2}\/\d{2}\/\d{4})\s*\(\1\)/g, '$1');
}

export function toWhatsApp(text: string, now?: DateTime): string {
  return (now ? toDayMonthYear(text, now) : text)
    .trim()
    .replace(/^\*\*?([^*]{60,})\*\*?(\s*\S{0,4})$/s, '$1$2')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1: $2')
    .trim();
}
