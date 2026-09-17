/**
 * ==========================================================================
 * Los correos de El Guayacán
 * ==========================================================================
 * Cada plantilla devuelve { asunto, html, texto }. El texto plano no es un
 * adorno: hay clientes que no pintan HTML, y un correo sin alternativa cae
 * más fácil en spam.
 *
 * HTML de correo, no de web: tablas, estilos en línea y nada de flexbox.
 * Outlook sigue usando el motor de Word.
 * ==========================================================================
 */

import { RESTAURANT, ZONES, EXPERIENCES, PREFERENCES, OCCASIONS } from '../config.js';
import { prettyDate, prettyTime } from '../time.js';

const ORO = '#b07d1f';
const TINTA = '#221c14';
const PAPEL = '#faf6ee';
const LINEA = '#e4dccb';

const money = (n) => `$ ${Math.round(n || 0).toLocaleString('es-CO')}`;
const people = (n) => `${n} ${n === 1 ? 'persona' : 'personas'}`;
const zoneName = (id) => (ZONES.find((z) => z.id === id) || {}).name || 'Salón por asignar';
const hhmmDe = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const occasionLabel = (id) => (OCCASIONS.find((o) => o.id === id) || {}).label || id;

/** El sitio, para los enlaces. En Render se fija con PUBLIC_URL. */
const sitio = () => (process.env.PUBLIC_URL || 'http://127.0.0.1:4321').replace(/\/$/, '');

/* ══════════════════════════════════════════════════════════ el envoltorio */

function envoltura({ titulo, entradilla, filas, cuerpo = '', boton = null, pie = '' }) {
  const tabla = filas
    .filter(Boolean)
    .map(
      ([k, v]) => `<tr>
        <td style="padding:10px 0;border-top:1px solid ${LINEA};color:#6f6757;font-size:14px;width:40%">${k}</td>
        <td style="padding:10px 0;border-top:1px solid ${LINEA};color:${TINTA};font-size:14px;font-weight:600">${v}</td>
      </tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${titulo}</title></head>
<body style="margin:0;padding:0;background:#efece3;font-family:Georgia,'Times New Roman',serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#efece3;padding:28px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
        style="max-width:560px;background:${PAPEL};border:1px solid ${LINEA};border-radius:6px;overflow:hidden">

        <tr><td style="background:${TINTA};padding:22px 28px">
          <div style="color:${ORO};font-size:11px;letter-spacing:3px;text-transform:uppercase;font-family:Helvetica,Arial,sans-serif">
            ${RESTAURANT.name}
          </div>
          <div style="color:#f3ede1;font-size:13px;font-family:Helvetica,Arial,sans-serif;padding-top:4px">
            ${RESTAURANT.tagline}
          </div>
        </td></tr>

        <tr><td style="padding:28px">
          <h1 style="margin:0 0 12px;font-size:24px;line-height:1.2;color:${TINTA};font-weight:500">${titulo}</h1>
          <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#4a4335">${entradilla}</p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${tabla}</table>

          ${cuerpo}

          ${
            boton
              ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 4px">
                  <tr><td style="background:${ORO};border-radius:4px">
                    <a href="${boton.href}" style="display:inline-block;padding:12px 22px;color:#fff;
                      font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;text-decoration:none">
                      ${boton.texto}</a>
                  </td></tr></table>`
              : ''
          }
        </td></tr>

        <tr><td style="padding:18px 28px;border-top:1px solid ${LINEA};background:#f4efe5">
          <p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:#6f6757;font-family:Helvetica,Arial,sans-serif">
            ${pie || `Guardamos la mesa ${RESTAURANT.holdMinutes} minutos. Cambios y cancelaciones sin costo hasta 4 horas antes.`}
          </p>
          <p style="margin:0;font-size:12px;line-height:1.6;color:#6f6757;font-family:Helvetica,Arial,sans-serif">
            ${RESTAURANT.address} · ${RESTAURANT.phone}<br />
            <a href="${sitio()}" style="color:${ORO}">${sitio().replace(/^https?:\/\//, '')}</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

/** El mismo contenido, en texto plano. */
const plano = (titulo, entradilla, filas, extra = '') =>
  [
    RESTAURANT.name.toUpperCase(),
    '',
    titulo,
    '',
    entradilla,
    '',
    ...filas.filter(Boolean).map(([k, v]) => `${k}: ${String(v).replace(/<[^>]+>/g, '')}`),
    extra ? `\n${extra}` : '',
    '',
    `${RESTAURANT.address} · ${RESTAURANT.phone}`,
    sitio()
  ]
    .join('\n')
    .trim();

/* ════════════════════════════════════════════════════════════ plantillas */

const datos = (r) => [
  ['Código', `<span style="font-family:monospace;letter-spacing:1px">${r.code}</span>`],
  ['A nombre de', r.name],
  ['Cuándo', `${prettyDate(r.date, true)}, ${prettyTime(r.time)}`],
  ['Personas', people(r.party)],
  ['Dónde', `${zoneName(r.zone)} · mesa ${r.tableId}`],
  r.occasion && r.occasion !== 'ninguna' ? ['Ocasión', occasionLabel(r.occasion)] : null
];

export const PLANTILLAS = {
  /** Al crear la reserva. */
  confirmacion(r) {
    const pendiente = r.pago && r.pago.requerido && r.pago.estado !== 'pagado';
    const nombre = r.name.split(' ')[0];

    const extras = EXPERIENCES.filter((e) => (r.experiences || []).includes(e.id));
    const prefs = PREFERENCES.filter((p) => (r.preferences || []).includes(p.id)).map((p) => p.label);

    const filas = [
      ...datos(r),
      extras.length ? ['Experiencias', extras.map((e) => e.name).join(', ')] : null,
      prefs.length ? ['Preferencias', prefs.join(', ')] : null,
      pendiente ? ['Falta pagar', money(r.pago.monto)] : null
    ];

    const titulo = pendiente ? 'Su mesa está apartada' : 'Su mesa está confirmada';
    const entradilla = pendiente
      ? `${nombre}, le apartamos la mesa. Queda en firme cuando recibamos el pago de ${money(r.pago.monto)}, que se abona a su consumo.`
      : `${nombre}, lo esperamos. Aquí queda el detalle de su reserva.`;

    return {
      asunto: pendiente
        ? `Falta un paso para su mesa · ${r.code}`
        : `Reserva confirmada · ${prettyDate(r.date)} · ${r.code}`,
      html: envoltura({
        titulo,
        entradilla,
        filas,
        boton: pendiente
          ? { href: `${sitio()}/?pagar=${r.code}`, texto: `Pagar ${money(r.pago.monto)}` }
          : { href: `${sitio()}/api/reservations/${r.code}/ics`, texto: 'Agregar al calendario' }
      }),
      texto: plano(titulo, entradilla, filas, pendiente ? `Pague en: ${sitio()}/?pagar=${r.code}` : '')
    };
  },

  /** Cuando entra el pago. */
  pago(r) {
    const filas = [
      ...datos(r),
      ['Pagado', money(r.pago.monto)],
      r.pago.metodoLabel ? ['Método', r.pago.metodoLabel] : null,
      r.pago.referencia ? ['Referencia', `<span style="font-family:monospace">${r.pago.referencia}</span>`] : null
    ];
    const titulo = 'Pago recibido';
    const entradilla = `${r.name.split(' ')[0]}, recibimos su pago y la mesa quedó en firme. El valor se abona a su consumo esa noche.`;

    return {
      asunto: `Pago recibido · ${r.code}`,
      html: envoltura({
        titulo,
        entradilla,
        filas,
        // Si falta pagar, el botón lleva a pagar. Mandar al calendario una
        // mesa que todavía no está en firme es mandarlo al lugar equivocado.
        boton: pendiente
          ? { href: `${sitio()}/?pagar=${r.code}`, texto: `Pagar ${money(r.pago.monto)}` }
          : { href: `${sitio()}/api/reservations/${r.code}/ics`, texto: 'Agregar al calendario' },
        pie: 'Este correo sirve como comprobante de su reserva.'
      }),
      texto: plano(titulo, entradilla, filas)
    };
  },

  /** Un día antes. Es el trabajo retrasado que justifica la cola. */
  recordatorio(r) {
    const filas = datos(r);
    const titulo = 'Lo esperamos mañana';
    const entradilla = `${r.name.split(' ')[0]}, le recordamos su mesa de mañana. Si algo cambió, avísenos y la movemos.`;

    return {
      asunto: `Mañana lo esperamos · ${prettyTime(r.time)} · ${r.code}`,
      html: envoltura({
        titulo,
        entradilla,
        filas,
        boton: { href: `${sitio()}/#mi-reserva`, texto: 'Cambiar o cancelar' },
        pie: `Guardamos la mesa ${RESTAURANT.holdMinutes} minutos. Si se le hace tarde, escríbanos al ${RESTAURANT.whatsapp}.`
      }),
      texto: plano(titulo, entradilla, filas, `Cambiar o cancelar: ${sitio()}/#mi-reserva`)
    };
  },

  /** Al cancelar. */
  cancelacion(r) {
    const filas = datos(r);
    const titulo = 'Reserva cancelada';
    const entradilla = `${r.name.split(' ')[0]}, cancelamos su reserva. La mesa vuelve a la agenda y esperamos verlo en otra ocasión.`;

    return {
      asunto: `Reserva cancelada · ${r.code}`,
      html: envoltura({
        titulo,
        entradilla,
        filas,
        boton: { href: `${sitio()}/#reservar`, texto: 'Reservar otro día' },
        pie: 'Si esto fue un error, escríbanos y la reactivamos si todavía hay mesa.'
      }),
      texto: plano(titulo, entradilla, filas)
    };
  },

  /**
   * Se soltó una mesa y le toca a esta persona de la lista de espera.
   * Lleva la hora límite en letra grande: una oferta sin fecha de
   * vencimiento visible es una trampa.
   */
  oferta(entry) {
    const o = entry.offer;
    const nombre = entry.name.split(' ')[0];
    const limite = prettyTime(hhmmDe(o.venceAt));
    const paga = o.monto > 0;

    const filas = [
      ['A nombre de', entry.name],
      ['Cuándo', `${prettyDate(o.date, true)}, ${prettyTime(o.time)}`],
      ['Personas', people(entry.party)],
      ['Dónde', zoneName(o.zone)],
      paga ? ['Para dejarla en firme', money(o.monto)] : null,
      ['Tiene hasta', `<span style="color:#a23b1e">${limite}</span>`]
    ];

    const titulo = 'Se soltó una mesa';
    const entradilla = `${nombre}, se desocupó una mesa el ${prettyDate(o.date)} a las ${prettyTime(
      o.time
    )} y usted es el primero de la lista. Si la quiere, tómela antes de las ${limite}; después se la ofrecemos a quien sigue.`;

    const cuerpo = paga
      ? `<p style="margin:20px 0 0;font-size:14px;line-height:1.6;color:#6f6757">
           La mesa queda en firme cuando reciba el pago de ${money(o.monto)}, que se abona a su consumo.
           Si no alcanza a pagar dentro de ese mismo tiempo, la mesa vuelve a la lista.
         </p>`
      : '';

    return {
      asunto: `Se soltó una mesa · ${prettyDate(o.date)} ${prettyTime(o.time)}`,
      html: envoltura({
        titulo,
        entradilla,
        filas,
        cuerpo,
        boton: { href: `${sitio()}/espera?t=${o.token}`, texto: 'Quiero esa mesa' },
        pie: 'Este correo es solo para usted. Nadie más tiene esta mesa apartada mientras tanto, así que conviene no dejarlo para después.'
      }),
      texto: plano(titulo, entradilla, filas, `Tomar la mesa: ${sitio()}/espera?t=${o.token}`)
    };
  },

  /** Se le venció, la rechazó, o alguien se le adelantó. */
  'oferta-cerrada'(entry) {
    const o = entry.offer;
    const nombre = entry.name.split(' ')[0];
    const filas = [
      ['Era para', `${prettyDate(o.date, true)}, ${prettyTime(o.time)}`],
      ['Personas', people(entry.party)]
    ];

    const titulo = 'No alcanzamos esta vez';
    const entradilla =
      o.resultado === 'perdida'
        ? `${nombre}, se nos adelantaron por segundos y esa mesa ya quedó tomada. Usted sigue en la lista, en el mismo puesto, y le escribimos si se suelta otra.`
        : `${nombre}, se venció el tiempo de la mesa que le ofrecimos y se la pasamos a quien seguía. Si todavía quiere venir ese día, reserve directo o vuelva a anotarse.`;

    return {
      asunto: `No alcanzamos la mesa del ${prettyDate(o.date)}`,
      html: envoltura({
        titulo,
        entradilla,
        filas,
        boton: { href: `${sitio()}/#reservar`, texto: 'Ver otros horarios' },
        pie: `Si quiere que le busquemos algo a la medida, escríbanos al ${RESTAURANT.whatsapp}.`
      }),
      texto: plano(titulo, entradilla, filas, `Otros horarios: ${sitio()}/#reservar`)
    };
  }
};

export const TIPOS = Object.keys(PLANTILLAS);

/** Arma el correo de un tipo para una reserva. */
export function render(tipo, reservation) {
  const plantilla = PLANTILLAS[tipo];
  if (!plantilla) throw new Error(`No existe la plantilla "${tipo}".`);
  return { ...plantilla(reservation), tipo, para: reservation.email, code: reservation.code };
}

/**
 * Los correos de la lista de espera no cuelgan de una reserva —todavía no
 * existe—, sino del registro de la lista y su oferta.
 */
export function renderEspera(tipo, entry) {
  const plantilla = PLANTILLAS[tipo];
  if (!plantilla) throw new Error(`No existe la plantilla "${tipo}".`);
  return { ...plantilla(entry), tipo, para: entry.email, code: entry.offer ? entry.offer.id : entry.id };
}
