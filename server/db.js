/**
 * Persistencia. Base de datos JSON en disco con escritura atómica
 * (tmp + rename) y una cola para serializar las escrituras concurrentes.
 * Sin dependencias externas: suficiente y trazable para un restaurante.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedReservations } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const EMPTY = {
  version: 1,
  createdAt: new Date().toISOString(),
  counter: 1000,
  reservations: [],
  waitlist: [],
  blocks: [],
  log: []
};

let state = null;
let queue = Promise.resolve();

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function load({ seed = true } = {}) {
  ensureDir();
  if (fs.existsSync(DB_FILE)) {
    try {
      state = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      for (const key of Object.keys(EMPTY)) {
        if (state[key] === undefined) state[key] = structuredClone(EMPTY[key]);
      }
      return state;
    } catch (err) {
      const backup = `${DB_FILE}.corrupto-${Date.now()}`;
      fs.renameSync(DB_FILE, backup);
      console.warn(`[db] archivo ilegible, respaldado en ${backup}`);
    }
  }
  state = structuredClone(EMPTY);
  if (seed) {
    const { reservations, counter } = seedReservations();
    state.reservations = reservations;
    state.counter = counter;
    state.log.push({ at: new Date().toISOString(), action: 'seed', detail: `${reservations.length} reservas de ejemplo` });
  }
  fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2));
  return state;
}

export function db() {
  if (!state) load();
  return state;
}

/** Ejecuta una mutación sobre el estado y persiste. Serializado. */
export function write(mutator) {
  const run = async () => {
    const current = db();
    const result = await mutator(current);
    current.updatedAt = new Date().toISOString();
    const tmp = `${DB_FILE}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(current, null, 2), 'utf8');
    await fsp.rename(tmp, DB_FILE);
    return result;
  };
  const next = queue.then(run, run);
  queue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

export function nextId(prefix) {
  const d = db();
  d.counter += 1;
  return `${prefix}-${d.counter}`;
}

/** Código público de la reserva: legible por teléfono, sin caracteres ambiguos. */
export function makeCode(existing) {
  const alphabet = 'ACDEFGHJKLMNPQRTUVWXY3479';
  const taken = new Set(existing.map((r) => r.code));
  for (let attempt = 0; attempt < 500; attempt += 1) {
    let body = '';
    for (let i = 0; i < 4; i += 1) body += alphabet[Math.floor(Math.random() * alphabet.length)];
    const code = `GY-${body}`;
    if (!taken.has(code)) return code;
  }
  return `GY-${Date.now().toString(36).toUpperCase().slice(-4)}`;
}

export function logEvent(entry) {
  const d = db();
  d.log.push({ at: new Date().toISOString(), ...entry });
  if (d.log.length > 2000) d.log.splice(0, d.log.length - 2000);
}
