/**
 * ==========================================================================
 * Por dónde sale el correo
 * ==========================================================================
 * Tres modos, elegidos por el entorno. El worker de la cola no sabe cuál
 * está activo: solo llama a enviar().
 *
 *   bandeja  (por defecto) no sale a internet. El correo se guarda armado
 *            y se ve en el panel. Sirve para desarrollar y para demostrar
 *            sin abrir cuenta en ningún lado.
 *   resend   RESEND_API_KEY. Se llama por HTTP con fetch, sin dependencias.
 *   consola  solo lo escupe por stderr. Útil en pruebas.
 *
 * Conectar otro proveedor es agregar un caso aquí, nada más.
 * ==========================================================================
 */

import { RESTAURANT } from '../config.js';
import { db, write, nextId } from '../db.js';

const MAX_BANDEJA = 60; // correos guardados antes de botar los viejos

export const MODO = process.env.RESEND_API_KEY
  ? 'resend'
  : process.env.MAIL_MODO === 'consola'
    ? 'consola'
    : 'bandeja';

const REMITENTE = process.env.MAIL_FROM || `${RESTAURANT.name} <onboarding@resend.dev>`;

export const transporteInfo = () => ({
  modo: MODO,
  remitente: REMITENTE,
  real: MODO === 'resend'
});

/**
 * Envía un correo. Devuelve algo con lo que el worker pueda dejar rastro.
 * Si falla, lanza: la cola se encarga de reintentar.
 */
export async function enviar({ para, asunto, html, texto, tipo, code }) {
  if (!para) throw new Error('El correo no tiene destinatario.');

  if (MODO === 'resend') {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({ from: REMITENTE, to: [para], subject: asunto, html, text: texto })
    });

    const cuerpo = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(cuerpo.message || `Resend respondió ${res.status}`);
      err.status = res.status;
      // 4xx no se arregla reintentando; 5xx y 429 sí.
      err.permanente = res.status >= 400 && res.status < 500 && res.status !== 429;
      throw err;
    }
    return { via: 'resend', id: cuerpo.id };
  }

  if (MODO === 'consola') {
    console.error(`\n[correo → ${para}] ${asunto}\n${texto}\n`);
    return { via: 'consola' };
  }

  // Bandeja: queda guardado y visible en el panel, como si hubiera salido.
  const entrada = {
    id: nextId('MAIL'),
    para,
    asunto,
    html,
    texto,
    tipo,
    code,
    at: new Date().toISOString(),
    via: 'bandeja'
  };

  await write((d) => {
    d.outbox = d.outbox || [];
    d.outbox.unshift(entrada);
    if (d.outbox.length > MAX_BANDEJA) d.outbox.length = MAX_BANDEJA;
  });

  return { via: 'bandeja', id: entrada.id };
}

/** Lo que hay en la bandeja, para el panel. */
export function bandeja(limite = 30) {
  return (db().outbox || []).slice(0, limite);
}

export function correoDeLaBandeja(id) {
  return (db().outbox || []).find((m) => m.id === id) || null;
}
