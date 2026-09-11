/** Generación del archivo .ics para "agregar al calendario". */
import { RESTAURANT, ZONES } from './config.js';
import { toUtcStamp, prettyDate, prettyTime } from './time.js';

const fold = (line) => {
  const out = [];
  let rest = line;
  while (rest.length > 73) {
    out.push(rest.slice(0, 73));
    rest = ` ${rest.slice(73)}`;
  }
  out.push(rest);
  return out.join('\r\n');
};

const esc = (text) =>
  String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

export function reservationIcs(reservation) {
  const zone = ZONES.find((z) => z.id === reservation.zone);
  const start = toUtcStamp(reservation.date, reservation.time);
  const end = toUtcStamp(reservation.date, reservation.time, reservation.turnMinutes || 120);
  const stamp = toUtcStamp(reservation.date, '00:00');

  const description = [
    `Reserva ${reservation.code} a nombre de ${reservation.name}.`,
    `${reservation.party} personas · ${zone ? zone.name : 'salón por asignar'} · mesa ${reservation.tableId}.`,
    `${prettyDate(reservation.date)}, ${prettyTime(reservation.time)}.`,
    `Cambios y cancelaciones: ${RESTAURANT.phone} o ${RESTAURANT.email}.`
  ].join('\\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//El Guayacan//Reservas//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${reservation.code}@elguayacan.co`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    fold(`SUMMARY:${esc(`${RESTAURANT.name} · mesa para ${reservation.party}`)}`),
    fold(`DESCRIPTION:${description}`),
    fold(`LOCATION:${esc(RESTAURANT.address)}`),
    'BEGIN:VALARM',
    'TRIGGER:-PT2H',
    'ACTION:DISPLAY',
    'DESCRIPTION:Su reserva en El Guayacan es en dos horas',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ];

  return `${lines.join('\r\n')}\r\n`;
}
