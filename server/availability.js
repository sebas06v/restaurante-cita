/**
 * Motor de disponibilidad. Funciones puras: reciben el estado y devuelven
 * horarios, mesas y asignaciones. No toca disco ni HTTP, así que se puede
 * probar y razonar por separado.
 */
import {
  RESTAURANT,
  SERVICE_HOURS,
  CLOSED_DATES,
  TURN_MINUTES,
  TABLES,
  ZONES,
  ACTIVE_STATUSES
} from './config.js';
import { toMinutes, toHHMM, weekday, todayISO, nowMinutes, daysBetween } from './time.js';

/** Minutos de mesa que consume un grupo de N personas. */
export function turnMinutes(party) {
  return (TURN_MINUTES.find((t) => party <= t.upTo) || TURN_MINUTES.at(-1)).minutes;
}

export function servicesFor(dateIso) {
  if (CLOSED_DATES.includes(dateIso)) return [];
  return SERVICE_HOURS[weekday(dateIso)] || [];
}

export function isOpen(dateIso) {
  return servicesFor(dateIso).length > 0;
}

/** Motivo por el cual una fecha no admite reservas, o null si sí admite. */
export function dateProblem(dateIso) {
  const today = todayISO();
  const delta = daysBetween(today, dateIso);
  if (delta < 0) return 'Esa fecha ya pasó.';
  if (delta > RESTAURANT.bookingWindowDays) {
    return `Abrimos la agenda con ${RESTAURANT.bookingWindowDays} días de anticipación.`;
  }
  if (CLOSED_DATES.includes(dateIso)) return 'Cerramos por festivo.';
  if (!isOpen(dateIso)) return 'Los lunes descansamos.';
  return null;
}

const overlap = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

export function activeOn(reservations, dateIso) {
  return reservations.filter((r) => r.date === dateIso && ACTIVE_STATUSES.includes(r.status));
}

function blocksOn(blocks, dateIso) {
  return (blocks || []).filter((b) => b.date === dateIso);
}

function tableBlocked(table, startMin, endMin, dayBlocks) {
  return dayBlocks.some((b) => {
    const scopeHits = b.scope === 'all' || b.scope === table.zone || b.scope === table.id;
    if (!scopeHits) return false;
    return overlap(startMin, endMin, toMinutes(b.from), toMinutes(b.to));
  });
}

/** Mesas que físicamente pueden recibir a N personas. */
export function fittingTables(party, zoneId = null) {
  return TABLES.filter((t) => party >= t.min && party <= t.max && (!zoneId || t.zone === zoneId));
}

/**
 * Mesas libres para un horario concreto, ordenadas por mejor ajuste
 * (primero la que desperdicia menos puestos).
 */
export function freeTables({ date, time, party, zone = null, reservations, blocks, excludeId = null }) {
  const start = toMinutes(time);
  const end = start + turnMinutes(party);
  const day = activeOn(reservations, date).filter((r) => r.id !== excludeId);
  const dayBlocks = blocksOn(blocks, date);

  return fittingTables(party, zone)
    .filter((table) => {
      if (tableBlocked(table, start, end, dayBlocks)) return false;
      return !day.some((r) => {
        if (r.tableId !== table.id) return false;
        const rStart = toMinutes(r.time);
        return overlap(start, end, rStart, rStart + (r.turnMinutes || turnMinutes(r.party)));
      });
    })
    .sort((a, b) => a.max - b.max || a.id.localeCompare(b.id));
}

/** Cubiertos que entran a cocina en la ventana de media hora alrededor de `time`. */
function coversStartingNear({ date, time, reservations, excludeId = null }) {
  const t = toMinutes(time);
  return activeOn(reservations, date)
    .filter((r) => r.id !== excludeId && Math.abs(toMinutes(r.time) - t) < 30)
    .reduce((sum, r) => sum + r.party, 0);
}

/** Un horario concreto: ¿cabe este grupo? */
export function checkSlot({ date, time, party, zone = null, reservations, blocks, excludeId = null }) {
  const tables = freeTables({ date, time, party, zone, reservations, blocks, excludeId });
  const covers = coversStartingNear({ date, time, reservations, excludeId });
  const kitchenFull = covers + party > RESTAURANT.maxCoversPerSlot;
  return {
    ok: tables.length > 0 && !kitchenFull,
    tables,
    kitchenFull,
    covers
  };
}

/** Malla de horarios de un servicio, respetando la última entrada. */
function slotsOfService(service) {
  const out = [];
  const last = toMinutes(service.lastSeating);
  for (let m = toMinutes(service.open); m <= last; m += RESTAURANT.slotMinutes) out.push(toHHMM(m));
  return out;
}

/**
 * Disponibilidad completa de un día para un tamaño de grupo.
 * Devuelve los servicios con su malla de horarios y, por horario,
 * el estado y los salones con mesa libre.
 */
export function dayAvailability({ date, party, reservations, blocks, excludeId = null }) {
  const problem = dateProblem(date);
  const services = servicesFor(date);
  const isToday = date === todayISO();
  const cutoff = nowMinutes() + RESTAURANT.minLeadMinutes;

  const payload = services.map((service) => {
    const slots = slotsOfService(service).map((time) => {
      const tooLate = isToday && toMinutes(time) < cutoff;
      const { tables, kitchenFull } = checkSlot({
        date,
        time,
        party,
        reservations,
        blocks,
        excludeId
      });
      const zonesFree = [...new Set(tables.map((t) => t.zone))];
      let status = 'free';
      if (tooLate) status = 'pasado';
      else if (kitchenFull) status = 'cocina';
      else if (tables.length === 0) status = 'lleno';
      else if (tables.length <= 2) status = 'ultimas';
      return { time, status, tables: tables.length, zones: zonesFree };
    });
    const open = slots.filter((s) => s.status === 'free' || s.status === 'ultimas');
    return {
      ...service,
      slots,
      openCount: open.length,
      firstOpen: open[0]?.time ?? null
    };
  });

  return { date, party, problem, services: payload };
}

/**
 * Estado de todas las mesas para un horario: alimenta el plano del salón,
 * tanto en la reserva del cliente como en el panel del equipo.
 */
export function floorState({ date, time, party = null, reservations, blocks, excludeId = null }) {
  const start = toMinutes(time);
  const end = start + turnMinutes(party || 2);
  const day = activeOn(reservations, date).filter((r) => r.id !== excludeId);
  const dayBlocks = blocksOn(blocks, date);

  const tables = TABLES.map((table) => {
    const taken = day.find((r) => {
      if (r.tableId !== table.id) return false;
      const rStart = toMinutes(r.time);
      return overlap(start, end, rStart, rStart + (r.turnMinutes || turnMinutes(r.party)));
    });
    const blocked = tableBlocked(table, start, end, dayBlocks);
    let status = 'libre';
    if (blocked) status = 'bloqueada';
    else if (taken) status = 'ocupada';
    else if (party && (party < table.min || party > table.max)) status = 'no-aplica';

    return {
      ...table,
      status,
      reservation: taken
        ? {
            id: taken.id,
            code: taken.code,
            name: taken.name,
            party: taken.party,
            time: taken.time,
            status: taken.status,
            occasion: taken.occasion
          }
        : null
    };
  });

  const zones = ZONES.map((zone) => {
    const inZone = tables.filter((t) => t.zone === zone.id);
    return {
      ...zone,
      tables: inZone,
      free: inZone.filter((t) => t.status === 'libre').length,
      available: inZone.some((t) => t.status === 'libre')
    };
  });

  return { date, time, party, zones };
}

/** Elige la mejor mesa disponible. Respeta el salón pedido si se puede. */
export function allocate({ date, time, party, zone = null, reservations, blocks, excludeId = null }) {
  const preferred = zone
    ? freeTables({ date, time, party, zone, reservations, blocks, excludeId })
    : [];
  if (preferred.length) return preferred[0];
  const any = freeTables({ date, time, party, reservations, blocks, excludeId });
  return any[0] || null;
}

/** Ocupación del día: para los indicadores del panel. */
export function dayMetrics({ date, reservations }) {
  const day = reservations.filter((r) => r.date === date);
  // Cuenta lo que ocupó (o va a ocupar) mesa: incluye servicios ya cerrados.
  const held = day.filter((r) => !['cancelada', 'no-show'].includes(r.status));
  const seats = TABLES.reduce((sum, t) => sum + t.max, 0);
  const covers = held.reduce((sum, r) => sum + r.party, 0);
  const services = servicesFor(date);
  // Aforo disponible = puestos x servicios del día (un turno por servicio).
  const capacity = seats * Math.max(1, services.length);

  // Plata del día: lo cobrado y lo que falta por cobrar.
  const cobros = held.map((r) => r.pago).filter((p) => p && p.requerido);
  const cobrado = cobros.filter((p) => p.estado === 'pagado').reduce((s, p) => s + p.monto, 0);
  const porCobrar = cobros.filter((p) => p.estado !== 'pagado').reduce((s, p) => s + p.monto, 0);

  return {
    date,
    total: day.length,
    covers,
    cobrado,
    porCobrar,
    sinPagar: day.filter((r) => r.status === 'pendiente-pago').length,
    seats,
    byStatus: day.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {}),
    occupancy: Math.min(100, Math.round((covers / capacity) * 100)),
    noShowRate: day.length ? Math.round((day.filter((r) => r.status === 'no-show').length / day.length) * 100) : 0,
    averageParty: held.length ? Math.round((covers / held.length) * 10) / 10 : 0
  };
}
