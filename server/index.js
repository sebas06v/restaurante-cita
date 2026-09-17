/**
 * Servidor HTTP: enrutador de la API + archivos estáticos.
 * Node puro, sin dependencias. `npm start` y listo.
 */
import './env.js'; // debe ir de PRIMERO: ver el comentario de ese archivo

import http from 'node:http';
import process from 'node:process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RESTAURANT, ADMIN_PIN, PIN_IS_DEMO } from './config.js';
import { load } from './db.js';
import * as api from './api.js';
import { ApiError } from './api.js';
import { reply as chatReply, chatInfo } from './chat.js';
import { iniciarCola, cerrarCola, colaInfo } from './queue/correos.js';
import { transporteInfo } from './mail/transporte.js';
import {
  dispatch as mcpDispatch,
  METHODS as MCP_METHODS,
  TOOLS as MCP_TOOL_DEFS,
  RESOURCES as MCP_RESOURCES,
  PROMPTS as MCP_PROMPTS,
  publicTool
} from '../mcp/protocol.js';

const mcpTools = () => MCP_TOOL_DEFS.map(publicTool);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 4321;

/**
 * En local escuchamos solo en 127.0.0.1: nadie más en la red ve la app.
 *
 * Desplegado hay que escuchar en todas las interfaces. Si el proceso queda
 * atado a 127.0.0.1 dentro de un contenedor, el puerto solo se ve desde
 * adentro: Render (o Railway, o Fly) lo escanea desde afuera, no encuentra
 * nada y el despliegue se cuelga en «Deploying…» hasta que expira.
 *
 * La señal de que estamos en un PaaS es que el puerto lo impone el entorno.
 */
const deployed = Boolean(process.env.PORT || process.env.RENDER || process.env.NODE_ENV === 'production');
const HOST = process.env.HOST || (deployed ? '0.0.0.0' : '127.0.0.1');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
};

/* ------------------------------------------------------------------ rutas */

const routes = [];
const route = (method, pattern, handler, opts = {}) =>
  routes.push({ method, pattern, handler, admin: Boolean(opts.admin) });

route('GET', '/api/config', api.getConfig);
route('GET', '/api/calendar', api.getCalendar);
route('GET', '/api/availability', api.getAvailability);
route('GET', '/api/floor', api.getFloor);

route('POST', '/api/reservations', api.createReservation);
route('POST', '/api/waitlist', api.joinWaitlist);
route('GET', '/api/espera/:token', api.getOffer);
route('POST', '/api/espera/:token/aceptar', api.acceptOffer);
route('POST', '/api/espera/:token/rechazar', api.declineOffer);
route('GET', '/api/payments/:code', api.getPayment);
route('POST', '/api/payments/:code', api.payReservation);
route('GET', '/api/reservations/lookup', api.lookupReservation);
route('GET', '/api/reservations/:code/ics', api.reservationCalendarFile);
route('GET', '/api/reservations/:code', api.lookupReservation);
route('PATCH', '/api/reservations/:code', api.updateReservation);

route('POST', '/api/admin/login', api.adminLogin);
route('GET', '/api/admin/day', api.adminDay, { admin: true });
route('GET', '/api/admin/stats', api.adminStats, { admin: true });
route('GET', '/api/admin/export.csv', api.adminExport, { admin: true });
route('GET', '/api/admin/waitlist', api.adminWaitlist, { admin: true });
route('PATCH', '/api/admin/waitlist/:id', api.adminWaitlist, { admin: true });
route('POST', '/api/admin/waitlist/:id/ofrecer', api.adminOfferNow, { admin: true });
route('POST', '/api/admin/reservations', (ctx) => api.createReservation({ ...ctx, admin: true }), { admin: true });
route('PATCH', '/api/admin/reservations/:id', api.adminUpdateReservation, { admin: true });
route('PATCH', '/api/admin/payments/:id', api.adminMarkPayment, { admin: true });
route('GET', '/api/admin/mail', api.adminMail, { admin: true });
route('GET', '/api/admin/mail/:id', api.adminMailOne, { admin: true });
route('POST', '/api/admin/mail/:id/retry', api.adminMailRetry, { admin: true });
route('POST', '/api/admin/blocks', api.adminCreateBlock, { admin: true });
route('DELETE', '/api/admin/blocks/:id', api.adminDeleteBlock, { admin: true });

function match(method, pathname) {
  for (const entry of routes) {
    if (entry.method !== method) continue;
    const parts = entry.pattern.split('/');
    const actual = pathname.split('/');
    if (parts.length !== actual.length) continue;
    const params = {};
    let hit = true;
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i].startsWith(':')) params[parts[i].slice(1)] = decodeURIComponent(actual[i]);
      else if (parts[i] !== actual[i]) {
        hit = false;
        break;
      }
    }
    if (hit) return { ...entry, params };
  }
  return null;
}

/* --------------------------------------------------------------- utilidades */

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 200_000) throw new ApiError(413, 'Solicitud demasiado grande.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, 'JSON inválido.');
  }
}

function send(res, status, payload, headers = {}) {
  const body = typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(body);
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (rel === 'admin' || rel === 'admin/') rel = 'admin.html';
  if (rel === 'reserva' || rel === 'mi-reserva') rel = 'index.html';
  if (rel === 'espera' || rel === 'espera/') rel = 'espera.html';

  const target = path.join(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Ruta no permitida.' });

  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) throw new Error('dir');
    const ext = path.extname(target).toLowerCase();
    // Sin caché agresiva: el proyecto se edita en vivo y así el navegador
    // nunca sirve una versión vieja del CSS o del JS.
    const cache = ext === '.html' ? 'no-store' : 'no-cache, must-revalidate';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cache
    });
    fs.createReadStream(target).pipe(res);
  } catch {
    // Rutas del cliente: devolver la app.
    if (!path.extname(rel)) {
      const html = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'));
      return send(res, 200, html, { 'Content-Type': MIME['.html'] });
    }
    send(res, 404, { error: 'No encontrado.' });
  }
}

/* ──────────────────────────────────────────────────────────────────── MCP */

/**
 * El mismo catálogo del MCP, servido por HTTP en lugar de stdio: acepta un
 * mensaje JSON-RPC 2.0 (o un lote) y devuelve la respuesta. Es la puerta que
 * usa la colección de Postman; Claude Code sigue usando `mcp/server.js`.
 */
async function serveMcp(req, res) {
  const sessionHeader = req.headers['mcp-session-id'];
  const extra = sessionHeader ? { 'Mcp-Session-Id': sessionHeader } : {};

  if (req.method === 'GET') {
    return send(
      res,
      200,
      {
        servidor: 'el-guayacan',
        transporte: 'JSON-RPC 2.0 sobre POST (sin SSE)',
        uso: 'POST /mcp con {"jsonrpc":"2.0","id":1,"method":"tools/list"}',
        metodos: MCP_METHODS,
        herramientas: mcpTools().map((t) => t.name),
        recursos: MCP_RESOURCES.map((r) => r.uri),
        prompts: MCP_PROMPTS.map((p) => p.name)
      },
      extra
    );
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return send(res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: err.message || 'JSON inválido.' }
    });
  }

  const batch = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const message of batch) {
    const response = await mcpDispatch(message);
    if (response) responses.push(response);
  }

  // Un lote de puras notificaciones no lleva cuerpo de respuesta.
  if (!responses.length) {
    res.writeHead(202, { 'Cache-Control': 'no-store', ...extra });
    return res.end();
  }
  send(res, 200, Array.isArray(body) ? responses : responses[0], extra);
}

/* ------------------------------------------------------------------- chat */

/**
 * El chat va por Server-Sent Events: la respuesta se escribe a medida que
 * el modelo la produce, así que no pasa por el `send()` de una sola tirada.
 */
async function serveChat(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return send(res, 400, { error: 'Cuerpo inválido.' });
  }

  const message = String(body.message || '').trim();
  if (!message) return send(res, 400, { error: 'Escriba algo.' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  const emit = (event) => {
    if (closed || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    await chatReply({
      sessionId: body.sessionId,
      message,
      ip: req.socket.remoteAddress || 'anon',
      emit
    });
  } catch (err) {
    console.error('[chat] fallo inesperado:', err);
    emit({ type: 'error', message: 'La anfitriona se quedó sin voz. Intente otra vez.' });
  }
  if (!res.writableEnded) res.end();
}

/* ---------------------------------------------------------------- servidor */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (pathname === '/mcp' && (req.method === 'POST' || req.method === 'GET')) return serveMcp(req, res);
  if (pathname === '/api/chat' && req.method === 'POST') return serveChat(req, res);
  if (pathname === '/api/chat/info' && req.method === 'GET') return send(res, 200, chatInfo());

  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Método no permitido.' });
    return serveStatic(req, res, pathname);
  }

  const found = match(req.method, pathname);
  if (!found) return send(res, 404, { error: 'Ese recurso no existe.' });

  try {
    const query = Object.fromEntries(url.searchParams.entries());
    if (found.admin) api.requireAdmin(req.headers, query);
    const body = await readBody(req);
    const result = await found.handler({
      query,
      body,
      params: found.params,
      method: req.method,
      headers: req.headers
    });

    if (result.body !== undefined) {
      return send(res, result.status || 200, result.body, result.headers || {});
    }
    send(res, result.status || 200, result.json);
  } catch (err) {
    if (err instanceof ApiError) {
      return send(res, err.status, { error: err.message, ...err.extra });
    }
    console.error('[api]', err);
    send(res, 500, { error: 'Algo se rompió de nuestro lado.' });
  }
});

load();

// La cola se levanta antes de escuchar: si hay Redis, se conecta; si no,
// sigue en memoria y lo dice en el banner.
await iniciarCola();

for (const senal of ['SIGINT', 'SIGTERM']) {
  process.on(senal, async () => {
    await cerrarCola();
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log('');
  console.log(`  ${RESTAURANT.name} · sistema de reservas`);
  console.log(`  ${'─'.repeat(42)}`);
  console.log(`  Sitio           ${url}`);
  console.log(`  Panel de sala   ${url}/admin   (PIN ${ADMIN_PIN}${PIN_IS_DEMO ? '' : ' · generado, guárdelo'})`);
  const chat = chatInfo();
  console.log(
    `  Chat con IA     ${
      chat.enabled
        ? `activo · ${chat.provider}/${chat.model} · ${chat.tools} herramientas · ${chat.scope}`
        : 'apagado · falta DEEPSEEK_API_KEY'
    }`
  );
  if (!chat.enabled) {
    console.log(
      deployed
        ? '                  FALTA DEEPSEEK_API_KEY en las variables del servidor:'
        : '                  copie .env.example a .env, ponga su llave y relance npm start'
    );
    if (deployed) {
      console.log('                  el sitio funciona, pero el chat no aparece para los visitantes');
    }
  }
  const cola = colaInfo();
  const correo = transporteInfo();
  console.log(
    `  Cola de correos ${
      cola.modo === 'bullmq'
        ? 'BullMQ sobre Redis · sobrevive un reinicio'
        : cola.intentoRedis
          ? 'en memoria · HABÍA REDIS_URL pero no conectó (ver el error arriba)'
          : 'en memoria · sin REDIS_URL'
    } · envío: ${correo.modo}`
  );
  console.log('');
});
