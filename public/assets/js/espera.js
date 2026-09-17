/* ==========================================================================
   La pantalla a la que cae el huésped desde el correo de «se soltó una mesa».
   Una sola decisión: la tomo o no la tomo, con el reloj corriendo a la vista.
   ========================================================================== */

import { $, esc, fill, api } from './lib.js';

const token = new URLSearchParams(location.search).get('t') || '';
const cuerpo = $('#cuerpo');

const money = (n) => `$ ${Math.round(n || 0).toLocaleString('es-CO')}`;
let cronometro = null;

/* ------------------------------------------------------------------ pintar */

function pantalla({ icono, titulo, texto, filas = [], reloj = null, acciones = '', pie = '' }) {
  clearInterval(cronometro);

  const tabla = filas.length
    ? `<table class="oferta-datos">${filas
        .filter(Boolean)
        .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
        .join('')}</table>`
    : '';

  fill(
    cuerpo,
    `${icono ? `<div class="estado-icono">${icono}</div>` : ''}
     <h1>${esc(titulo)}</h1>
     <p>${texto}</p>
     ${reloj ? '<div class="reloj" id="reloj"><b>—</b><span>para decidir</span></div>' : ''}
     ${tabla}
     ${acciones ? `<div class="oferta-acciones">${acciones}</div>` : ''}`
  );

  const pieEl = document.querySelector('.oferta-pie');
  if (pie) {
    const html = `<div class="oferta-pie">${pie}</div>`;
    if (pieEl) pieEl.outerHTML = html;
    else $('#oferta').insertAdjacentHTML('beforeend', html);
  } else if (pieEl) {
    pieEl.remove();
  }

  if (reloj) arrancarReloj(reloj);
}

/**
 * La cuenta regresiva. Cuando llega a cero no recarga sola ni hace trampa:
 * cambia el botón por el aviso de que se venció, que es la verdad.
 */
function arrancarReloj(venceAt) {
  const el = $('#reloj');
  const fin = Date.parse(venceAt);

  const pintar = () => {
    const falta = fin - Date.now();
    if (falta <= 0) {
      clearInterval(cronometro);
      verOferta();
      return;
    }
    // Pasada la hora se muestra «1h 29m»: «89:53» se lee como si fueran
    // ochenta y nueve horas. Bajo la hora sí van minutos y segundos.
    const total = Math.floor(falta / 1000);
    const h = Math.floor(total / 3600);
    const min = Math.floor((total % 3600) / 60);
    const seg = total % 60;
    el.querySelector('b').textContent = h
      ? `${h}h ${String(min).padStart(2, '0')}m`
      : `${min}:${String(seg).padStart(2, '0')}`;
    el.classList.toggle('is-poco', falta < 5 * 60000);
  };

  pintar();
  cronometro = setInterval(pintar, 1000);
}

/* ----------------------------------------------------------------- estados */

const botones = `
  <button class="btn btn-gold" type="button" data-accion="aceptar">Sí, quiero esa mesa</button>
  <button class="btn btn-ghost" type="button" data-accion="rechazar">No puedo, que la tome otro</button>`;

function verAbierta(o) {
  pantalla({
    titulo: 'Se soltó una mesa',
    texto: `${esc(o.nombre)}, esta mesa es suya si la toma antes de que se acabe el tiempo. Después se la ofrecemos a quien sigue en la lista.`,
    reloj: o.venceAt,
    filas: [
      ['Cuándo', o.cuando],
      ['Personas', `${o.personas} ${o.personas === 1 ? 'persona' : 'personas'}`],
      ['Dónde', o.salon],
      o.monto ? ['Para dejarla en firme', money(o.monto)] : null
    ],
    acciones: botones,
    pie: o.monto
      ? `La mesa queda en firme cuando reciba el pago de ${money(o.monto)}, que se abona a su consumo. Si no alcanza a pagar dentro de ese mismo tiempo, la mesa vuelve a la lista.`
      : 'Nadie más tiene esta mesa apartada mientras tanto.'
  });
}

function verCerrada(o, tipo) {
  const textos = {
    vencida: {
      icono: '⏳',
      titulo: 'Se acabó el tiempo',
      texto: 'Esta mesa ya se la ofrecimos a quien seguía en la lista. Si todavía quiere venir ese día, mire los horarios que hay libres.'
    },
    perdida: {
      icono: '⏱️',
      titulo: 'Se nos adelantaron',
      texto: 'Alguien tomó esa mesa por segundos. <b>Usted sigue en la lista, en el mismo puesto</b>, y le escribimos si se suelta otra.'
    },
    cerrada: {
      icono: '✓',
      titulo: 'Esta oferta ya se cerró',
      texto: 'No hay nada pendiente por aquí. Si quiere venir, reserve directo.'
    }
  };
  const t = textos[tipo] || textos.cerrada;
  pantalla({
    ...t,
    filas: o.cuando ? [['Era para', o.cuando], ['Personas', String(o.personas)]] : [],
    acciones: '<a class="btn btn-gold" href="/#reservar">Ver otros horarios</a>'
  });
}

function verAceptada(o, mensaje) {
  pantalla({
    icono: '🎉',
    titulo: 'La mesa es suya',
    texto: esc(mensaje || 'Le llega la confirmación por correo.'),
    filas: [
      ['Código', o.code],
      ['Cuándo', o.cuando],
      ['Personas', `${o.personas}`],
      ['Dónde', o.salon]
    ],
    acciones: o.monto
      ? `<a class="btn btn-gold" href="/?pagar=${encodeURIComponent(o.code)}">Pagar ${money(o.monto)}</a>
         <a class="btn btn-ghost" href="/#mi-reserva">Ver mi reserva</a>`
      : '<a class="btn btn-gold" href="/#mi-reserva">Ver mi reserva</a>',
    pie: o.monto
      ? 'Mientras no entre el pago, la mesa sigue apartada pero no en firme.'
      : 'Guardamos la mesa 15 minutos pasada la hora.'
  });
}

/* ------------------------------------------------------------------ cargar */

async function verOferta() {
  if (!token) {
    pantalla({
      icono: '🔗',
      titulo: 'Falta el enlace',
      texto: 'Abra esta página desde el botón del correo que le mandamos.',
      acciones: '<a class="btn btn-gold" href="/">Ir al restaurante</a>'
    });
    return;
  }

  let data;
  try {
    data = await api(`/api/espera/${encodeURIComponent(token)}`);
  } catch (err) {
    pantalla({
      icono: '🔗',
      titulo: 'Este enlace no sirve',
      texto: esc(err.message),
      acciones: '<a class="btn btn-gold" href="/#reservar">Reservar directo</a>'
    });
    return;
  }

  const o = data.oferta;
  if (o.estado === 'abierta') verAbierta(o);
  else if (o.estado === 'aceptada') verAceptada(o);
  else verCerrada(o, o.estado);
}

/* ---------------------------------------------------------------- acciones */

cuerpo.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-accion]');
  if (!btn) return;

  const accion = btn.dataset.accion;
  // Doble clic nervioso: el servidor es idempotente, pero el botón no debe
  // parecer que no pasó nada.
  document.querySelectorAll('[data-accion]').forEach((b) => (b.disabled = true));
  btn.textContent = accion === 'aceptar' ? 'Apartando…' : 'Un momento…';

  try {
    if (accion === 'rechazar') {
      const res = await api(`/api/espera/${encodeURIComponent(token)}/rechazar`, { method: 'POST' });
      pantalla({
        icono: '👋',
        titulo: 'Listo, gracias por avisar',
        texto: esc(res.message),
        acciones: '<a class="btn btn-gold" href="/#reservar">Ver otros horarios</a>'
      });
      return;
    }

    const res = await api(`/api/espera/${encodeURIComponent(token)}/aceptar`, { method: 'POST' });
    const r = res.reservation;
    verAceptada(
      {
        code: r.code,
        cuando: `${r.prettyDate}, ${r.prettyTime}`,
        personas: r.party,
        salon: r.zoneName,
        monto: r.pago && r.pago.estado === 'pendiente' ? r.pago.monto : 0
      },
      res.message
    );
  } catch (err) {
    // 409 es la carrera perdida; 410 es que se venció. Los dos merecen su
    // propia pantalla, no un toast que se va.
    if (err.status === 409) verCerrada({ cuando: '', personas: '' }, 'perdida');
    else if (err.status === 410) verCerrada({ cuando: '', personas: '' }, 'vencida');
    else {
      document.querySelectorAll('[data-accion]').forEach((b) => (b.disabled = false));
      verOferta();
    }
  }
});

verOferta();
