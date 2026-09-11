/* ==========================================================================
   Utilidades compartidas por el sitio y el panel.
   ========================================================================== */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escapa texto para interpolar en plantillas HTML. */
export const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Crea un nodo a partir de una plantilla HTML. */
export function node(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

export function fill(host, html) {
  host.innerHTML = html;
  return host;
}

/* ------------------------------------------------------------------- fechas */

export const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
export const DIAS_CORTO = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
export const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
];
export const MESES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export const parseISO = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d, 12);
};

export const toISO = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export const addDays = (iso, days) => toISO(new Date(parseISO(iso).getTime() + days * 86400000));

export const diffDays = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000);

export const weekday = (iso) => parseISO(iso).getDay();

export function prettyDate(iso, { withYear = false, short = false } = {}) {
  const d = parseISO(iso);
  const dia = short ? DIAS_CORTO[d.getDay()] : DIAS[d.getDay()];
  const mes = short ? MESES_CORTO[d.getMonth()] : MESES[d.getMonth()];
  const base = short ? `${dia} ${d.getDate()} ${mes}` : `${dia} ${d.getDate()} de ${mes}`;
  return withYear ? `${base} de ${d.getFullYear()}` : base;
}

export function prettyTime(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const suf = h < 12 ? 'a.m.' : 'p.m.';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${suf}`;
}

export const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

export const toHHMM = (min) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.round(min) % 60).padStart(2, '0')}`;

export function relativeDay(iso, today) {
  const delta = diffDays(today, iso);
  if (delta === 0) return 'hoy';
  if (delta === 1) return 'mañana';
  if (delta === -1) return 'ayer';
  return prettyDate(iso, { short: true });
}

/* -------------------------------------------------------------------- plata */

export function money(value) {
  if (!value) return '$ 0';
  return `$ ${Math.round(value).toLocaleString('es-CO')}`;
}

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/* ---------------------------------------------------------------------- api */

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
}

let adminPin = null;
export const setAdminPin = (pin) => {
  adminPin = pin;
};

export async function api(path, { method = 'GET', body, admin = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (admin && adminPin) headers['x-admin-pin'] = adminPin;

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) throw new ApiError(data.error || `Error ${res.status}`, res.status, data);
  return data;
}

/* ------------------------------------------------------------------- toasts */

export function toast(message, kind = 'info', ms = 4600) {
  const host = $('#toasts');
  if (!host) return;
  const el = node(`<div class="toast is-${kind}"><div>${esc(message)}</div></div>`);
  host.append(el);
  const close = () => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 320);
  };
  el.addEventListener('click', close);
  setTimeout(close, ms);
}

/* -------------------------------------------------------------------- varios */

export function debounce(fn, ms = 220) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Descarga un archivo servido por la API sin salir de la página. */
export function download(url) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
