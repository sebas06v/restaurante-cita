/**
 * ==========================================================================
 * Por dónde sale el correo
 * ==========================================================================
 * El worker de la cola no sabe cuál está activo: solo llama a enviar().
 * El modo se decide por el entorno, en este orden:
 *
 *   smtp     SMTP_HOST + SMTP_USER + SMTP_PASS. Cualquier servidor SMTP:
 *            Gmail con contraseña de aplicación, Brevo, Zoho, el del
 *            hosting. Llega a CUALQUIER destinatario sin dominio propio.
 *            Ojo: algunas plataformas bloquean los puertos SMTP salientes.
 *
 *   brevo    BREVO_API_KEY. HTTP por el puerto 443, así que ningún firewall
 *            lo estorba. Basta verificar UN correo remitente, no todo un
 *            dominio, y también llega a cualquier destinatario.
 *
 *   resend   RESEND_API_KEY. HTTP. El mejor para volumen, pero con el
 *            remitente de prueba solo entrega al dueño de la cuenta: para
 *            escribirle a cualquiera hay que verificar un dominio.
 *
 *   bandeja  (por defecto) no sale a internet. El correo queda armado y se
 *            ve en el panel. Para desarrollar y demostrar sin cuentas.
 *
 *   consola  MAIL_MODO=consola. Lo escupe por stderr.
 *
 * Agregar un proveedor es un caso más aquí abajo.
 * ==========================================================================
 */

import { RESTAURANT } from '../config.js';
import { db, write, nextId } from '../db.js';

const MAX_BANDEJA = 60; // correos guardados antes de botar los viejos

const tieneSmtp = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

export const MODO =
  process.env.MAIL_MODO === 'consola'
    ? 'consola'
    : process.env.MAIL_MODO === 'bandeja'
      ? 'bandeja'
      : tieneSmtp
        ? 'smtp'
        : process.env.BREVO_API_KEY
          ? 'brevo'
          : process.env.RESEND_API_KEY
            ? 'resend'
            : 'bandeja';

/**
 * El remitente. Con SMTP y con Brevo debe ser una dirección que el
 * proveedor reconozca como suya, o el envío se rechaza.
 */
const REMITENTE =
  process.env.MAIL_FROM ||
  (MODO === 'smtp' ? `${RESTAURANT.name} <${process.env.SMTP_USER}>` : `${RESTAURANT.name} <onboarding@resend.dev>`);

/** Separa "Nombre <correo@dominio>" en sus dos partes. */
function partirRemitente(valor) {
  const m = String(valor).match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/);
  return m ? { nombre: m[1] || RESTAURANT.name, correo: m[2] } : { nombre: RESTAURANT.name, correo: String(valor).trim() };
}

export const transporteInfo = () => ({
  modo: MODO,
  remitente: REMITENTE,
  real: MODO === 'smtp' || MODO === 'brevo' || MODO === 'resend',
  aCualquiera: MODO === 'smtp' || MODO === 'brevo'
});

/* ─────────────────────────────────────────────────────────────── SMTP ── */

let transporteSmtp = null;

async function porSmtp({ para, asunto, html, texto }) {
  if (!transporteSmtp) {
    const { createTransport } = await import('nodemailer');
    const port = Number(process.env.SMTP_PORT) || 587;
    transporteSmtp = createTransport({
      host: process.env.SMTP_HOST,
      port,
      // 465 es TLS directo; 587 empieza en claro y sube con STARTTLS.
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  }

  try {
    const info = await transporteSmtp.sendMail({ from: REMITENTE, to: para, subject: asunto, html, text: texto });
    return { via: 'smtp', id: info.messageId, aceptados: info.accepted?.length || 0 };
  } catch (err) {
    // 5xx de SMTP es definitivo (buzón inexistente, credenciales malas);
    // 4xx es temporal y sí vale la pena reintentar.
    err.permanente = typeof err.responseCode === 'number' && err.responseCode >= 500;
    throw err;
  }
}

/* ──────────────────────────────────────────────────────────── Brevo ── */

async function porBrevo({ para, asunto, html, texto }) {
  const { nombre, correo } = partirRemitente(REMITENTE);
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      accept: 'application/json',
      'api-key': process.env.BREVO_API_KEY
    },
    body: JSON.stringify({
      sender: { name: nombre, email: correo },
      to: [{ email: para }],
      subject: asunto,
      htmlContent: html,
      textContent: texto
    })
  });

  const cuerpo = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(cuerpo.message || `Brevo respondió ${res.status}`);
    err.status = res.status;
    err.permanente = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw err;
  }
  return { via: 'brevo', id: cuerpo.messageId };
}

/* ─────────────────────────────────────────────────────────── Resend ── */

async function porResend({ para, asunto, html, texto }) {
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
    err.permanente = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw err;
  }
  return { via: 'resend', id: cuerpo.id };
}

/* ══════════════════════════════════════════════════════════════ envío ══ */

/**
 * Envía un correo. Devuelve algo con lo que el worker deje rastro.
 * Si falla, lanza: la cola reintenta, salvo que el error sea permanente.
 */
export async function enviar({ para, asunto, html, texto, tipo, code }) {
  if (!para) throw new Error('El correo no tiene destinatario.');

  if (MODO === 'smtp') return porSmtp({ para, asunto, html, texto });
  if (MODO === 'brevo') return porBrevo({ para, asunto, html, texto });
  if (MODO === 'resend') return porResend({ para, asunto, html, texto });

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

/** Comprueba que el proveedor acepta las credenciales, sin mandar nada. */
export async function probarTransporte() {
  if (MODO !== 'smtp') return { modo: MODO, comprobable: false };
  const { createTransport } = await import('nodemailer');
  const port = Number(process.env.SMTP_PORT) || 587;
  const t = createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  await t.verify();
  return { modo: 'smtp', comprobable: true, ok: true };
}

/** Lo que hay en la bandeja, para el panel. */
export function bandeja(limite = 30) {
  return (db().outbox || []).slice(0, limite);
}

export function correoDeLaBandeja(id) {
  return (db().outbox || []).find((m) => m.id === id) || null;
}
