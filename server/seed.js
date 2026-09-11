/**
 * Datos de ejemplo: llena la agenda para que el panel y el calendario
 * se vean como un restaurante que ya está operando.
 * Generador determinista (LCG) para que cada arranque limpio sea igual.
 */
import { OCCASIONS, PREFERENCES, EXPERIENCES, ZONES } from './config.js';
import { todayISO, addDays, nowMinutes, toMinutes, weekday } from './time.js';
import { servicesFor, freeTables, turnMinutes } from './availability.js';

let s = 20260408;
const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));

const NOMBRES = [
  'Valentina Ríos', 'Andrés Mejía', 'Camila Restrepo', 'Juan Pablo Ordóñez', 'Laura Céspedes',
  'Santiago Villalba', 'Mariana Arboleda', 'Felipe Guzmán', 'Daniela Ochoa', 'Tomás Bustamante',
  'Isabella Cardona', 'Nicolás Piedrahíta', 'Sara Montoya', 'Emilio Quintero', 'Paula Andrea Lozano',
  'Sebastián Vargas', 'Manuela Hoyos', 'Ricardo Salazar', 'Ana María Peñaloza', 'Diego Zapata',
  'Catalina Uribe', 'Mateo Escobar', 'Luisa Fernanda Rojas', 'Julián Betancur', 'Natalia Gaviria',
  'Alejandro Buitrago', 'Verónica Amaya', 'Óscar Iván Cifuentes', 'Silvia Naranjo', 'Carlos Andrés Pineda'
];

const NOTAS = [
  'Venimos justo del aeropuerto, puede que lleguemos 10 minutos tarde.',
  'Es la primera vez que vienen mis papás, algo cerca de la ventana si se puede.',
  'Uno de los invitados es alérgico al maní.',
  'Celebramos un cierre de negocio, necesitamos poder hablar.',
  'Traemos a la bebé, agradecemos silla alta.',
  '',
  '',
  'Nos gustaría probar el maridaje si alcanza el tiempo.',
  ''
];

const EMPRESAS = ['gmail.com', 'hotmail.com', 'outlook.com', 'unal.edu.co', 'bancolombia.com.co'];

function emailFor(nombre) {
  const base = nombre
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(' ');
  return `${base[0]}.${base.at(-1)}@${pick(EMPRESAS)}`;
}

function phone() {
  return `+57 3${int(0, 2)}${int(0, 9)} ${int(100, 999)} ${int(1000, 9999)}`;
}

function codeFor(n) {
  const alphabet = 'ACDEFGHJKLMNPQRTUVWXY3479';
  let body = '';
  for (let i = 0; i < 4; i += 1) body += alphabet[(n * 7 + i * 13 + Math.floor(rnd() * 25)) % alphabet.length];
  return `GY-${body}`;
}

export function seedReservations() {
  const reservations = [];
  let counter = 1000;
  const today = todayISO();
  const minuteNow = nowMinutes();

  for (let offset = -6; offset <= 12; offset += 1) {
    const date = addDays(today, offset);
    const services = servicesFor(date);
    if (!services.length) continue;

    // Los fines de semana y los días próximos se llenan más.
    const heat = offset < 0 ? 0.75 : offset <= 3 ? 0.8 : 0.45;
    const weekendBoost = [0, 5, 6].includes(weekday(date)) ? 1.3 : 1;

    for (const service of services) {
      const target = Math.round(int(9, 16) * heat * weekendBoost);
      for (let i = 0; i < target; i += 1) {
        const party = chance(0.42) ? 2 : chance(0.55) ? int(3, 4) : chance(0.7) ? int(5, 6) : int(7, 10);
        const openMin = toMinutes(service.open);
        const lastMin = toMinutes(service.lastSeating);
        const steps = Math.max(1, Math.floor((lastMin - openMin) / 15));
        const time = (() => {
          const m = openMin + int(0, steps) * 15;
          return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        })();

        const zonePref = chance(0.7) ? pick(ZONES.filter((z) => z.id !== 'privado')).id : null;
        const table =
          freeTables({ date, time, party, zone: zonePref, reservations, blocks: [] })[0] ||
          freeTables({ date, time, party, reservations, blocks: [] })[0];
        if (!table) continue;

        const nombre = pick(NOMBRES);
        const occasion = chance(0.35) ? pick(OCCASIONS).id : 'ninguna';
        const prefs = [];
        if (chance(0.3)) prefs.push(pick(PREFERENCES).id);
        if (chance(0.12)) prefs.push(pick(PREFERENCES).id);
        const exps = chance(0.22) ? [pick(EXPERIENCES).id] : [];

        let status;
        if (offset < 0) status = chance(0.08) ? 'no-show' : chance(0.06) ? 'cancelada' : 'completada';
        else if (offset > 0) status = chance(0.2) ? 'pendiente' : 'confirmada';
        else {
          const start = toMinutes(time);
          const dur = turnMinutes(party);
          if (minuteNow > start + dur) status = chance(0.1) ? 'no-show' : 'completada';
          else if (minuteNow >= start) status = 'sentada';
          else status = chance(0.15) ? 'pendiente' : 'confirmada';
        }

        counter += 1;
        reservations.push({
          id: `RES-${counter}`,
          code: codeFor(counter),
          date,
          time,
          party,
          zone: table.zone,
          tableId: table.id,
          turnMinutes: turnMinutes(party),
          name: nombre,
          phone: phone(),
          email: emailFor(nombre),
          occasion,
          preferences: [...new Set(prefs)],
          experiences: exps,
          notes: pick(NOTAS),
          status,
          source: chance(0.7) ? 'web' : 'telefono',
          deposit: party >= 8,
          createdAt: new Date(Date.now() - int(1, 20) * 86400000).toISOString(),
          updatedAt: new Date().toISOString(),
          history: [{ at: new Date().toISOString(), action: 'creada', by: 'siembra' }]
        });
      }
    }
  }

  reservations.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  return { reservations, counter };
}
