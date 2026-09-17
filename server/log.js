/**
 * ==========================================================================
 * La bitácora
 * ==========================================================================
 * Un archivo por día en logs/AAAAMMDD.log, una línea por suceso. La idea es
 * poder abrir el archivo del día en que algo salió mal y entender qué pasó
 * sin adivinar: cuándo, quién, en qué función, con qué entró y con qué
 * salió.
 *
 * El formato es una sola línea, legible a ojo y buscable con grep, con la
 * entrada y la salida en JSON al final:
 *
 *   [2026-09-16 21:04:11] ERROR  actor=huésped  fn=aceptarOferta
 *     msg=La mesa ya estaba tomada  in={"token":"…"} out={"estado":"perdida"}
 *
 * Niveles:
 *   INFO     pasó algo y quedó constancia
 *   WARN     algo no salió como debía pero la app siguió
 *   ERROR    algo se rompió
 *
 * Tres cosas que este archivo defiende:
 *
 *   1. NADA de secretos en disco. Los tokens de las ofertas son llaves —
 *      quien los lea se queda con la mesa—, y el PIN del panel abre la
 *      agenda entera. Todo eso se tapa antes de escribir.
 *   2. Escribir en el log NUNCA puede tumbar una petición. Si el disco
 *      falla, se sigue.
 *   3. Se recorta. Un cuerpo de 200 KB en una línea hace el archivo
 *      inservible justo cuando más se necesita.
 *
 * En Render el disco es efímero: los logs se pierden en cada despliegue.
 * Para eso está GET /api/admin/logs, que los lee desde el panel mientras el
 * proceso viva.
 * ==========================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LOGS_DIR = process.env.GUAYACAN_LOGS_DIR || path.join(RAIZ, 'logs');

/** Cuántos caracteres de entrada o salida caben en una línea. */
const TOPE_CAMPO = 1200;
/** Días que se guardan antes de borrar los viejos. */
const DIAS_QUE_SE_GUARDAN = Number(process.env.GUAYACAN_LOGS_DIAS) || 30;

const NIVELES = new Set(['INFO', 'WARN', 'ERROR']);

/* ══════════════════════════════════════════════════════ tapar lo sensible ══ */

/**
 * Nombres de campo que no se escriben nunca, vengan de donde vengan.
 * Se compara en minúsculas y por contenido, no exacto: así `x-admin-pin`,
 * `adminPin` y `pin` caen todos.
 */
const PROHIBIDOS = [
  'token', 'pin', 'password', 'contrasena', 'contraseña', 'clave',
  'apikey', 'api_key', 'authorization', 'secret', 'cookie', 'redis_url'
];

const esProhibido = (llave) => {
  const k = String(llave).toLowerCase();
  return PROHIBIDOS.some((p) => k.includes(p));
};

/* ─────────────────────────────────────────────── datos de los huéspedes ── */

/**
 * Los datos personales NO se copian al log.
 *
 * El huésped entregó su nombre, su teléfono y su correo para reservar una
 * mesa, no para quedar en un archivo de texto que vive treinta días y que
 * abre cualquiera que entre al servidor. Y las notas son campo libre: ahí
 * la gente escribe alergias, embarazos, silla de ruedas. Eso es información
 * de salud y no tiene por qué estar aquí.
 *
 * Pero un log donde no se sepa de quién se habla no sirve para investigar.
 * El equilibrio: se guarda lo justo para reconocer y cruzar —iniciales,
 * últimos cuatro del teléfono, el dominio del correo— y el código de la
 * reserva, que es la llave para ir a buscar los datos completos a la base,
 * que es donde sí corresponde que estén.
 *
 * Cada entrada es el nombre del campo, en español y en inglés, porque el
 * chat y el MCP hablan en español y la API en inglés.
 */
const PERSONALES = {
  name: iniciales,
  nombre: iniciales,
  email: correoParcial,
  correo: correoParcial,
  para: correoParcial,
  to: correoParcial,
  from: correoParcial,
  remitente: correoParcial,
  phone: ultimosDelTelefono,
  telefono: ultimosDelTelefono,
  notes: textoLibre,
  notas: textoLibre,
  observaciones: textoLibre
};

/** «Rosa Emilia Batista» → «Rosa E. B.». Reconocible, no es un directorio. */
function iniciales(valor) {
  const partes = String(valor).trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '«—»';
  return [partes[0], ...partes.slice(1).map((p) => `${p[0]}.`)].join(' ');
}

/** El dominio se queda: sirve para diagnosticar entregas. El resto no. */
function correoParcial(valor) {
  const m = String(valor).match(/([^\s<]+)@([^\s>]+)/);
  if (!m) return '«correo»';
  return `${m[1].slice(0, 1)}***@${m[2]}`;
}

/** Los últimos cuatro alcanzan para cotejar con el huésped al teléfono. */
function ultimosDelTelefono(valor) {
  const digitos = String(valor).replace(/\D/g, '');
  return digitos.length < 4 ? '«tel»' : `***${digitos.slice(-4)}`;
}

/** Campo libre: ahí va lo más delicado. No se copia nada, solo el tamaño. */
function textoLibre(valor) {
  return String(valor).trim() ? `«texto libre: ${String(valor).length} car.»` : '';
}

/* ─────────────────────────────────────────────────────────── secretos ── */

/**
 * Deja ver que el dato existía y cómo empezaba, sin entregarlo. Un token
 * cortado no abre nada, pero sirve para cruzarlo con otra línea del log.
 */
const tapar = (valor) => {
  const s = String(valor);
  if (s.length <= 8) return '«oculto»';
  return `${s.slice(0, 4)}…«oculto:${s.length}»`;
};

/** Copia un valor dejándolo apto para escribir: sin secretos y sin novelas. */
export function limpiar(valor, profundidad = 0) {
  if (valor === null || valor === undefined) return valor;
  if (profundidad > 4) return '«…»';

  if (typeof valor === 'string') return valor.length > TOPE_CAMPO ? `${valor.slice(0, TOPE_CAMPO)}…` : valor;
  if (typeof valor !== 'object') return valor;

  if (Array.isArray(valor)) {
    const corto = valor.slice(0, 20).map((v) => limpiar(v, profundidad + 1));
    if (valor.length > 20) corto.push(`«y ${valor.length - 20} más»`);
    return corto;
  }

  if (valor instanceof Error) return { error: valor.message, tipo: valor.name };

  const salida = {};
  for (const [k, v] of Object.entries(valor)) {
    const comoPersonal = PERSONALES[String(k).toLowerCase()];
    // El enmascarado personal es para valores sueltos. Un campo que se llame
    // «correo» pero traiga un objeto es un contenedor —el correo armado, por
    // ejemplo—: ahí hay que entrar, no taparlo entero.
    const esValorSuelto = v !== null && v !== '' && v !== undefined && typeof v !== 'object';

    if (esProhibido(k)) salida[k] = tapar(v);
    else if (comoPersonal && esValorSuelto) salida[k] = comoPersonal(v);
    else salida[k] = limpiar(v, profundidad + 1);
  }
  return salida;
}

/* ══════════════════════════════════════════════════════════════ escritura ══ */

const dosDigitos = (n) => String(n).padStart(2, '0');

/** AAAAMMDD en hora local: el nombre del archivo del día. */
export function diaDeHoy(d = new Date()) {
  return `${d.getFullYear()}${dosDigitos(d.getMonth() + 1)}${dosDigitos(d.getDate())}`;
}

/** Marca de tiempo legible, en hora local: es la que uno busca en el archivo. */
const sello = (d = new Date()) =>
  `${d.getFullYear()}-${dosDigitos(d.getMonth() + 1)}-${dosDigitos(d.getDate())} ` +
  `${dosDigitos(d.getHours())}:${dosDigitos(d.getMinutes())}:${dosDigitos(d.getSeconds())}.` +
  String(d.getMilliseconds()).padStart(3, '0');

let flujo = null;
let diaAbierto = null;
let avisadoDelDisco = false;

/** El archivo del día, abierto para añadir. Cambia solo al cambiar el día. */
function archivoDelDia() {
  const hoy = diaDeHoy();
  if (flujo && diaAbierto === hoy) return flujo;

  try {
    if (flujo) flujo.end();
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    flujo = fs.createWriteStream(path.join(LOGS_DIR, `${hoy}.log`), { flags: 'a' });
    // Sin este manejador, un fallo de disco tumba el proceso entero.
    flujo.on('error', (err) => {
      if (!avisadoDelDisco) {
        avisadoDelDisco = true;
        console.error(`[log] no puedo escribir en ${LOGS_DIR}: ${err.message}`);
      }
    });
    diaAbierto = hoy;
    barrerViejos();
    return flujo;
  } catch (err) {
    if (!avisadoDelDisco) {
      avisadoDelDisco = true;
      console.error(`[log] no puedo abrir ${LOGS_DIR}: ${err.message}`);
    }
    return null;
  }
}

/** Borra los archivos que ya pasaron de viejos. Corre una vez al día. */
function barrerViejos() {
  try {
    const limite = new Date();
    limite.setDate(limite.getDate() - DIAS_QUE_SE_GUARDAN);
    const corte = diaDeHoy(limite);
    for (const nombre of fs.readdirSync(LOGS_DIR)) {
      const m = nombre.match(/^(\d{8})\.log$/);
      if (m && m[1] < corte) fs.rmSync(path.join(LOGS_DIR, nombre), { force: true });
    }
  } catch {
    /* si no se puede barrer, no es motivo para dejar de registrar */
  }
}

const trozo = (etiqueta, valor) => {
  if (valor === undefined) return '';
  const texto = typeof valor === 'string' ? valor : JSON.stringify(limpiar(valor));
  if (texto === undefined) return '';
  const recortado = texto.length > TOPE_CAMPO ? `${texto.slice(0, TOPE_CAMPO)}…` : texto;
  return `  ${etiqueta}=${recortado}`;
};

/**
 * Registra un suceso.
 *
 * @param {object} e
 * @param {'INFO'|'WARN'|'ERROR'} [e.nivel]  qué tan grave. INFO por defecto.
 * @param {string} e.actor     quién lo provocó: huésped, equipo, sistema, chat, mcp…
 * @param {string} e.fn        en qué función pasó
 * @param {string} [e.msg]     una frase que lo explique
 * @param {*} [e.entrada]      con qué se entró
 * @param {*} [e.salida]       con qué se salió
 * @param {number} [e.ms]      cuánto tardó
 */
export function registrar({ nivel = 'INFO', actor = 'sistema', fn = '—', msg, entrada, salida, ms }) {
  const grado = NIVELES.has(nivel) ? nivel : 'INFO';

  const linea =
    `[${sello()}] ${grado.padEnd(5)}` +
    trozo('actor', actor) +
    trozo('fn', fn) +
    (msg ? trozo('msg', String(msg).replace(/\s+/g, ' ')) : '') +
    trozo('in', entrada) +
    trozo('out', salida) +
    (ms === undefined ? '' : trozo('ms', String(Math.round(ms)))) +
    '\n';

  // El disco es el destino; que falle no puede costar una petición.
  try {
    archivoDelDia()?.write(linea);
  } catch {
    /* ya se avisó por consola */
  }

  // Lo grave además se ve en la consola, que es donde mira Render.
  if (grado === 'ERROR') process.stderr.write(linea);
  else if (grado === 'WARN' && process.env.GUAYACAN_LOGS_CONSOLA !== 'off') process.stderr.write(linea);

  return linea;
}

export const info = (e) => registrar({ ...e, nivel: 'INFO' });
export const aviso = (e) => registrar({ ...e, nivel: 'WARN' });
export const error = (e) => registrar({ ...e, nivel: 'ERROR' });

/* ═══════════════════════════════════════════════════════════════ lectura ══ */

/** Qué días hay guardados, del más nuevo al más viejo. */
export function diasGuardados() {
  try {
    return fs
      .readdirSync(LOGS_DIR)
      .filter((n) => /^\d{8}\.log$/.test(n))
      .map((n) => n.slice(0, 8))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Las líneas de un día, de la más nueva a la más vieja.
 * Para leerlo desde el panel cuando no se puede entrar al disco (Render).
 */
export function leerDia({ dia = diaDeHoy(), nivel = null, buscar = null, limite = 300 } = {}) {
  if (!/^\d{8}$/.test(String(dia))) return { dia, lineas: [], total: 0 };

  let crudo = '';
  try {
    crudo = fs.readFileSync(path.join(LOGS_DIR, `${dia}.log`), 'utf8');
  } catch {
    return { dia, lineas: [], total: 0 };
  }

  let lineas = crudo.split('\n').filter(Boolean);
  const total = lineas.length;

  if (nivel) lineas = lineas.filter((l) => l.includes(`] ${String(nivel).toUpperCase().padEnd(5)}`));
  if (buscar) {
    const aguja = String(buscar).toLowerCase();
    lineas = lineas.filter((l) => l.toLowerCase().includes(aguja));
  }

  return { dia, total, coinciden: lineas.length, lineas: lineas.slice(-limite).reverse() };
}

/** Cierra el archivo al apagar, para no dejar líneas a medias. */
export function cerrarLog() {
  return new Promise((listo) => {
    if (!flujo) return listo();
    flujo.end(listo);
    flujo = null;
    diaAbierto = null;
  });
}
