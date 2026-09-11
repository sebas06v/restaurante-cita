#!/usr/bin/env node
/**
 * ==========================================================================
 * El Guayacán · servidor MCP · transporte stdio
 * ==========================================================================
 * El catálogo (13 herramientas, 3 recursos, 3 prompts) y el despachador
 * JSON-RPC viven en `protocol.js`. Este archivo solo los conecta a
 * stdin/stdout, que es como los levanta Claude Code.
 *
 *   Uso:  node mcp/server.js
 *   Env:  GUAYACAN_URL (default http://127.0.0.1:4321)
 *         GUAYACAN_PIN (default 2408)  → habilita las herramientas de sala
 *
 * El mismo catálogo se sirve por HTTP en POST /mcp del restaurante, que es
 * la puerta que usa la colección de Postman.
 *
 * Regla de oro: por stdout solo salen mensajes del protocolo. Los logs van
 * a stderr.
 * ==========================================================================
 */

import readline from 'node:readline';

import { dispatch, ERR, TOOLS, RESOURCES, PROMPTS } from './protocol.js';

const BASE = (process.env.GUAYACAN_URL || 'http://127.0.0.1:4321').replace(/\/$/, '');
const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  const raw = line.trim();
  if (!raw) return;

  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: ERR.PARSE, message: 'JSON inválido.' } });
    return;
  }

  for (const item of Array.isArray(message) ? message : [message]) {
    const response = await dispatch(item);
    if (response) write(response);
  }
});

rl.on('close', () => {
  console.error('[mcp] cliente desconectado, cerrando.');
  process.exit(0);
});

console.error(
  `[mcp] stdio listo · API ${BASE} · ${TOOLS.length} herramientas, ${RESOURCES.length} recursos, ${PROMPTS.length} prompts`
);
