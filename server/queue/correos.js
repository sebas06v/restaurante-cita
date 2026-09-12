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
let modo = 'memoria';
let arrancada = false;

/* ═══════════════════════════════════════════════ el trabajo, sea quien sea */

/**
 * Lo que hace un trabajo. Es la misma función en los dos modos, así que
 * cambiar de cola no cambia el comportamiento.
 */
async function procesar({ tipo, code }) {
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

/* ═══════════════════════════════════════════════ cola de respaldo, sin Redis */

/**
 * Misma interfaz que BullMQ, en memoria. Reintenta con el mismo backoff,
 * pero lo pendiente se pierde al reiniciar: es un respaldo, no un sustituto.
 */
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
    const t = setTimeout(() => correr(), retraso);
    t.unref?.();
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
    const connection = { url: REDIS_URL, maxRetriesPerRequest: null };

    cola = new Queue(NOMBRE, { connection, defaultJobOptions: OPCIONES });
    worker = new Worker(NOMBRE, async (job) => procesar(job.data), { connection, concurrency: 4 });

    worker.on('failed', (job, err) => {
      console.error(`[correos] falló ${job?.data?.tipo} de ${job?.data?.code}: ${err.message}`);
    });
    worker.on('error', (err) => console.error('[correos] error del worker:', err.message));

    // Que no se quede colgado si Redis no responde: se prueba la conexión.
    await cola.waitUntilReady();
    modo = 'bullmq';
  } catch (err) {
    console.error(`[correos] no se pudo conectar a Redis (${err.message}); sigo en memoria.`);
    cola = null;
    worker = null;
    modo = 'memoria';
  }

  return modo;
}

export async function cerrarCola() {
  await worker?.close();
  await cola?.close();
}

/* ═══════════════════════════════════════════════════════ encolar trabajos */

async function encolar(tipo, code, opts = {}) {
  const datos = { tipo, code };
  try {
    if (cola) return await cola.add(tipo, datos, opts);
    return await memoria.add(tipo, datos, opts);
  } catch (err) {
    console.error(`[correos] no pude encolar ${tipo} de ${code}: ${err.message}`);
    return null;
  }
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
    jobId: `recordatorio:${reservation.code}:${reservation.date}:${reservation.time}`
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

export const colaInfo = () => ({ modo, persistente: modo === 'bullmq' });
