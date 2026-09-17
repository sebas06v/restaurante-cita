/**
 * Capa HTTP de negocio: validaciones, reglas y respuestas JSON.
 * Cada handler recibe ({ query, body, params }) y devuelve { status, json }.
 */
import {
  RESTAURANT,
  ZONES,
  TABLES,
  MENU,
  OCCASIONS,
  PREFERENCES,
  EXPERIENCES,
  STATUSES,
  SERVICE_HOURS,
  ACTIVE_STATUSES,
  ADMIN_PIN,
  PIN_IS_DEMO,
  PAGO,
  ESPERA,
  ESTADOS_ESPERA,
  requierePago
} from './config.js';
import { db, write, nextId, makeCode, logEvent } from './db.js';
import {
  dayAvailability,
  floorState,
  allocate,
  checkSlot,
  turnMinutes,
  servicesFor,
  dateProblem,
  isOpen,
  dayMetrics,
  activeOn
} from './availability.js';
import {
  todayISO,
  addDays,
  isValidISO,
  isValidHHMM,
  toMinutes,
  prettyDate,
  prettyTime,
  daysBetween,
  weekday
} from './time.js';
import { reservationIcs } from './ics.js';
import { alReservar, alPagar, alCancelar, estadoCola, reintentar, programarVencimientoPago } from './queue/correos.js';
import { evaluarLiberacion, aceptarOferta, rechazarOferta, verOferta, ofrecerAMano, resumenEspera } from './espera.js';
import { bandeja, correoDeLaBandeja, transporteInfo } from './mail/transporte.js';
import { leerDia, diasGuardados, diaDeHoy, LOGS_DIR } from './log.js';

class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const ok = (json, status = 200) => ({ status, json });
const bad = (message, extra) => {
  throw new ApiError(400, message, extra);
};

/* ---------------------------------------------------------------- lectura */

export function getConfig() {
  return ok({
    restaurant: RESTAURANT,
    zones: ZONES,
    tables: TABLES.map(({ id, zone, min, max, shape, x, y, w, h }) => ({ id, zone, min, max, shape, x, y, w, h })),
    menu: MENU,
    occasions: OCCASIONS,
    preferences: PREFERENCES,
    experiences: EXPERIENCES,
    statuses: STATUSES,
    hours: Object.entries(SERVICE_HOURS).map(([day, services]) => ({ day: Number(day), services })),
    today: todayISO(),
    demoPin: PIN_IS_DEMO,
    pago: PAGO
  });
}

/** Resumen de N días para el selector de fecha: abierto/cerrado y presión. */
export function getCalendar({ query }) {
  const from = isValidISO(query.from) ? query.from : todayISO();
  const days = Math.min(Math.max(Number(query.days) || 35, 1), 90);
  const party = clampParty(query.party || 2);
  const state = db();

  const out = [];
  for (let i = 0; i < days; i += 1) {
    const date = addDays(from, i);
    const problem = dateProblem(date);
    if (problem) {
      out.push({ date, open: false, reason: problem, load: 0, slots: 0 });
      continue;
    }
    const availability = dayAvailability({ date, party, reservations: state.reservations, blocks: state.blocks });
    const slots = availability.services.reduce((sum, s) => sum + s.openCount, 0);
    const total = availability.services.reduce((sum, s) => sum + s.slots.length, 0) || 1;
    out.push({
      date,
      open: true,
      reason: null,
      slots,
      load: Math.round((1 - slots / total) * 100),
      first: availability.services.map((s) => s.firstOpen).find(Boolean) || null
    });
  }
  return ok({ from, days, party, calendar: out });
}

export function getAvailability({ query }) {
  const date = query.date;
  if (!isValidISO(date)) bad('Fecha inválida.');
  const party = clampParty(query.party);
  const state = db();
  const excludeId = query.exclude
    ? (state.reservations.find((r) => r.code === String(query.exclude).toUpperCase()) || {}).id
    : null;

  const availability = dayAvailability({
    date,
    party,
    reservations: state.reservations,
    blocks: state.blocks,
    excludeId
  });

  return ok({
    ...availability,
    turnMinutes: turnMinutes(party),
    prettyDate: prettyDate(date, true),
    suggestions: availability.problem || availability.services.every((s) => s.openCount === 0)
      ? nearbyDates({ date, party, state })
      : []
  });
}

export function getFloor({ query }) {
  const { date, time } = query;
  if (!isValidISO(date)) bad('Fecha inválida.');
  if (!isValidHHMM(time)) bad('Hora inválida.');
  const party = query.party ? clampParty(query.party) : null;
  const state = db();
  const excludeId = query.exclude
    ? (state.reservations.find((r) => r.code === String(query.exclude).toUpperCase()) || {}).id
    : null;

  return ok(
    floorState({ date, time, party, reservations: state.reservations, blocks: state.blocks, excludeId })
  );
}

/* ------------------------------------------------------------- reservas */

function clampParty(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) bad('El número de personas no es válido.');
  if (n > RESTAURANT.maxPartyOnline) {
    throw new ApiError(422, `Para grupos de más de ${RESTAURANT.maxPartyOnline} organizamos un evento privado.`, {
      contact: RESTAURANT.whatsapp
    });
  }
  return n;
}

function slotExists(date, time) {
  return servicesFor(date).some((s) => {
    const m = toMinutes(time);
    return m >= toMinutes(s.open) && m <= toMinutes(s.lastSeating) && m % RESTAURANT.slotMinutes === 0;
  });
}

/** Horarios cercanos con mesa, para ofrecer alternativas cuando algo se llena. */
function nearbyTimes({ date, time, party, state, excludeId = null }) {
  const target = toMinutes(time);
  const all = dayAvailability({ date, party, reservations: state.reservations, blocks: state.blocks, excludeId })
    .services.flatMap((s) => s.slots)
    .filter((s) => s.status === 'free' || s.status === 'ultimas');
  return all
    .sort((a, b) => Math.abs(toMinutes(a.time) - target) - Math.abs(toMinutes(b.time) - target))
    .slice(0, 5)
    .map((s) => ({ time: s.time, label: prettyTime(s.time), zones: s.zones }));
}

function nearbyDates({ date, party, state }) {
  const out = [];
  for (let i = 1; i <= 10 && out.length < 3; i += 1) {
    const candidate = addDays(date, i);
    if (dateProblem(candidate)) continue;
    const availability = dayAvailability({
      date: candidate,
      party,
      reservations: state.reservations,
      blocks: state.blocks
    });
    const first = availability.services.map((s) => s.firstOpen).find(Boolean);
    if (first) out.push({ date: candidate, label: prettyDate(candidate), time: first });
  }
  return out;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

function normalizeGuest(body) {
  const name = String(body.name || '').trim().replace(/\s+/g, ' ');
  const phone = String(body.phone || '').trim();
  const email = String(body.email || '').trim().toLowerCase();

  if (name.length < 3 || !name.includes(' ')) bad('Escriba nombre y apellido.', { field: 'name' });
  if (phone.replace(/\D/g, '').length < 7) bad('El teléfono no parece completo.', { field: 'phone' });
  if (!EMAIL_RE.test(email)) bad('Revise el correo electrónico.', { field: 'email' });

  return { name, phone, email };
}

function normalizeExtras(body) {
  const prefIds = new Set(PREFERENCES.map((p) => p.id));
  const expIds = new Set(EXPERIENCES.map((e) => e.id));
  const occasion = OCCASIONS.some((o) => o.id === body.occasion) ? body.occasion : 'ninguna';
  return {
    occasion,
    preferences: [...new Set((body.preferences || []).filter((p) => prefIds.has(p)))],
    experiences: [...new Set((body.experiences || []).filter((e) => expIds.has(e)))],
    notes: String(body.notes || '').trim().slice(0, 600)
  };
}

function publicReservation(r) {
  const zone = ZONES.find((z) => z.id === r.zone);
  return {
    ...r,
    zoneName: zone ? zone.name : 'Salón por asignar',
    prettyDate: prettyDate(r.date, true),
    prettyTime: prettyTime(r.time),
    experienceDetail: EXPERIENCES.filter((e) => (r.experiences || []).includes(e.id)),
    preferenceLabels: PREFERENCES.filter((p) => (r.preferences || []).includes(p.id)).map((p) => p.label),
    occasionLabel: (OCCASIONS.find((o) => o.id === r.occasion) || OCCASIONS[0]).label,
    estimate: estimateTotal(r),
    pago: cobroDe(r)
  };
}

/* ═══════════════════════════════════════════════════════════════ cobro ══ */

/** El cobro con el que nace una reserva. */
function nuevoCobro(party) {
  const requerido = requierePago(party);
  return {
    requerido,
    monto: requerido ? PAGO.monto : 0,
    moneda: PAGO.moneda,
    estado: requerido ? 'pendiente' : 'no-aplica',
    metodo: null,
    referencia: null,
    simulado: PAGO.modo === 'simulado',
    at: null
  };
}

/** Cobro de una reserva vieja, creada antes de que existiera el pago. */
const cobroDe = (r) => r.pago || { requerido: false, monto: 0, estado: 'no-aplica', moneda: PAGO.moneda };

/** Estimado de garantía / extras: no cobra nada, solo informa. */
function estimateTotal(r) {
  const zone = ZONES.find((z) => z.id === r.zone);
  const extras = EXPERIENCES.filter((e) => (r.experiences || []).includes(e.id)).reduce(
    (sum, e) => sum + (e.per === 'persona' ? e.price * r.party : e.price),
    0
  );
  const surcharge = zone ? zone.surcharge : 0;
  const deposit = r.party >= RESTAURANT.depositFrom ? 50000 * r.party : 0;
  return { extras, surcharge, deposit, total: extras + surcharge + deposit };
}

export async function createReservation({ body, admin = false }) {
  const state = db();
  const party = clampParty(body.party);
  const date = body.date;
  const time = body.time;

  if (!isValidISO(date)) bad('Fecha inválida.', { field: 'date' });
  if (!isValidHHMM(time)) bad('Hora inválida.', { field: 'time' });

  if (!admin) {
    const problem = dateProblem(date);
    if (problem) bad(problem, { field: 'date' });
    if (!slotExists(date, time)) bad('Ese horario no está en servicio.', { field: 'time' });
  } else if (!isOpen(date)) {
    bad('Ese día el restaurante está cerrado.', { field: 'date' });
  }

  const zone = ZONES.some((z) => z.id === body.zone) ? body.zone : null;
  if (zone === 'privado' && party < 6) {
    bad('El comedor privado se reserva desde 6 personas.', { field: 'zone' });
  }

  const guest = normalizeGuest(body);
  const extras = normalizeExtras(body);

  const wanted = admin && body.tableId ? TABLES.find((t) => t.id === body.tableId) : null;
  let table;
  if (wanted) {
    const free = checkSlot({ date, time, party, reservations: state.reservations, blocks: state.blocks });
    table = free.tables.find((t) => t.id === wanted.id);
    if (!table) throw new ApiError(409, `La mesa ${wanted.id} no está libre a esa hora.`);
  } else {
    const slot = checkSlot({ date, time, party, zone, reservations: state.reservations, blocks: state.blocks });
    if (!slot.ok && !admin) {
      throw new ApiError(409, slot.kitchenFull ? 'La cocina ya está copada a esa hora.' : 'Ese horario se acaba de ocupar.', {
        alternatives: nearbyTimes({ date, time, party, state }),
        dates: nearbyDates({ date, party, state })
      });
    }
    table = allocate({ date, time, party, zone, reservations: state.reservations, blocks: state.blocks });
    if (!table) throw new ApiError(409, 'No quedan mesas para ese horario.', {
      alternatives: nearbyTimes({ date, time, party, state })
    });
  }

  const cobro = nuevoCobro(party);

  const reservation = {
    id: nextId('RES'),
    code: makeCode(state.reservations),
    date,
    time,
    party,
    zone: table.zone,
    tableId: table.id,
    turnMinutes: turnMinutes(party),
    ...guest,
    ...extras,
    // Por web, sin pagar no hay mesa en firme. Por teléfono la cobra el
    // equipo en el restaurante, así que la reserva queda confirmada y el
    // cobro pendiente.
    status: cobro.requerido && !admin
      ? 'pendiente-pago'
      : admin
        ? 'confirmada'
        : party >= RESTAURANT.depositFrom
          ? 'pendiente'
          : 'confirmada',
    pago: cobro,
    source: admin ? 'telefono' : 'web',
    deposit: party >= RESTAURANT.depositFrom,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history: [{ at: new Date().toISOString(), action: 'creada', by: admin ? 'equipo' : 'web' }]
  };

  await write((d) => {
    d.reservations.push(reservation);
    d.reservations.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
    logEvent({ action: 'reserva-creada', code: reservation.code, date, time, party });
  });

  // La confirmación sale por la cola: el huésped no espera al correo.
  alReservar(reservation);
  // Y si se queda en «por pagar», un reloj que suelta la mesa y se la
  // ofrece a quien esté en la lista de espera.
  programarVencimientoPago(reservation);

  return ok({ reservation: publicReservation(reservation) }, 201);
}

function findByCode(code) {
  const clean = String(code || '').trim().toUpperCase();
  const withPrefix = clean.startsWith('GY-') ? clean : `GY-${clean}`;
  const found = db().reservations.find((r) => r.code === clean || r.code === withPrefix);
  if (!found) throw new ApiError(404, 'No encontramos una reserva con ese código.');
  return found;
}

export function lookupReservation({ query, params }) {
  const code = params.code || query.code;
  if (code) {
    const r = findByCode(code);
    if (query.phone) {
      const digits = String(query.phone).replace(/\D/g, '').slice(-7);
      if (!r.phone.replace(/\D/g, '').endsWith(digits)) {
        throw new ApiError(403, 'El teléfono no coincide con la reserva.');
      }
    }
    return ok({ reservation: publicReservation(r) });
  }

  const phone = String(query.phone || '').replace(/\D/g, '');
  if (phone.length < 7) bad('Indique el código o un teléfono completo.');
  const matches = db()
    .reservations.filter((r) => r.phone.replace(/\D/g, '').endsWith(phone.slice(-7)))
    .filter((r) => r.date >= todayISO() || ACTIVE_STATUSES.includes(r.status))
    .map(publicReservation);
  if (!matches.length) throw new ApiError(404, 'Ese teléfono no tiene reservas activas.');
  return ok({ reservations: matches });
}

export async function updateReservation({ params, body }) {
  const current = findByCode(params.code);
  const state = db();

  if (body.action === 'cancelar') {
    if (current.status === 'cancelada') return ok({ reservation: publicReservation(current) });
    if (['completada', 'no-show'].includes(current.status)) {
      throw new ApiError(409, 'Esa reserva ya se cerró.');
    }
    await write(() => {
      current.status = 'cancelada';
      current.cancelledAt = new Date().toISOString();
      current.updatedAt = current.cancelledAt;
      current.history.push({ at: current.cancelledAt, action: 'cancelada', by: 'huésped' });
      logEvent({ action: 'reserva-cancelada', code: current.code });
    });
    alCancelar(current);
    // La mesa vuelve a la agenda: a ver si alguien de la lista la quiere.
    evaluarLiberacion({ date: current.date, time: current.time, motivo: 'cancelación' });
    return ok({ reservation: publicReservation(current), message: 'Reserva cancelada. Ojalá en otra ocasión.' });
  }

  if (!ACTIVE_STATUSES.includes(current.status)) {
    throw new ApiError(409, 'Esa reserva ya no se puede modificar en línea.');
  }
  if (daysBetween(todayISO(), current.date) < 0) {
    throw new ApiError(409, 'Esa reserva ya pasó.');
  }

  const date = body.date ?? current.date;
  const time = body.time ?? current.time;
  const party = body.party ? clampParty(body.party) : current.party;
  const zone = body.zone === undefined ? current.zone : ZONES.some((z) => z.id === body.zone) ? body.zone : null;

  if (!isValidISO(date)) bad('Fecha inválida.', { field: 'date' });
  if (!isValidHHMM(time) || !slotExists(date, time)) bad('Ese horario no está en servicio.', { field: 'time' });
  const problem = dateProblem(date);
  if (problem) bad(problem, { field: 'date' });

  const changedSeating = date !== current.date || time !== current.time || party !== current.party || zone !== current.zone;
  let table = TABLES.find((t) => t.id === current.tableId);

  if (changedSeating) {
    const slot = checkSlot({
      date,
      time,
      party,
      zone,
      reservations: state.reservations,
      blocks: state.blocks,
      excludeId: current.id
    });
    if (!slot.ok) {
      throw new ApiError(409, 'No hay mesa para ese cambio.', {
        alternatives: nearbyTimes({ date, time, party, state, excludeId: current.id })
      });
    }
    table = allocate({
      date,
      time,
      party,
      zone,
      reservations: state.reservations,
      blocks: state.blocks,
      excludeId: current.id
    });
  }

  const extras = body.occasion !== undefined || body.preferences || body.notes !== undefined
    ? normalizeExtras({ ...current, ...body })
    : null;

  await write(() => {
    Object.assign(current, {
      date,
      time,
      party,
      zone: table.zone,
      tableId: table.id,
      turnMinutes: turnMinutes(party),
      deposit: party >= RESTAURANT.depositFrom,
      updatedAt: new Date().toISOString()
    });
    if (extras) Object.assign(current, extras);
    current.history.push({ at: current.updatedAt, action: 'modificada', by: 'huésped' });
    logEvent({ action: 'reserva-modificada', code: current.code, date, time, party });
  });

  return ok({ reservation: publicReservation(current), message: 'Listo, actualizamos su reserva.' });
}

export function reservationCalendarFile({ params }) {
  const r = findByCode(params.code);
  return {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="guayacan-${r.code}.ics"`
    },
    body: reservationIcs(r)
  };
}

/* ----------------------------------------------------------- lista de espera */

export async function joinWaitlist({ body }) {
  const guest = normalizeGuest(body);
  const party = clampParty(body.party);
  if (!isValidISO(body.date)) bad('Fecha inválida.', { field: 'date' });

  const entry = {
    id: nextId('ESP'),
    ...guest,
    party,
    date: body.date,
    window: String(body.window || 'cualquiera'),
    // Sin salón quiere decir «me da igual», que es lo que más ayuda a que
    // le salga algo.
    zone: ZONES.some((z) => z.id === body.zone) ? body.zone : null,
    notes: String(body.notes || '').trim().slice(0, 400),
    status: 'esperando',
    offer: null,
    offers: 0,
    createdAt: new Date().toISOString()
  };

  await write((d) => {
    d.waitlist.push(entry);
    logEvent({ action: 'lista-espera', date: entry.date, party });
  });

  return ok(
    {
      entry,
      message: ESPERA.activa
        ? `Quedó en la lista para el ${prettyDate(entry.date)}. Si se suelta una mesa que le sirva, le llega un correo al instante con el botón para tomarla.`
        : `Quedó en la lista para el ${prettyDate(entry.date)}. Le escribimos si se libera una mesa.`
    },
    201
  );
}

/* ------------------------------------------------------------------- panel */

/**
 * El PIN llega en la cabecera; para descargas directas (CSV, que salen por
 * un <a> del navegador y no pueden llevar cabeceras) se acepta en la query.
 */
export function requireAdmin(headers, query = {}) {
  const pin = headers['x-admin-pin'] || query.pin;
  if (pin !== ADMIN_PIN) throw new ApiError(401, 'PIN incorrecto.');
}

export function adminLogin({ body }) {
  if (String(body.pin) !== ADMIN_PIN) throw new ApiError(401, 'PIN incorrecto.');
  return ok({ token: ADMIN_PIN, name: 'Equipo de sala' });
}

export function adminDay({ query }) {
  const date = isValidISO(query.date) ? query.date : todayISO();
  const state = db();
  const services = servicesFor(date);
  const reservations = state.reservations
    .filter((r) => r.date === date)
    .map(publicReservation)
    .sort((a, b) => a.time.localeCompare(b.time));

  const timeline = TABLES.map((table) => ({
    ...table,
    bookings: reservations
      .filter((r) => r.tableId === table.id && ACTIVE_STATUSES.concat('completada', 'no-show').includes(r.status))
      .map((r) => ({
        code: r.code,
        name: r.name,
        party: r.party,
        time: r.time,
        status: r.status,
        start: toMinutes(r.time),
        end: toMinutes(r.time) + (r.turnMinutes || 120),
        occasion: r.occasion
      }))
  }));

  const span = services.length
    ? { open: toMinutes(services[0].open), close: toMinutes(services.at(-1).close) }
    : { open: 660, close: 1380 };

  return ok({
    date,
    prettyDate: prettyDate(date, true),
    weekday: weekday(date),
    open: services.length > 0,
    services,
    span,
    metrics: dayMetrics({ date, reservations: state.reservations }),
    reservations,
    timeline,
    blocks: state.blocks.filter((b) => b.date === date),
    waitlist: state.waitlist.filter((w) => w.date === date && w.status === 'esperando')
  });
}

const VALID_STATUS = new Set(STATUSES.map((s) => s.id));

export async function adminUpdateReservation({ params, body }) {
  const state = db();
  const r = state.reservations.find((x) => x.id === params.id || x.code === params.id);
  if (!r) throw new ApiError(404, 'Reserva no encontrada.');

  const estabaOcupando = ACTIVE_STATUSES.includes(r.status);

  if (body.status !== undefined) {
    if (!VALID_STATUS.has(body.status)) bad('Estado desconocido.');
    r.status = body.status;
  }
  if (body.tableId !== undefined) {
    const table = TABLES.find((t) => t.id === body.tableId);
    if (!table) bad('Mesa desconocida.');
    const free = checkSlot({
      date: r.date,
      time: r.time,
      party: r.party,
      reservations: state.reservations,
      blocks: state.blocks,
      excludeId: r.id
    }).tables;
    if (!free.some((t) => t.id === table.id) && ACTIVE_STATUSES.includes(r.status)) {
      throw new ApiError(409, `La mesa ${table.id} está ocupada en ese turno.`);
    }
    r.tableId = table.id;
    r.zone = table.zone;
  }
  if (body.notes !== undefined) r.notes = String(body.notes).slice(0, 600);
  if (body.time !== undefined && isValidHHMM(body.time)) r.time = body.time;

  await write(() => {
    r.updatedAt = new Date().toISOString();
    r.history.push({ at: r.updatedAt, action: `panel: ${body.status || 'edición'}`, by: 'equipo' });
    logEvent({ action: 'panel-reserva', code: r.code, status: r.status });
  });

  // Si el panel la sacó de circulación —canceló o marcó que no llegó—, esa
  // mesa se soltó de verdad y le toca a la lista de espera.
  if (estabaOcupando && ['cancelada', 'no-show'].includes(r.status)) {
    evaluarLiberacion({ date: r.date, time: r.time, motivo: r.status === 'no-show' ? 'no llegó' : 'cancelación' });
  }

  return ok({ reservation: publicReservation(r) });
}

export async function adminCreateBlock({ body }) {
  if (!isValidISO(body.date)) bad('Fecha inválida.');
  if (!isValidHHMM(body.from) || !isValidHHMM(body.to)) bad('Rango de horas inválido.');
  if (toMinutes(body.to) <= toMinutes(body.from)) bad('La hora final debe ser posterior.');

  const scope = body.scope || 'all';
  const valid = scope === 'all' || ZONES.some((z) => z.id === scope) || TABLES.some((t) => t.id === scope);
  if (!valid) bad('Alcance inválido.');

  const block = {
    id: nextId('BLQ'),
    date: body.date,
    from: body.from,
    to: body.to,
    scope,
    reason: String(body.reason || 'Bloqueo interno').slice(0, 160),
    createdAt: new Date().toISOString()
  };

  const affected = activeOn(db().reservations, block.date).filter((r) => {
    const inScope = scope === 'all' || r.zone === scope || r.tableId === scope;
    const start = toMinutes(r.time);
    return inScope && start < toMinutes(block.to) && toMinutes(block.from) < start + (r.turnMinutes || 120);
  });

  await write((d) => {
    d.blocks.push(block);
    logEvent({ action: 'bloqueo', date: block.date, scope });
  });

  return ok({ block, affected: affected.map((r) => ({ code: r.code, name: r.name, time: r.time })) }, 201);
}

export async function adminDeleteBlock({ params }) {
  const removed = await write((d) => {
    const index = d.blocks.findIndex((b) => b.id === params.id);
    if (index === -1) return null;
    return d.blocks.splice(index, 1)[0];
  });
  if (!removed) throw new ApiError(404, 'Bloqueo no encontrado.');
  return ok({ removed });
}

export function adminStats({ query }) {
  const days = Math.min(Math.max(Number(query.days) || 14, 3), 60);
  const state = db();
  const end = todayISO();
  const series = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = addDays(end, -i);
    const metrics = dayMetrics({ date, reservations: state.reservations });
    series.push({ date, ...metrics, open: isOpen(date) });
  }

  const window = state.reservations.filter((r) => r.date >= addDays(end, -days) && r.date <= end);
  const byZone = ZONES.map((z) => ({
    zone: z.id,
    name: z.name,
    count: window.filter((r) => r.zone === z.id).length
  }));
  const byOccasion = OCCASIONS.map((o) => ({
    occasion: o.id,
    label: o.label,
    count: window.filter((r) => r.occasion === o.id).length
  })).filter((o) => o.count > 0);
  const byHour = {};
  for (const r of window) {
    const hour = r.time.slice(0, 2);
    byHour[hour] = (byHour[hour] || 0) + r.party;
  }

  return ok({
    days,
    series,
    byZone,
    byOccasion,
    byHour: Object.entries(byHour)
      .map(([hour, covers]) => ({ hour, covers }))
      .sort((a, b) => a.hour.localeCompare(b.hour)),
    totals: {
      reservations: window.length,
      covers: window.reduce((s, r) => s + r.party, 0),
      cancelRate: window.length
        ? Math.round((window.filter((r) => r.status === 'cancelada').length / window.length) * 100)
        : 0,
      noShowRate: window.length
        ? Math.round((window.filter((r) => r.status === 'no-show').length / window.length) * 100)
        : 0,
      extras: window.reduce((s, r) => s + estimateTotal(r).extras, 0)
    }
  });
}

export function adminExport({ query }) {
  const from = isValidISO(query.from) ? query.from : addDays(todayISO(), -30);
  const to = isValidISO(query.to) ? query.to : addDays(todayISO(), 30);
  const rows = db().reservations.filter((r) => r.date >= from && r.date <= to);

  const head = [
    'codigo', 'fecha', 'hora', 'personas', 'salon', 'mesa', 'nombre',
    'telefono', 'correo', 'ocasion', 'preferencias', 'experiencias', 'estado', 'origen', 'notas'
  ];
  const csv = [head.join(',')];
  for (const r of rows) {
    csv.push(
      [
        r.code, r.date, r.time, r.party, r.zone, r.tableId, r.name, r.phone, r.email,
        r.occasion, (r.preferences || []).join('|'), (r.experiences || []).join('|'),
        r.status, r.source, r.notes
      ]
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
        .join(',')
    );
  }

  return {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="guayacan-reservas-${from}-a-${to}.csv"`
    },
    body: `﻿${csv.join('\r\n')}\r\n`
  };
}

const ESTADOS_VALIDOS = new Set(ESTADOS_ESPERA.map((e) => e.id));

export async function adminWaitlist({ method, params, body }) {
  if (method === 'GET') {
    return ok({
      waitlist: db().waitlist.slice().reverse(),
      estados: ESTADOS_ESPERA,
      resumen: resumenEspera()
    });
  }
  const entry = db().waitlist.find((w) => w.id === params.id);
  if (!entry) throw new ApiError(404, 'Registro no encontrado.');
  await write(() => {
    // 'avisado' es de la versión anterior, cuando el aviso era una llamada.
    const pedido = body.status === 'avisado' ? 'ofrecida' : body.status;
    entry.status = ESTADOS_VALIDOS.has(pedido) ? pedido : entry.status;
    entry.updatedAt = new Date().toISOString();
  });
  return ok({ entry });
}

/** Ofrecerle una mesa a alguien de la lista, a dedo, desde el panel. */
export async function adminOfferNow({ params, body }) {
  if (!isValidHHMM(body.time)) bad('Indique la hora que le quiere ofrecer.', { field: 'time' });
  const salida = await ofrecerAMano({ entryId: params.id, date: body.date, time: body.time });
  if (!salida.ofreció) throw new ApiError(409, `No se pudo ofrecer: ${salida.porque}.`);
  return ok({ oferta: salida.oferta, message: `Le salió el correo a ${salida.para.name}.` });
}

/* ═════════════════════════════════════════════ la oferta, para el huésped ══ */

/**
 * La pantalla a la que llega desde el correo. No pide PIN ni contraseña: el
 * token del enlace ES la llave, y solo la tiene quien recibió el correo.
 */
export function getOffer({ params }) {
  const vista = verOferta(params.token);
  if (vista.estado === 'no-existe') throw new ApiError(404, 'Ese enlace no corresponde a ninguna oferta.');
  return ok({ oferta: vista });
}

export async function acceptOffer({ params }) {
  const salida = await aceptarOferta(params.token);

  if (salida.estado === 'no-existe') throw new ApiError(404, 'Ese enlace no corresponde a ninguna oferta.');
  if (salida.estado === 'vencida') {
    throw new ApiError(410, 'Se venció el tiempo de esta mesa y se la ofrecimos a quien seguía.');
  }
  if (salida.estado === 'perdida') {
    // El caso de los dos clics a la vez. No se pierde el puesto en la fila.
    throw new ApiError(409, 'Se nos adelantaron por segundos y esa mesa ya quedó tomada. Usted sigue en la lista, en el mismo puesto.');
  }
  if (salida.estado !== 'aceptada') throw new ApiError(409, 'Esta oferta ya se cerró.');

  const r = findByCode(salida.code);
  return ok({
    reservation: publicReservation(r),
    repetida: Boolean(salida.repetida),
    message: cobroDe(r).estado === 'pendiente'
      ? 'La mesa es suya. Queda en firme apenas recibamos el pago.'
      : 'La mesa es suya. Lo esperamos.'
  });
}

export async function declineOffer({ params }) {
  await rechazarOferta(params.token);
  return ok({ message: 'Listo, se la ofrecemos a quien sigue. Gracias por avisar.' });
}

export { ApiError };

/* ══════════════════════════════════════════════════════════════ pagos ══ */

/**
 * Estado del cobro de una reserva. Lo consulta la pantalla de pago.
 */
export function getPayment({ params }) {
  const r = findByCode(params.code);
  const pago = cobroDe(r);
  return ok({
    code: r.code,
    nombre: r.name,
    personas: r.party,
    cuando: `${prettyDate(r.date, true)}, ${prettyTime(r.time)}`,
    estadoReserva: r.status,
    pago,
    metodos: PAGO.metodos,
    abonable: PAGO.abonable,
    simulado: PAGO.modo === 'simulado'
  });
}

/**
 * Paga la reserva. En modo simulado NO se mueve dinero y no se recibe ningún
 * dato de tarjeta: el cliente solo dice con qué método y qué desenlace quiere
 * probar (aprobado o rechazado), como el sandbox de cualquier pasarela.
 *
 * Cuando se conecte una pasarela de verdad, esta función es la que cambia:
 * crea la transacción, redirige al checkout y confirma por webhook. El resto
 * del flujo —estados, recibo, panel— ya queda hecho.
 */
export async function payReservation({ params, body }) {
  if (PAGO.modo !== 'simulado') {
    throw new ApiError(501, 'Solo está habilitado el pago simulado.');
  }

  const r = findByCode(params.code);
  const pago = cobroDe(r);

  if (!pago.requerido) throw new ApiError(409, 'Esta reserva no tiene nada que pagar.');
  if (pago.estado === 'pagado') return ok({ reservation: publicReservation(r), message: 'Ya estaba pagada.' });
  if (['cancelada', 'no-show', 'completada'].includes(r.status)) {
    throw new ApiError(409, 'Esa reserva ya se cerró.');
  }

  const metodo = PAGO.metodos.find((m) => m.id === body.metodo);
  if (!metodo) bad('Escoja un método de pago.', { field: 'metodo' });

  // El desenlace lo pide quien prueba. Por defecto, aprobado.
  const rechazar = body.resultado === 'rechazado';
  const at = new Date().toISOString();
  const referencia = `SIM-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  await write(() => {
    r.pago = {
      ...pago,
      estado: rechazar ? 'rechazado' : 'pagado',
      metodo: metodo.id,
      metodoLabel: metodo.label,
      referencia,
      simulado: true,
      at
    };
    // Pagada, la mesa queda en firme. Rechazada, sigue esperando el pago.
    if (!rechazar) r.status = 'confirmada';
    r.updatedAt = at;
    r.history.push({
      at,
      action: rechazar ? `pago rechazado (${metodo.label})` : `pagado ${pago.monto} por ${metodo.label}`,
      by: 'pasarela simulada'
    });
    logEvent({ action: rechazar ? 'pago-rechazado' : 'pago-recibido', code: r.code, monto: pago.monto, metodo: metodo.id });
  });

  if (rechazar) {
    throw new ApiError(402, `El pago con ${metodo.label} fue rechazado. Intente con otro método.`, {
      reservation: publicReservation(r)
    });
  }

  alPagar(r);

  return ok({
    reservation: publicReservation(r),
    recibo: {
      referencia,
      monto: pago.monto,
      moneda: pago.moneda,
      metodo: metodo.label,
      at,
      code: r.code,
      simulado: true
    },
    message: 'Pago recibido. Su mesa quedó confirmada.'
  });
}

/** El equipo marca el cobro a mano: pagos en efectivo, datáfono o teléfono. */
export async function adminMarkPayment({ params, body }) {
  const state = db();
  const r = state.reservations.find((x) => x.id === params.id || x.code === params.id);
  if (!r) throw new ApiError(404, 'Reserva no encontrada.');

  const estados = ['pendiente', 'pagado', 'rechazado', 'reembolsado', 'no-aplica'];
  if (!estados.includes(body.estado)) bad(`Estado de pago inválido. Use: ${estados.join(', ')}.`);

  const at = new Date().toISOString();
  await write(() => {
    r.pago = {
      ...cobroDe(r),
      estado: body.estado,
      metodo: body.metodo || 'mostrador',
      metodoLabel: body.metodo === 'efectivo' ? 'Efectivo' : 'En el restaurante',
      referencia: cobroDe(r).referencia || `MAN-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      at
    };
    if (body.estado === 'pagado' && r.status === 'pendiente-pago') r.status = 'confirmada';
    r.updatedAt = at;
    r.history.push({ at, action: `cobro marcado como ${body.estado}`, by: 'equipo' });
    logEvent({ action: 'cobro-manual', code: r.code, estado: body.estado });
  });

  return ok({ reservation: publicReservation(r) });
}


/* ═══════════════════════════════════════════════════════ cola de correos ══ */

/** Estado de la cola y la bandeja, para el panel de sala. */
export async function adminMail() {
  return ok({
    cola: await estadoCola(),
    transporte: transporteInfo(),
    bandeja: bandeja(30).map(({ html, ...resto }) => resto)
  });
}

/** El correo armado, tal como le llegaría al huésped. */
export function adminMailOne({ params }) {
  const correo = correoDeLaBandeja(params.id);
  if (!correo) throw new ApiError(404, 'Ese correo ya no está en la bandeja.');
  return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: correo.html };
}

/**
 * La bitácora del día, para leerla desde el panel. En Render el disco es
 * efímero y no hay forma de entrar por SSH, así que esta es la única
 * ventana a lo que pasó.
 */
export function adminLogs({ query }) {
  const dia = query.dia || diaDeHoy();
  const datos = leerDia({
    dia,
    nivel: query.nivel || null,
    buscar: query.buscar || null,
    limite: Math.min(Number(query.limite) || 300, 2000)
  });
  return ok({ ...datos, dias: diasGuardados(), carpeta: LOGS_DIR });
}

/** Reintentar un trabajo fallido. */
export async function adminMailRetry({ params }) {
  try {
    return ok(await reintentar(params.id));
  } catch (err) {
    throw new ApiError(409, err.message);
  }
}
