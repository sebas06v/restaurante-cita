/**
 * ==========================================================================
 * Lista de espera con oferta automática
 * ==========================================================================
 * Antes, la lista de espera era un callejón sin salida: la persona se
 * anotaba y alguien del salón tenía que acordarse de llamarla. Aquí se
 * cierra el círculo.
 *
 * Cuando una mesa se suelta —cancelación, no-show, o alguien que no pagó a
 * tiempo— se busca en la lista a quien le sirva y se le manda un correo con
 * un botón. Tiene un tiempo límite para aceptar. Si no contesta, se le
 * ofrece al que sigue, automático.
 *
 * Tres reglas que este archivo defiende:
 *
 *   1. UNA persona a la vez. Mandarle el mismo correo a cinco es buscarse
 *      el problema de tener que decirle a cuatro que ya no.
 *   2. La mesa NO se aparta mientras la oferta está abierta. Alguien puede
 *      reservarla por la web primero, y eso está bien: lo que no puede pasar
 *      es que dos personas terminen con la misma mesa. Por eso al aceptar se
 *      vuelve a verificar, dentro de una sola escritura.
 *   3. Quien pierde una mesa por milésimas no pierde su puesto en la lista.
 *
 * El tiempo límite es un trabajo retrasado en la cola. Con Redis sobrevive
 * un reinicio del servidor; sin Redis, no. Está avisado en el panel.
 * ==========================================================================
 */

import crypto from 'node:crypto';
import { ESPERA, ZONES, RESTAURANT, PAGO, requierePago } from './config.js';
import { db, write, nextId, makeCode, logEvent } from './db.js';
import { freeTables, checkSlot, turnMinutes, servicesFor } from './availability.js';
import { todayISO, isValidISO, isValidHHMM, toMinutes, prettyDate, prettyTime } from './time.js';

/* ═══════════════════════════════════════════════════════════════ tiempos ══ */

const MINUTO = 60 * 1000;

/** El instante exacto en que empieza un servicio, en hora local. */
const momentoDe = (date, time) => new Date(`${date}T${time}:00`).getTime();

/**
 * Cuánto tiempo le damos para contestar.
 * Hora y media si falta más de un día; media hora si es para hoy o mañana.
 * Nunca más allá del servicio mismo: una oferta que vence cuando el plato ya
 * salió de la cocina no le sirve a nadie.
 */
export function ventanaMs(date, time, ahora = Date.now()) {
  const servicio = momentoDe(date, time);
  const faltan = servicio - ahora;
  const base = (faltan > ESPERA.umbralHoras * 3600 * 1000 ? ESPERA.ventanaLargaMin : ESPERA.ventanaCortaMin) * MINUTO;
  const tope = faltan - ESPERA.margenAntesDelServicioMin * MINUTO;
  return Math.min(base, tope);
}

/** A qué franja del día pertenece una hora: almuerzo o cena. */
export function franjaDe(date, time) {
  const m = toMinutes(time);
  const servicio = servicesFor(date).find((s) => m >= toMinutes(s.open) && m <= toMinutes(s.close));
  return servicio ? servicio.id : null;
}

/* ═════════════════════════════════════════════════════════════ candidatos ══ */

/**
 * ¿A esta persona le sirve lo que se soltó?
 * Mismo día, la franja que pidió, y el salón que pidió (o le da igual).
 * El tamaño del grupo no se compara aquí: se comprueba de verdad buscándole
 * mesa, que es lo único que no miente.
 */
function leSirve(entry, { date, franja }) {
  if (entry.status !== 'esperando') return false;
  if (entry.date !== date) return false;
  if (!entry.email) return false;
  if (entry.window && entry.window !== 'cualquiera' && franja && entry.window !== franja) return false;
  return true;
}

/** Le busca mesa a esta persona en ese horario. Null si no hay. */
function mesaPara(entry, { date, time, state }) {
  const { kitchenFull } = checkSlot({
    date,
    time,
    party: entry.party,
    reservations: state.reservations,
    blocks: state.blocks
  });
  if (kitchenFull) return null;

  // Si pidió un salón, es ese o ninguno: no se le cambia por debajo.
  const libres = freeTables({
    date,
    time,
    party: entry.party,
    zone: entry.zone || null,
    reservations: state.reservations,
    blocks: state.blocks
  });
  return libres[0] || null;
}

/**
 * El siguiente de la fila que además tenga mesa. Gana el que lleva más
 * tiempo esperando; sin fórmulas ni puntajes.
 */
export function siguienteCandidato({ date, time, state = db(), excluir = [] }) {
  const franja = franjaDe(date, time);
  const fila = state.waitlist
    .filter((e) => leSirve(e, { date, franja }) && !excluir.includes(e.id))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  for (const entry of fila) {
    const mesa = mesaPara(entry, { date, time, state });
    if (mesa) return { entry, mesa };
  }
  return null;
}

/** ¿Ya hay una oferta viva para ese mismo horario? Solo una a la vez. */
function ofertaAbiertaEn(date, time, state = db()) {
  return state.waitlist.find(
    (e) => e.status === 'ofrecida' && e.offer && e.offer.date === date && e.offer.time === time
  );
}

/* ══════════════════════════════════════════════════════════════ ofrecer ══ */

/**
 * Se soltó una mesa: busca a quién ofrecérsela y le manda el correo.
 * Devuelve la oferta creada, o null con el motivo por el que no hubo.
 *
 * Es seguro llamarla de más: si no hay nadie, o si la hora ya pasó, no hace
 * nada y no manda ningún correo.
 */
export async function evaluarLiberacion({ date, time, motivo = 'liberacion', excluir = [] }) {
  if (!ESPERA.activa) return { ofreció: false, porque: 'mecanismo apagado' };
  if (!isValidISO(date) || !isValidHHMM(time)) return { ofreció: false, porque: 'horario inválido' };
  if (date < todayISO()) return { ofreció: false, porque: 'ya pasó' };

  const ventana = ventanaMs(date, time);
  if (ventana <= 0) return { ofreció: false, porque: 'demasiado sobre la hora' };

  if (ofertaAbiertaEn(date, time)) return { ofreció: false, porque: 'ya hay una oferta abierta en ese horario' };

  const elegido = siguienteCandidato({ date, time, excluir });
  if (!elegido) return { ofreció: false, porque: 'nadie en la lista calza con ese horario' };

  try {
    return await crearOferta({ entry: elegido.entry, mesa: elegido.mesa, date, time, ventana, motivo });
  } catch (err) {
    // Se le adelantó otra oferta a esa misma persona entre el filtro y la
    // escritura. Se intenta con el siguiente, una sola vez.
    console.error(`[espera] no pude ofrecer a ${elegido.entry.id}: ${err.message}`);
    return { ofreció: false, porque: err.message };
  }
}

/** Arma la oferta, la guarda y encola el correo y su vencimiento. */
async function crearOferta({ entry, mesa, date, time, ventana, motivo }) {
  const at = new Date().toISOString();
  const oferta = {
    id: nextId('OFR'),
    // Token largo y aleatorio: el enlace del correo es la llave. No se puede
    // adivinar y no hace falta firmar nada.
    token: crypto.randomBytes(24).toString('base64url'),
    date,
    time,
    zone: mesa.zone,
    tableId: mesa.id,
    party: entry.party,
    monto: requierePago(entry.party) ? PAGO.monto : 0,
    motivo,
    at,
    venceAt: new Date(Date.now() + ventana).toISOString(),
    resultado: null,
    reservationCode: null
  };

  await write(() => {
    // Se relee de la lista viva: entre el filtro y esta escritura pudo
    // cambiar de estado.
    const vivo = db().waitlist.find((e) => e.id === entry.id);
    if (!vivo || vivo.status !== 'esperando') throw new Error('Esa persona ya no está esperando.');
    vivo.status = 'ofrecida';
    vivo.offer = oferta;
    vivo.offers = (vivo.offers || 0) + 1;
    vivo.updatedAt = at;
    logEvent({ action: 'espera-ofrecida', entry: entry.id, date, time, motivo });
  });

  const { encolarOferta, programarVencimientoOferta } = await import('./queue/correos.js');
  await encolarOferta({ tipo: 'oferta', entryId: entry.id, offerId: oferta.id });
  await programarVencimientoOferta({ entryId: entry.id, offerId: oferta.id, delay: ventana });

  return { ofreció: true, oferta, para: { id: entry.id, name: entry.name, email: entry.email } };
}

/** Ofrecer a alguien concreto desde el panel, sin esperar a que se libere nada. */
export async function ofrecerAMano({ entryId, date, time }) {
  const state = db();
  const entry = state.waitlist.find((e) => e.id === entryId);
  if (!entry) return { ofreció: false, porque: 'no existe ese registro' };
  if (entry.status !== 'esperando') return { ofreció: false, porque: `esa persona está en estado ${entry.status}` };

  const cuando = { date: date || entry.date, time };
  if (!isValidHHMM(cuando.time)) return { ofreció: false, porque: 'indique la hora' };
  if (ofertaAbiertaEn(cuando.date, cuando.time, state)) {
    return { ofreció: false, porque: 'ya hay una oferta abierta en ese horario' };
  }

  const ventana = ventanaMs(cuando.date, cuando.time);
  if (ventana <= 0) return { ofreció: false, porque: 'demasiado sobre la hora' };

  const mesa = mesaPara(entry, { ...cuando, state });
  if (!mesa) return { ofreció: false, porque: 'no hay mesa libre en ese horario' };

  return crearOferta({ entry, mesa, ...cuando, ventana, motivo: 'a mano' });
}

/* ══════════════════════════════════════════════════════════════ aceptar ══ */

/** Busca a quién pertenece un token, sin filtrar cuál existe y cuál no. */
function porToken(token) {
  const limpio = String(token || '');
  if (limpio.length < 16) return null;
  return (
    db().waitlist.find((e) => {
      const suyo = e.offer && e.offer.token;
      if (!suyo || suyo.length !== limpio.length) return false;
      return crypto.timingSafeEqual(Buffer.from(suyo), Buffer.from(limpio));
    }) || null
  );
}

const vencida = (offer) => Date.parse(offer.venceAt) <= Date.now();

/** Lo que ve la pantalla a la que llega el huésped desde el correo. */
export function verOferta(token) {
  const entry = porToken(token);
  if (!entry) return { estado: 'no-existe' };
  const o = entry.offer;
  const zona = ZONES.find((z) => z.id === o.zone);

  const base = {
    nombre: entry.name.split(' ')[0],
    personas: entry.party,
    date: o.date,
    time: o.time,
    cuando: `${prettyDate(o.date, true)}, ${prettyTime(o.time)}`,
    salon: zona ? zona.name : 'Salón por asignar',
    monto: o.monto,
    moneda: PAGO.moneda,
    venceAt: o.venceAt,
    code: o.reservationCode
  };

  if (entry.status === 'aceptada') return { ...base, estado: 'aceptada' };
  if (o.resultado === 'perdida') return { ...base, estado: 'perdida' };
  if (entry.status === 'ofrecida' && vencida(o)) return { ...base, estado: 'vencida' };
  if (entry.status === 'ofrecida') return { ...base, estado: 'abierta' };
  if (entry.status === 'vencida') return { ...base, estado: 'vencida' };
  return { ...base, estado: 'cerrada' };
}

/**
 * Acepta la oferta y crea la reserva.
 *
 * Todo lo delicado pasa dentro de una sola escritura, y write() serializa:
 * si dos personas le dan clic al mismo tiempo, o si alguien reservó esa mesa
 * por la web hace diez segundos, la segunda comprobación lo ve y solo una
 * reserva sale. Quien la pierde vuelve a 'esperando' sin perder su puesto.
 */
export async function aceptarOferta(token) {
  const entry = porToken(token);
  if (!entry) return { estado: 'no-existe' };

  // Idempotente: recargar la página después de aceptar no crea otra reserva.
  if (entry.status === 'aceptada' && entry.offer.reservationCode) {
    return { estado: 'aceptada', code: entry.offer.reservationCode, repetida: true };
  }
  if (entry.status !== 'ofrecida') return { estado: 'cerrada' };

  const salida = await write((d) => {
    const vivo = d.waitlist.find((e) => e.id === entry.id);
    if (!vivo || vivo.status !== 'ofrecida') return { estado: 'cerrada' };

    const o = vivo.offer;
    if (vencida(o)) {
      vivo.status = 'vencida';
      o.resultado = 'vencida';
      vivo.updatedAt = new Date().toISOString();
      return { estado: 'vencida' };
    }

    // La comprobación que lo sostiene todo: ¿la mesa sigue libre AHORA?
    const mesa = mesaPara(vivo, { date: o.date, time: o.time, state: d });
    if (!mesa) {
      // Vuelve a la fila sin perder su puesto: createdAt no se toca.
      vivo.status = 'esperando';
      o.resultado = 'perdida';
      vivo.updatedAt = new Date().toISOString();
      logEvent({ action: 'espera-perdida', entry: vivo.id, date: o.date, time: o.time });
      return { estado: 'perdida' };
    }

    const at = new Date().toISOString();
    const requiere = requierePago(vivo.party);
    const reserva = {
      id: nextId('RES'),
      code: makeCode(d.reservations),
      date: o.date,
      time: o.time,
      party: vivo.party,
      zone: mesa.zone,
      tableId: mesa.id,
      turnMinutes: turnMinutes(vivo.party),
      name: vivo.name,
      phone: vivo.phone,
      email: vivo.email,
      occasion: 'ninguna',
      preferences: [],
      experiences: [],
      notes: vivo.notes || '',
      // Venir de la lista de espera no exime de pagar: entra por la misma
      // puerta que todo el mundo.
      status: requiere ? 'pendiente-pago' : 'confirmada',
      pago: {
        requerido: requiere,
        monto: requiere ? PAGO.monto : 0,
        moneda: PAGO.moneda,
        estado: requiere ? 'pendiente' : 'no-aplica',
        metodo: null,
        referencia: null,
        simulado: PAGO.modo === 'simulado',
        at: null
      },
      source: 'lista-espera',
      deposit: vivo.party >= RESTAURANT.depositFrom,
      createdAt: at,
      updatedAt: at,
      history: [{ at, action: 'creada desde la lista de espera', by: 'huésped' }]
    };

    d.reservations.push(reserva);
    d.reservations.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

    vivo.status = 'aceptada';
    o.resultado = 'aceptada';
    o.reservationCode = reserva.code;
    o.aceptadaAt = at;
    vivo.updatedAt = at;

    logEvent({ action: 'espera-aceptada', entry: vivo.id, code: reserva.code, date: o.date, time: o.time });
    return { estado: 'aceptada', reserva };
  });

  if (salida.estado === 'aceptada' && salida.reserva) {
    const { alReservar, programarVencimientoPago } = await import('./queue/correos.js');
    await alReservar(salida.reserva);
    // Mismo reloj que la oferta: si no paga, la mesa se suelta y le toca al
    // que sigue.
    await programarVencimientoPago(salida.reserva);
    return { estado: 'aceptada', code: salida.reserva.code, reserva: salida.reserva };
  }

  if (salida.estado === 'vencida') await cerrarYSeguir(entry.id, 'vencida');
  // 'perdida' vuelve a la fila: se reevalúa por si hay otro horario suelto.
  return salida;
}

/** «No puedo»: se cierra y la mesa se le ofrece al que sigue. */
export async function rechazarOferta(token) {
  const entry = porToken(token);
  if (!entry || entry.status !== 'ofrecida') return { estado: 'cerrada' };

  const o = entry.offer;
  await write((d) => {
    const vivo = d.waitlist.find((e) => e.id === entry.id);
    if (!vivo || vivo.status !== 'ofrecida') return;
    vivo.status = 'cerrado';
    vivo.offer.resultado = 'rechazada';
    vivo.updatedAt = new Date().toISOString();
    logEvent({ action: 'espera-rechazada', entry: vivo.id });
  });

  await evaluarLiberacion({ date: o.date, time: o.time, motivo: 'rechazo', excluir: [entry.id] });
  return { estado: 'rechazada' };
}

/* ═════════════════════════════════════════════════════════════ vencer ══ */

/**
 * Se acabó el tiempo. Lo corre la cola como trabajo retrasado.
 * Cierra a quien no contestó, le avisa, y le ofrece al que sigue.
 */
export async function vencerOferta({ entryId, offerId }) {
  const entry = db().waitlist.find((e) => e.id === entryId);
  if (!entry || entry.status !== 'ofrecida' || !entry.offer || entry.offer.id !== offerId) {
    return { saltado: 'la oferta ya se resolvió' };
  }
  const o = entry.offer;

  await write((d) => {
    const vivo = d.waitlist.find((e) => e.id === entryId);
    if (!vivo || vivo.status !== 'ofrecida' || vivo.offer.id !== offerId) return;
    vivo.status = 'vencida';
    vivo.offer.resultado = 'vencida';
    vivo.updatedAt = new Date().toISOString();
    logEvent({ action: 'espera-vencida', entry: entryId, date: o.date, time: o.time });
  });

  await cerrarYSeguir(entryId, 'vencida');
  return { vencida: entryId, date: o.date, time: o.time };
}

/**
 * Le avisa a quien se quedó por fuera y le ofrece al siguiente.
 * El correo de cierre no es un adorno: una oferta que llega y se apaga en
 * silencio se siente peor que no haber estado en la lista.
 */
async function cerrarYSeguir(entryId, motivo) {
  const entry = db().waitlist.find((e) => e.id === entryId);
  if (!entry || !entry.offer) return;

  const { encolarOferta } = await import('./queue/correos.js');
  await encolarOferta({ tipo: 'oferta-cerrada', entryId, offerId: entry.offer.id, motivo });
  await evaluarLiberacion({
    date: entry.offer.date,
    time: entry.offer.time,
    motivo: 'siguiente en la fila',
    excluir: [entryId]
  });
}

/* ══════════════════════════════════════════════════════════ no pagó ══ */

/**
 * Pasó el tiempo de pagar. Si sigue sin pagar, la mesa se suelta y arranca
 * el ciclo de ofertas. Lo corre la cola.
 */
export async function vencerPago({ code }) {
  const r = db().reservations.find((x) => x.code === code);
  if (!r) return { saltado: 'la reserva ya no existe' };
  if (r.status !== 'pendiente-pago') return { saltado: `estado ${r.status}` };

  const at = new Date().toISOString();
  await write(() => {
    r.status = 'cancelada';
    r.cancelledAt = at;
    r.updatedAt = at;
    r.pago = { ...(r.pago || {}), estado: 'vencido' };
    r.history.push({ at, action: 'liberada por falta de pago', by: 'sistema' });
    logEvent({ action: 'pago-vencido', code: r.code, date: r.date, time: r.time });
  });

  const { encolar } = await import('./queue/correos.js');
  await encolar('cancelacion', r.code);
  const oferta = await evaluarLiberacion({ date: r.date, time: r.time, motivo: 'no pagó a tiempo' });
  return { liberada: r.code, oferta };
}

/* ═══════════════════════════════════════════════════════ para el panel ══ */

export function resumenEspera() {
  const lista = db().waitlist;
  const cuenta = (id) => lista.filter((e) => e.status === id).length;
  return {
    activa: ESPERA.activa,
    ventanaLargaMin: ESPERA.ventanaLargaMin,
    ventanaCortaMin: ESPERA.ventanaCortaMin,
    minutosParaPagar: ESPERA.minutosParaPagar,
    esperando: cuenta('esperando'),
    ofrecidas: cuenta('ofrecida'),
    aceptadas: cuenta('aceptada'),
    vencidas: cuenta('vencida')
  };
}
