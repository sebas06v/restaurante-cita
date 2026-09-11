/**
 * Utilidades de fecha y hora. Todo el sistema trabaja con fechas "ingenuas"
 * en la zona del restaurante: 'YYYY-MM-DD' y minutos desde medianoche.
 * Así se evita cualquier corrimiento por zona horaria del servidor.
 */
import { RESTAURANT } from './config.js';

const DAY_MS = 86400000;

/** Fecha/hora actual en la zona del restaurante. */
export function nowLocal() {
  const utc = Date.now() + new Date().getTimezoneOffset() * 60000;
  return new Date(utc + RESTAURANT.timezoneOffset * 3600000);
}

export function todayISO() {
  return toISO(nowLocal());
}

export function nowMinutes() {
  const d = nowLocal();
  return d.getHours() * 60 + d.getMinutes();
}

export function toISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function fromISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

export function addDays(iso, days) {
  return toISO(new Date(fromISO(iso).getTime() + days * DAY_MS));
}

export function daysBetween(fromIso, toIso) {
  return Math.round((fromISO(toIso) - fromISO(fromIso)) / DAY_MS);
}

export function weekday(iso) {
  return fromISO(iso).getDay();
}

export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function toHHMM(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function isValidISO(iso) {
  return typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(fromISO(iso).getTime());
}

export function isValidHHMM(hhmm) {
  return typeof hhmm === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm);
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
];

/** "viernes 12 de junio" */
export function prettyDate(iso, withYear = false) {
  const d = fromISO(iso);
  const base = `${DIAS[d.getDay()]} ${d.getDate()} de ${MESES[d.getMonth()]}`;
  return withYear ? `${base} de ${d.getFullYear()}` : base;
}

/** "7:30 p.m." */
export function prettyTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h < 12 ? 'a.m.' : 'p.m.';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** Timestamp UTC para archivos .ics, desde fecha/hora local del restaurante. */
export function toUtcStamp(iso, hhmm, addMinutes = 0) {
  const [y, mo, d] = iso.split('-').map(Number);
  const total = toMinutes(hhmm) + addMinutes;
  const ms = Date.UTC(y, mo - 1, d, 0, 0, 0) + (total - RESTAURANT.timezoneOffset * 60) * 60000;
  const dt = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${dt.getUTCFullYear()}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())}` +
    `T${p(dt.getUTCHours())}${p(dt.getUTCMinutes())}00Z`
  );
}
