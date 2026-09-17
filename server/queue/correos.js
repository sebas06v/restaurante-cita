/**
 * ==========================================================================
 * La cola de correos
 * ==========================================================================
 * Mandar un correo no puede bloquear la respuesta de una reserva: el huésped
 * no tiene por qué esperar a que un servidor SMTP conteste, ni perder la
 * mesa porque el proveedor de correo se cayó. Se encola y se responde.
 *
 * Con REDIS_URL corre BullMQ de verdad: reintentos con backoff, trabajos
 * retrasados que sobreviven a un reinicio, y los fallidos guardados para
 * revisarlos.
 *
 * Sin REDIS_URL cae a una cola en memoria con la misma interfaz, para que
 * la app arranque sin instalar nada. Esa versión NO sobrevive a un
 * reinicio: es justo lo que Redis viene a resolver, y por eso el panel lo
 * dice en letra grande.
 *
 * El worker corre dentro del mismo proceso web. En Render, un Background
 * Worker aparte es de pago, y para este volumen no hace falta.
 * ==========================================================================
 */

import { render } from '../mail/plantillas.js';
import { enviar, MODO as MODO_CORREO } from '../mail/transporte.js';
import { db, logEvent } from '../db.js';
import { ESPERA } from '../config.js';
import { todayISO } from '../time.js';

const NOMBRE = 'correos-guayacan';
const REDIS_URL = process.env.REDIS_URL || '';

/** Cuánto antes de la reserva sale el recordatorio. */
const HORAS_ANTES = Number(process.env.GUAYACAN_RECORDATORIO_HORAS) || 24;

const OPCIONES = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 100 }
};

let cola = null;
let worker = null;
let clientes = [];

/**
 * Un identificador de trabajo que BullMQ acepte: rechaza los dos puntos,
 * y las horas los llevan. Sirve para no encolar dos veces lo mismo.
 */
const idDeTrabajo = (...partes) => partes.join('-').replace(/:/g, '');

/** Un error de Redis se dice una vez por fuente, no cuarenta veces. */
const quejas = new Set();
function quejarse(de, err) {
  const clave = `${de}:${err.message}`;
  if (quejas.has(clave)) return;
  quejas.add(clave);
  console.error(`[correos] ${de}: ${err.message}`);
}
let modo = 'memoria';
let arrancada = false;

/* ═══════════════════════════════════════════════ el trabajo, sea quien sea */

/**
 * Lo que hace un trabajo. Es la misma función en los dos modos, así que
 * cambiar de cola no cambia el comportamiento.
 */
async function procesar(datos) {
  const { tipo, code } = datos;

  // Los trabajos de la lista de espera no cuelgan de una reserva. Se cargan
  // con import() para no amarrar este archivo con espera.js en un ciclo.
  if (TRABAJOS_ESPERA.has(tipo)) return procesarEspera(datos);

  const reservation = db().reservations.find((r) => r.code === code);
  if (!reservation) {
    // La reserva ya no existe: no es un fallo, no hay nada que mandar.
    return { saltado: 'la reserva ya no existe' };
  }

  // Un recordatorio de algo cancelado sería una metida de pata.
  if (tipo === 'recordatorio' && !['confirmada', 'pendiente', 'sentada'].includes(reservation.status)) {
    return { saltado: `estado ${reservation.status}` };
  }

  const correo = render(tipo, reservation);
  const salida = await enviar(correo);

  logEvent({ action: 'correo-enviado', tipo, code, via: salida.via });
  return salida;
}

/* ═════════════════════════════════════════════ trabajos de lista de espera */

const TRABAJOS_ESPERA = new Set(['oferta', 'oferta-cerrada', 'vencer-oferta', 'vencer-pago']);

async function procesarEspera({ tipo, entryId, offerId, code }) {
  const espera = await import('../espera.js');

  // Estos dos no mandan correo: mueven el estado y encolan lo que siga.
  if (tipo === 'vencer-oferta') return espera.vencerOferta({ entryId, offerId });
  if (tipo === 'vencer-pago') return espera.vencerPago({ code });

  const entry = db().waitlist.find((e) => e.id === entryId);
  if (!entry || !entry.offer || entry.offer.id !== offerId) {
    // La oferta se resolvió por otro lado: mandar el correo ahora sería
    // contarle al huésped algo que ya no es cierto.
    return { saltado: 'la oferta ya no está vigente' };
  }

  const { renderEspera } = await import('../mail/plantillas.js');
  const correo = renderEspera(tipo, entry);
  const salida = await enviar(correo);

  logEvent({ action: 'correo-enviado', tipo, code: entry.offer.id, via: salida.via });
  return salida;
}

/* ═══════════════════════════════════════════════ cola de respaldo, sin Redis */

/**
 * Misma interfaz que BullMQ, en memoria. Reintenta con el mismo backoff,
 * pero lo pendiente se pierde al reiniciar: es un respaldo, no un sustituto.
 */
// setTimeout guarda el retraso en 32 bits: pasado ese tope se desborda y
// dispara de inmediato. Un recordatorio a 26 días salía al instante.
const TOPE_TIMEOUT = 2 ** 31 - 1;

/** Espera larga, en tramos que sí caben. */
function esperarLargo(ms, hacer) {
  if (ms <= TOPE_TIMEOUT) return setTimeout(hacer, ms).unref?.();
  return setTimeout(() => esperarLargo(ms - TOPE_TIMEOUT, hacer), TOPE_TIMEOUT).unref?.();
}

const memoria = {
  pendientes: new Map(),
  hechos: 0,
  fallidos: [],

  async add(tipo, datos, opts = {}) {
    const id = `mem-${Math.random().toString(36).slice(2, 9)}`;
    const correr = async (intento = 1) => {
      this.pendientes.delete(id);
      try {
        await procesar(datos);
        this.hechos += 1;
      } catch (err) {
        if (intento < OPCIONES.attempts && !err.permanente) {
          const espera = OPCIONES.backoff.delay * 2 ** (intento - 1);
          this.pendientes.set(id, { datos, at: Date.now() + espera });
          setTimeout(() => correr(intento + 1), espera).unref?.();
        } else {
          this.fallidos.unshift({ id, datos, error: err.message, at: new Date().toISOString() });
          this.fallidos.length = Math.min(this.fallidos.length, 50);
        }
      }
    };

    const retraso = opts.delay || 0;
    this.pendientes.set(id, { datos, at: Date.now() + retraso });
    esperarLargo(retraso, () => correr());
    return { id };
  },

  async counts() {
    return {
      waiting: [...this.pendientes.values()].filter((j) => j.at <= Date.now()).length,
      delayed: [...this.pendientes.values()].filter((j) => j.at > Date.now()).length,
      completed: this.hechos,
      failed: this.fallidos.length,
      active: 0
    };
  }
};

/* ══════════════════════════════════════════════════════════════ arranque */

export async function iniciarCola() {
  if (arrancada) return modo;
  arrancada = true;

  if (!REDIS_URL) {
    modo = 'memoria';
    return modo;
  }

  try {
    const { Queue, Worker } = await import('bullmq');
    const { default: IORedis } = await import('ioredis');

    // La URL hay que dársela a ioredis como cadena: dentro del objeto de
    // opciones la ignora y se va a localhost sin clave ni TLS. Y cada cliente
    // es suyo: el worker bloquea su conexión esperando trabajos, así que
    // compartirla dejaría a la cola sin poder hablar.
    const cliente = () => {
      const c = new IORedis(REDIS_URL, {
        maxRetriesPerRequest: null, // lo exige BullMQ
        enableReadyCheck: false, // Upstash y compañía no contestan INFO
        // Se rinde a los ~15 s. Sin tope, una URL mala reintenta para
        // siempre y llena la consola de ECONNREFUSED.
        retryStrategy: (intento) => (intento > 6 ? null : Math.min(intento * 500, 3000))
      });
      // ioredis sin este manejador lanza el error suelto y ensucia la salida
      // con un stack crudo. Basta con decirlo una vez.
      c.on('error', (err) => quejarse('Redis', err));
      return c;
    };

    clientes = [cliente(), cliente()];
    cola = new Queue(NOMBRE, { connection: clientes[0], defaultJobOptions: OPCIONES });
    worker = new Worker(NOMBRE, async (job) => procesar(job.data), {
      connection: clientes[1],
      concurrency: 4
    });

    worker.on('failed', (job, err) => {
      console.error(`[correos] falló ${job?.data?.tipo} de ${job?.data?.code}: ${err.message}`);
    });
    // Sin manejador, BullMQ deja escapar el error de sus conexiones internas
    // y Node lo imprime como stack crudo.
    worker.on('error', (err) => quejarse('worker', err));
    cola.on('error', (err) => quejarse('cola', err));

    // Que no se quede colgado si Redis no responde: se prueba la conexión,
    // con un tope. Sin esto, una URL mala deja el arranque esperando para
    // siempre y la app nunca contesta.
    await Promise.race([
      cola.waitUntilReady(),
      new Promise((_, no) => setTimeout(() => no(new Error('no contestó en 10 s')), 10000).unref?.())
    ]);
    modo = 'bullmq';
  } catch (err) {
    console.error(`[correos] no se pudo conectar a Redis (${err.message}); sigo en memoria.`);
    // Primero se calla el worker, que es el que reintenta; después los
    // clientes. Al revés, el worker vuelve a abrir conexión.
    await worker?.close(true).catch(() => {});
    for (const c of clientes) c.disconnect();
    clientes = [];
    cola = null;
    worker = null;
    modo = 'memoria';
  }

  return modo;
}

export async function cerrarCola() {
  await worker?.close();
  await cola?.close();
  await Promise.all(clientes.map((c) => c.quit().catch(() => c.disconnect())));
  clientes = [];
}

/* ═══════════════════════════════════════════════════════ encolar trabajos */

async function encolarDatos(datos, opts = {}) {
  try {
    if (cola) return await cola.add(datos.tipo, datos, opts);
    return await memoria.add(datos.tipo, datos, opts);
  } catch (err) {
    // Se traga el error a propósito —una reserva no se cae porque el correo
    // no salga— pero tiene que quedar dicho, no desaparecer.
    console.error(`[correos] NO se encoló ${datos.tipo}${datos.code ? ` de ${datos.code}` : ''}: ${err.message}`);
    return null;
  }
}

export async function encolar(tipo, code, opts = {}) {
  return encolarDatos({ tipo, code }, opts);
}

/** Confirmación al crear la reserva, y el recordatorio del día anterior. */
export async function alReservar(reservation) {
  await encolar('confirmacion', reservation.code);
  await programarRecordatorio(reservation);
}

export async function alPagar(reservation) {
  await encolar('pago', reservation.code);
  await programarRecordatorio(reservation);
}

export async function alCancelar(reservation) {
  await encolar('cancelacion', reservation.code);
}

/* ────────────────────────────────────────────────── lista de espera ── */

/** El correo de oferta, o el de cierre. */
export async function encolarOferta({ tipo, entryId, offerId, motivo }) {
  return encolarDatos({ tipo, entryId, offerId, motivo });
}

/**
 * El tiempo límite de la oferta. Es la razón de fondo para tener Redis: un
 * setTimeout se muere con el proceso, y aquí hay una mesa de por medio.
 */
export async function programarVencimientoOferta({ entryId, offerId, delay }) {
  if (delay <= 0) return null;
  return encolarDatos(
    { tipo: 'vencer-oferta', entryId, offerId },
    { delay, jobId: idDeTrabajo('vencer-oferta', offerId), attempts: 2 }
  );
}

/** Suelta la mesa si el huésped no pagó dentro del plazo. */
export async function programarVencimientoPago(reservation) {
  const minutos = ESPERA.minutosParaPagar;
  if (!minutos || reservation.status !== 'pendiente-pago') return null;

  // Nunca más allá del servicio: después de esa hora, soltarla no sirve.
  const servicio = new Date(`${reservation.date}T${reservation.time}:00`).getTime();
  const delay = Math.min(minutos * 60 * 1000, servicio - Date.now());
  if (delay <= 0) return null;

  return encolarDatos(
    { tipo: 'vencer-pago', code: reservation.code },
    { delay, jobId: idDeTrabajo('vencer-pago', reservation.code), attempts: 2 }
  );
}

/**
 * El recordatorio: un trabajo retrasado hasta N horas antes de la reserva.
 * Es la razón de fondo para tener una cola de verdad — un setTimeout no
 * sobrevive un despliegue, y aquí hablamos de días de espera.
 */
export async function programarRecordatorio(reservation) {
  const cuando = new Date(`${reservation.date}T${reservation.time}:00`).getTime();
  const disparo = cuando - HORAS_ANTES * 3600 * 1000;
  const retraso = disparo - Date.now();

  // Si falta menos que eso, no se manda: sería un recordatorio inútil.
  if (retraso <= 0) return null;

  return encolar('recordatorio', reservation.code, {
    delay: retraso,
    jobId: idDeTrabajo('recordatorio', reservation.code, reservation.date, reservation.time)
  });
}

/* ══════════════════════════════════════════════════════════════ estado */

export async function estadoCola() {
  const counts = cola ? await cola.getJobCounts() : await memoria.counts();
  const fallidos = cola
    ? (await cola.getFailed(0, 9)).map((j) => ({
        id: j.id,
        datos: j.data,
        error: j.failedReason,
        intentos: j.attemptsMade
      }))
    : memoria.fallidos.slice(0, 10).map((f) => ({ id: f.id, datos: f.datos, error: f.error, intentos: OPCIONES.attempts }));

  return {
    modo,
    persistente: modo === 'bullmq',
    correo: MODO_CORREO,
    recordatorioHoras: HORAS_ANTES,
    reintentos: OPCIONES.attempts,
    counts,
    fallidos,
    hoy: todayISO()
  };
}

/** Reintentar a mano desde el panel. */
export async function reintentar(id) {
  if (cola) {
    const job = await cola.getJob(id);
    if (!job) throw new Error('Ese trabajo ya no está en la cola.');
    await job.retry();
    return { reintentado: id };
  }
  const fallido = memoria.fallidos.find((f) => f.id === id);
  if (!fallido) throw new Error('Ese trabajo ya no está en la cola.');
  memoria.fallidos = memoria.fallidos.filter((f) => f.id !== id);
  await memoria.add(fallido.datos.tipo, fallido.datos);
  return { reintentado: id };
}

export const colaInfo = () => ({ modo, persistente: modo === 'bullmq', intentoRedis: Boolean(REDIS_URL) });
