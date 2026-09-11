#!/usr/bin/env node
/**
 * ==========================================================================
 * Flujo del MCP, de punta a punta.
 * ==========================================================================
 * Levanta `mcp/server.js` como proceso hijo, habla con él por stdio igual
 * que lo haría Claude Code, y va narrando cada paso: handshake, catálogo de
 * herramientas, consulta, reserva, cambio, servicio y cierre.
 *
 *   node mcp/flujo-demo.js            (requiere `npm start` en otra consola)
 *   node mcp/flujo-demo.js --json     imprime también el JSON-RPC crudo
 * ==========================================================================
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.argv.includes('--json');
const BASE = process.env.GUAYACAN_URL || 'http://127.0.0.1:4321';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  gold: (s) => `\x1b[38;5;179m${s}\x1b[0m`,
  green: (s) => `\x1b[38;5;71m${s}\x1b[0m`,
  red: (s) => `\x1b[38;5;167m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`
};

/* --------------------------------------------------------------- cliente */

const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env
});

child.stderr.on('data', (buf) => {
  if (VERBOSE) process.stderr.write(c.dim(`   servidor · ${String(buf).trim()}\n`));
});

const pending = new Map();
let nextId = 1;

readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (VERBOSE) console.log(c.dim(`   ← ${line.slice(0, 400)}`));
  const waiter = pending.get(msg.id);
  if (!waiter) return;
  pending.delete(msg.id);
  if (msg.error) waiter.reject(new Error(`${msg.error.message} (código ${msg.error.code})`));
  else waiter.resolve(msg.result);
});

function request(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
  if (VERBOSE) console.log(c.dim(`   → ${JSON.stringify(payload).slice(0, 400)}`));
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`sin respuesta a ${method}`));
      }
    }, 15000);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
}

/* ---------------------------------------------------------------- salida */

let step = 0;
const head = (title, detail = '') => {
  step += 1;
  console.log('');
  console.log(c.gold(`${String(step).padStart(2, '0')} · ${title}`));
  if (detail) console.log(c.dim(`     ${detail}`));
  console.log(c.dim('     ' + '─'.repeat(64)));
};

const body = (text, limit = 22) => {
  const lines = String(text).split('\n');
  for (const line of lines.slice(0, limit)) console.log(`     ${line}`);
  if (lines.length > limit) console.log(c.dim(`     … (${lines.length - limit} líneas más)`));
};

async function tool(name, args, { limit } = {}) {
  const result = await request('tools/call', { name, arguments: args });
  const text = result.content.map((c2) => c2.text).join('\n');
  if (result.isError) {
    console.log(c.red(`     ${text}`));
  } else {
    body(text, limit);
  }
  return { text, data: result.structuredContent?.resultado, isError: Boolean(result.isError) };
}

/* ------------------------------------------------------------------ flujo */

async function main() {
  console.log('');
  console.log(c.bold('  El Guayacán · flujo del servidor MCP'));
  console.log(c.dim(`  API ${BASE} · transporte stdio · JSON-RPC 2.0`));

  /* 1. Handshake ------------------------------------------------------- */
  head('initialize', 'el cliente se presenta y negocia versión y capacidades');
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: { roots: { listChanged: false } },
    clientInfo: { name: 'flujo-demo', version: '1.0.0' }
  });
  notify('notifications/initialized');
  body(
    [
      `servidor: ${init.serverInfo.name} v${init.serverInfo.version}`,
      `protocolo: ${init.protocolVersion}`,
      `capacidades: ${Object.keys(init.capabilities).join(', ')}`,
      '',
      'instrucciones que el servidor le deja al modelo:',
      init.instructions
    ].join('\n')
  );

  /* 2. Catálogo -------------------------------------------------------- */
  head('tools/list', 'qué puede hacer el asistente con este restaurante');
  const { tools } = await request('tools/list');
  for (const t of tools) {
    const marca = t.annotations.readOnlyHint ? c.dim('lectura ') : c.gold('escribe ');
    console.log(`     ${marca} ${t.name.padEnd(26)} ${c.dim(t.title)}`);
  }

  head('resources/list + prompts/list', 'contexto y guiones que el servidor ofrece');
  const { resources } = await request('resources/list');
  const { prompts } = await request('prompts/list');
  for (const r of resources) console.log(`     recurso  ${r.uri.padEnd(26)} ${c.dim(r.description)}`);
  for (const p of prompts) console.log(`     prompt   ${p.name.padEnd(26)} ${c.dim(p.description)}`);

  /* 3. El asistente arranca con un guion ------------------------------- */
  head('prompts/get reservar_para_huesped', 'el guion que ordena la conversación');
  const guion = await request('prompts/get', {
    name: 'reservar_para_huesped',
    arguments: { personas: '4', ocasion: 'aniversario' }
  });
  body(guion.messages[0].content.text, 12);

  /* 4. Buscar día ------------------------------------------------------ */
  head('proximas_fechas_libres', '"¿cuándo hay mesa para cuatro?"');
  const cal = await tool('proximas_fechas_libres', { personas: 4, dias: 10 }, { limit: 12 });
  const target = cal.data.calendar.find((d) => d.open && d.slots > 2);
  if (!target) throw new Error('la agenda no tiene días libres; corra `npm run reset`');

  /* 5. Ver horarios ---------------------------------------------------- */
  head('consultar_disponibilidad', `día elegido: ${target.date}`);
  const disp = await tool('consultar_disponibilidad', { personas: 4, fecha: target.date }, { limit: 16 });
  const service = disp.data.services.find((s) => s.openCount > 0);
  const slot = service.slots.find((s) => ['free', 'ultimas'].includes(s.status));

  /* 6. Ver la sala ----------------------------------------------------- */
  head('estado_sala', `plano a las ${slot.time}, para escoger salón`);
  const sala = await tool('estado_sala', { fecha: target.date, hora: slot.time, personas: 4 }, { limit: 14 });
  const zona = sala.data.zones.find((z) => z.available && z.id !== 'privado');

  /* 7. Reservar -------------------------------------------------------- */
  head('crear_reserva', 'única llamada que escribe en la agenda');
  const creada = await tool('crear_reserva', {
    nombre: 'Mariana Arboleda',
    telefono: '+57 311 448 2076',
    correo: 'mariana.arboleda@correo.com',
    personas: 4,
    fecha: target.date,
    hora: slot.time,
    salon: zona.id,
    ocasion: 'aniversario',
    preferencias: ['tranquila', 'ventana'],
    experiencias: ['maridaje-aguardiente'],
    notas: 'Diez años de casados. Si se puede, mesa apartada del paso.'
  });
  const codigo = creada.data.reservation.code;

  /* 8. Error controlado ------------------------------------------------ */
  head('crear_reserva (caso de error)', 'un grupo de 20 no cabe en línea: el servidor educa al modelo');
  await tool('crear_reserva', {
    nombre: 'Grupo Cifuentes',
    telefono: '+57 300 000 0000',
    correo: 'grupo@correo.com',
    personas: 20,
    fecha: target.date,
    hora: slot.time
  });

  head('anotar_lista_espera', 'la salida correcta para ese grupo');
  await tool('anotar_lista_espera', {
    nombre: 'Grupo Cifuentes',
    telefono: '+57 300 000 0000',
    correo: 'grupo@correo.com',
    personas: 20,
    fecha: target.date,
    franja: 'cena',
    notas: 'Cierre de trimestre, quieren salón privado.'
  });

  /* 9. Cambio ---------------------------------------------------------- */
  head('modificar_reserva', 'el huésped llega media hora más tarde');
  const [h, m] = slot.time.split(':').map(Number);
  const later = `${String(h + (m >= 30 ? 1 : 0)).padStart(2, '0')}:${String((m + 30) % 60).padStart(2, '0')}`;
  await tool('modificar_reserva', { codigo, hora: later });

  head('buscar_reserva', 'confirmar cómo quedó');
  await tool('buscar_reserva', { codigo });

  /* 10. Servicio (herramientas de sala) -------------------------------- */
  head('agenda_del_dia', 'la vista del equipo, con PIN de sala');
  await tool('agenda_del_dia', { fecha: target.date }, { limit: 18 });

  head('marcar_estado', 'el huésped llegó: se marca en mesa');
  await tool('marcar_estado', { codigo, estado: 'sentada' });

  head('bloquear_franja', 'se dañó el brasero de la terraza');
  await tool('bloquear_franja', {
    fecha: target.date,
    desde: '20:00',
    hasta: '21:30',
    alcance: 'terraza',
    motivo: 'Brasero en reparación'
  });

  head('metricas', 'cómo viene la semana');
  await tool('metricas', { dias: 7 }, { limit: 16 });

  /* 11. Recurso -------------------------------------------------------- */
  head('resources/read guayacan://carta', 'contexto que el modelo puede leer sin llamar herramientas');
  const carta = await request('resources/read', { uri: 'guayacan://carta' });
  body(carta.contents[0].text, 10);

  /* 12. Cierre --------------------------------------------------------- */
  head('cancelar_reserva', 'cierre del ciclo: la mesa vuelve a la agenda');
  await tool('cancelar_reserva', { codigo });

  console.log('');
  console.log(c.green(`  Flujo completo. ${step} pasos, reserva de prueba ${codigo} creada y cancelada.`));
  console.log(c.dim('  Vuelva a correrlo con --json para ver el JSON-RPC crudo de cada paso.'));
  console.log('');
}

main()
  .then(() => {
    child.stdin.end();
    setTimeout(() => process.exit(0), 100);
  })
  .catch((err) => {
    console.error('');
    console.error(c.red(`  Falló el flujo: ${err.message}`));
    console.error(c.dim('  ¿Está corriendo el restaurante? npm start en otra consola.'));
    child.kill();
    process.exit(1);
  });
