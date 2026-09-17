/* ==========================================================================
   El Guayacán · panel de sala.
   Agenda del día, plano en vivo, línea de tiempo por mesa y analítica.
   ========================================================================== */

import {
  $, $$, esc, fill, api, toast, money, plural, download, setAdminPin,
  prettyDate, prettyTime, toISO, addDays, toMinutes, toHHMM, DIAS, MESES_CORTO, debounce
} from './lib.js';

const PLAN_W = 0.84375;
const PLAN_H = 1.5;
const PIN_KEY = 'guayacan.pin';

const state = {
  pin: null,
  config: null,
  date: null,
  day: null,
  floorTime: null,
  tab: 'servicio',
  search: '',
  statusFilter: ''
};

boot();

/* ═══════════════════════════════════════════════════════════════════ acceso */

async function boot() {
  // La pista del PIN solo se muestra si el servidor sigue con el de
  // demostración. Desplegado, el PIN es otro y no se pregona.
  try {
    const info = await api('/api/config');
    if (info.demoPin) {
      const hint = $('#gateHint');
      hint.innerHTML = 'Demostración: el PIN es <code class="mono">2408</code>.';
      hint.hidden = false;
    }
  } catch {
    /* sin config: simplemente no hay pista */
  }

  const saved = sessionStorage.getItem(PIN_KEY);
  if (saved) enter(saved, { silent: true });

  $('#gateForm').addEventListener('submit', (e) => {
    e.preventDefault();
    enter($('#gatePin').value.trim());
  });
}

async function enter(pin, { silent = false } = {}) {
  try {
    await api('/api/admin/login', { method: 'POST', body: { pin } });
  } catch (err) {
    sessionStorage.removeItem(PIN_KEY);
    if (!silent) toast(err.message, 'error');
    return;
  }
  state.pin = pin;
  setAdminPin(pin);
  sessionStorage.setItem(PIN_KEY, pin);
  $('#gate').hidden = true;
  $('#app').hidden = false;
  start();
}

/* ═════════════════════════════════════════════════════════════════ arranque */

async function start() {
  state.config = await api('/api/config');
  // Si hoy la casa descansa, el panel abre en el próximo día de servicio.
  state.date = firstServiceDay(state.config.today);

  $('#dayInput').value = state.date;
  $('#statusFilter').innerHTML =
    '<option value="">Todos los estados</option>' +
    state.config.statuses.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join('');

  $('#blockScope').innerHTML =
    '<option value="all">Todo el restaurante</option>' +
    state.config.zones.map((z) => `<option value="${z.id}">${esc(z.name)}</option>`).join('') +
    state.config.tables.map((t) => `<option value="${t.id}">Mesa ${t.id}</option>`).join('');

  $('#newZone').innerHTML =
    '<option value="">Cualquiera</option>' +
    state.config.zones.map((z) => `<option value="${z.id}">${esc(z.name)}</option>`).join('');
  $('#newTable').innerHTML =
    '<option value="">Automática</option>' +
    state.config.tables.map((t) => `<option value="${t.id}">${t.id} · ${t.min}-${t.max} p.</option>`).join('');

  wireChrome();
  await loadDay();
  setInterval(() => {
    if (state.tab === 'servicio' && state.date === state.config.today) loadDay({ quiet: true });
  }, 60000);
}

function firstServiceDay(from) {
  for (let i = 0; i < 8; i += 1) {
    const date = addDays(from, i);
    const entry = state.config.hours.find((h) => h.day === new Date(`${date}T12:00`).getDay());
    if (entry && entry.services.length) return date;
  }
  return from;
}

function wireChrome() {
  $('#dayInput').addEventListener('change', (e) => {
    state.date = e.target.value || state.config.today;
    loadDay();
  });

  $$('[data-day]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const move = btn.dataset.day;
      state.date = move === 'today' ? state.config.today : addDays(state.date, Number(move));
      $('#dayInput').value = state.date;
      loadDay();
    })
  );

  $('#adminTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    state.tab = btn.dataset.tab;
    $$('#adminTabs .chip').forEach((b) => b.classList.toggle('is-on', b === btn));
    $$('[data-tab-panel]').forEach((p) => {
      p.hidden = p.dataset.tabPanel !== state.tab;
    });
    if (state.tab === 'analitica') loadStats();
    if (state.tab === 'espera') loadWaitlist();
    if (state.tab === 'correos') loadMail();
  });

  $('#search').addEventListener(
    'input',
    debounce((e) => {
      state.search = e.target.value.toLowerCase();
      renderList();
    }, 180)
  );

  $('#statusFilter').addEventListener('change', (e) => {
    state.statusFilter = e.target.value;
    renderList();
  });

  $('#floorTime').addEventListener('change', (e) => {
    state.floorTime = e.target.value;
    loadFloors();
  });

  $('#blockForm').addEventListener('submit', createBlock);
  $('#newForm').addEventListener('submit', createReservation);

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="export"]')) {
      download(`/api/admin/export.csv?from=${addDays(state.date, -30)}&to=${addDays(state.date, 30)}&pin=${state.pin}`);
    }
    if (e.target.closest('[data-action="new"]')) {
      $('#newForm').elements.date.value = state.date;
      $('#newDialog').showModal();
    }
    const close = e.target.closest('[data-close]');
    if (close) close.closest('dialog').close();
  });

  $$('dialog').forEach((dlg) =>
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close();
    })
  );
}

/* ══════════════════════════════════════════════════════════════════════ día */

async function loadDay({ quiet = false } = {}) {
  if (!quiet) fill($('#resList'), '<div class="empty">Cargando…</div>');
  try {
    state.day = await api(`/api/admin/day?date=${state.date}`, { admin: true });
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  const first = state.day.services[0];
  if (!state.floorTime || !quiet) {
    state.floorTime = defaultFloorTime();
    $('#floorTime').value = state.floorTime;
  }
  if (first) {
    $('#floorTime').min = first.open;
    $('#floorTime').max = state.day.services.at(-1).close;
  }

  renderDayHead();
  renderTimeline();
  renderList();
  renderBlocks();
  renderNotes();
  loadFloors();
}

function defaultFloorTime() {
  const services = state.day.services;
  if (!services.length) return '19:00';
  if (state.date === state.config.today) {
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const inside = services.find((s) => minutes >= toMinutes(s.open) && minutes <= toMinutes(s.close));
    if (inside) return toHHMM(Math.round(minutes / 15) * 15);
  }
  return services.at(-1).open;
}

function renderDayHead() {
  const day = state.day;
  const m = day.metrics;
  $('#dayTitle').textContent = day.prettyDate;
  $('#daySub').textContent = day.open
    ? `${day.services.map((s) => `${s.label} ${s.open}–${s.close}`).join('  ·  ')}`
    : 'Cerrado: los lunes descansa la casa.';

  const badStatus = (m.byStatus['no-show'] || 0) > 0;
  fill(
    $('#kpis'),
    `<div class="kpi"><b>${m.total}</b><span>reservas</span></div>
     <div class="kpi"><b>${m.covers}</b><span>cubiertos</span></div>
     <div class="kpi ${m.occupancy > 80 ? 'is-warn' : ''}"><b>${m.occupancy}%</b><span>ocupación</span></div>
     <div class="kpi"><b>${m.averageParty || '—'}</b><span>por mesa</span></div>
     <div class="kpi"><b>${m.byStatus.sentada || 0}</b><span>en mesa ahora</span></div>
     <div class="kpi ${badStatus ? 'is-bad' : ''}"><b>${m.byStatus['no-show'] || 0}</b><span>no llegaron</span></div>
     <div class="kpi"><b>${money(m.cobrado || 0)}</b><span>cobrado</span></div>
     ${
       m.porCobrar
         ? `<div class="kpi is-warn"><b>${money(m.porCobrar)}</b><span>por cobrar</span></div>`
         : ''
     }`
  );
}

/* ---------------------------------------------------------------- planos */

async function loadFloors() {
  if (!state.day || !state.day.open) {
    fill($('#floors'), '<div class="empty">Sin servicio este día.</div>');
    $('#floorSummary').textContent = '';
    return;
  }
  let data;
  try {
    data = await api(`/api/floor?date=${state.date}&time=${state.floorTime}`);
  } catch (err) {
    fill($('#floors'), `<div class="empty">${esc(err.message)}</div>`);
    return;
  }

  const busy = data.zones.flatMap((z) => z.tables).filter((t) => t.status === 'ocupada').length;
  const total = data.zones.flatMap((z) => z.tables).length;
  $('#floorSummary').textContent = `${busy} de ${total} mesas ocupadas a las ${prettyTime(state.floorTime)}`;

  fill(
    $('#floors'),
    data.zones
      .map(
        (zone) => `<div class="floor">
          <div class="floor-name"><span>${esc(zone.name)}</span><span>${zone.free} libres</span></div>
          <div class="floorplan">
            ${zone.tables
              .map((t) => {
                const cls =
                  t.status === 'ocupada'
                    ? t.reservation.status === 'sentada'
                      ? 'is-seated'
                      : 'is-busy'
                    : t.status === 'bloqueada'
                      ? 'is-blocked'
                      : 'is-free';
                const label = t.status === 'ocupada' ? `${t.reservation.party}p` : t.id;
                const title =
                  t.status === 'ocupada'
                    ? `${t.id} · ${t.reservation.name} · ${plural(t.reservation.party, 'persona', 'personas')} · ${prettyTime(
                        t.reservation.time
                      )}`
                    : `${t.id} · ${t.min}-${t.max} personas`;
                return `<button class="plan-table shape-${t.shape} ${cls}" type="button"
                  ${t.status === 'ocupada' ? `data-code="${esc(t.reservation.code)}"` : 'disabled'}
                  title="${esc(title)}"
                  style="left:${t.x}%;top:${t.y}%;width:${(t.w * PLAN_W).toFixed(2)}%;height:${(t.h * PLAN_H).toFixed(
                    2
                  )}%">${esc(label)}</button>`;
              })
              .join('')}
          </div>
        </div>`
      )
      .join('')
  );

  $('#floors').onclick = (e) => {
    const btn = e.target.closest('[data-code]');
    if (btn) openDetail(btn.dataset.code);
  };
}

/* -------------------------------------------------------------- timeline */

function renderTimeline() {
  const day = state.day;
  const host = $('#timeline');
  if (!day.open) {
    fill(host, '<div class="empty">Sin servicio este día.</div>');
    return;
  }

  const from = Math.floor(day.span.open / 60) * 60;
  const to = Math.ceil(day.span.close / 60) * 60;
  const width = to - from;
  const pct = (minutes) => ((minutes - from) / width) * 100;

  const ticks = [];
  for (let m = from; m <= to; m += 60) {
    ticks.push(`<span class="tl-tick" style="left:${pct(m)}%">${toHHMM(m)}</span>`);
  }

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const showNow = state.date === state.config.today && nowMin >= from && nowMin <= to;

  const rows = day.timeline
    .map((table) => {
      const blocks = table.bookings
        .map(
          (b) => `<button class="tl-block st-${b.status}" type="button" data-code="${esc(b.code)}"
            style="left:${pct(b.start)}%;width:${((b.end - b.start) / width) * 100}%"
            title="${esc(`${b.name} · ${plural(b.party, 'persona', 'personas')} · ${prettyTime(b.time)}`)}">
            ${b.party}p ${esc(b.name.split(' ')[0])}</button>`
        )
        .join('');
      const dayBlocks = day.blocks
        .filter((bl) => bl.scope === 'all' || bl.scope === table.zone || bl.scope === table.id)
        .map(
          (bl) => `<span class="tl-block st-no-show" style="left:${pct(toMinutes(bl.from))}%;width:${
            ((toMinutes(bl.to) - toMinutes(bl.from)) / width) * 100
          }%" title="${esc(bl.reason)}">bloqueo</span>`
        )
        .join('');
      return `<div class="tl-row">
        <span class="tl-label"><b>${table.id}</b><span>${table.max}</span></span>
        <div class="tl-track">
          <span class="tl-grid" style="--tick:${(60 / width) * 100}%"></span>
          ${dayBlocks}${blocks}
          ${showNow ? `<span class="tl-now" style="left:${pct(nowMin)}%"></span>` : ''}
        </div>
      </div>`;
    })
    .join('');

  fill(
    host,
    `<div class="tl-row tl-head">
      <span class="tl-label">mesa</span>
      <div class="tl-ticks">${ticks.join('')}</div>
    </div>${rows}`
  );

  host.onclick = (e) => {
    const btn = e.target.closest('[data-code]');
    if (btn) openDetail(btn.dataset.code);
  };
}

/* ------------------------------------------------------------------ lista */

function renderList() {
  const host = $('#resList');
  let rows = state.day.reservations;
  if (state.statusFilter) rows = rows.filter((r) => r.status === state.statusFilter);
  if (state.search) {
    const q = state.search;
    rows = rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.code.toLowerCase().includes(q) ||
        r.phone.includes(q) ||
        r.tableId.toLowerCase() === q
    );
  }

  if (!rows.length) {
    fill(host, '<div class="empty">No hay reservas que coincidan.</div>');
    return;
  }

  fill(
    host,
    rows
      .map((r) => {
        const tags = [
          `<span class="tag">${esc(r.tableId)}</span>`,
          r.occasion !== 'ninguna' ? `<span class="tag tag-hot">${esc(r.occasionLabel)}</span>` : '',
          r.pago && r.pago.requerido && r.pago.estado !== 'pagado'
            ? '<span class="tag tag-due">sin pagar</span>'
            : r.pago && r.pago.estado === 'pagado'
              ? `<span class="tag tag-paid">${money(r.pago.monto)}</span>`
              : '',
          r.deposit ? '<span class="tag tag-hot">garantía</span>' : '',
          ...r.preferenceLabels.slice(0, 2).map((p) => `<span class="tag">${esc(p)}</span>`),
          r.experiences.length ? `<span class="tag tag-hot">${r.experiences.length} exp.</span>` : '',
          r.notes ? '<span class="tag">nota</span>' : ''
        ]
          .filter(Boolean)
          .join('');
        return `<button class="res" type="button" data-code="${esc(r.code)}">
          <span class="res-time">${r.time}</span>
          <span>
            <span class="res-name">${esc(r.name)}</span>
            <span class="res-meta">${plural(r.party, 'persona', 'personas')} · ${esc(r.zoneName)} · ${esc(
              r.phone
            )} · <span class="mono">${esc(r.code)}</span></span>
          </span>
          <span class="res-tags">${tags}</span>
          <span class="badge ${badgeClass(r.status)}">${esc(statusLabel(r.status))}</span>
        </button>`;
      })
      .join('')
  );

  host.onclick = (e) => {
    const btn = e.target.closest('[data-code]');
    if (btn) openDetail(btn.dataset.code);
  };
}

function badgeClass(status) {
  if (status === 'cancelada' || status === 'no-show') return 'badge-danger';
  if (status === 'pendiente' || status === 'pendiente-pago') return 'badge-warn';
  if (status === 'completada') return 'badge-info';
  return 'badge-ok';
}

function statusLabel(id) {
  const found = state.config.statuses.find((s) => s.id === id);
  return found ? found.label : id;
}

/* --------------------------------------------------------------- bloqueos */

async function createBlock(e) {
  e.preventDefault();
  const form = e.target;
  const body = Object.fromEntries(new FormData(form).entries());
  try {
    const res = await api('/api/admin/blocks', { method: 'POST', body: { ...body, date: state.date }, admin: true });
    toast(
      res.affected.length
        ? `Bloqueo creado. Ojo: ${res.affected.length} reservas caen dentro (${res.affected
            .map((a) => a.code)
            .join(', ')}).`
        : 'Bloqueo creado.',
      res.affected.length ? 'error' : 'ok',
      7000
    );
    form.reset();
    loadDay();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderBlocks() {
  const host = $('#blockList');
  const blocks = state.day.blocks;
  if (!blocks.length) {
    fill(host, '<li class="empty" style="padding:0.6rem">Sin bloqueos hoy.</li>');
    return;
  }
  fill(
    host,
    blocks
      .map(
        (b) => `<li>
          <span><b class="mono">${b.from}–${b.to}</b> · ${esc(scopeLabel(b.scope))}<br /><span class="muted">${esc(
            b.reason
          )}</span></span>
          <button class="icon-btn" type="button" data-block="${b.id}" aria-label="Quitar bloqueo">✕</button>
        </li>`
      )
      .join('')
  );
  host.onclick = async (e) => {
    const btn = e.target.closest('[data-block]');
    if (!btn) return;
    try {
      await api(`/api/admin/blocks/${btn.dataset.block}`, { method: 'DELETE', admin: true });
      toast('Bloqueo retirado.', 'ok');
      loadDay();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
}

function scopeLabel(scope) {
  if (scope === 'all') return 'todo el restaurante';
  const zone = state.config.zones.find((z) => z.id === scope);
  return zone ? zone.name : `mesa ${scope}`;
}

/* ------------------------------------------------------------------ notas */

function renderNotes() {
  const day = state.day;
  const notes = [];
  const celebra = day.reservations.filter((r) => r.occasion !== 'ninguna' && r.status !== 'cancelada');
  const grandes = day.reservations.filter((r) => r.party >= 8 && r.status !== 'cancelada');
  const accesibles = day.reservations.filter((r) => r.preferences.includes('accesible'));
  const bebes = day.reservations.filter((r) => r.preferences.includes('silla-bebe'));
  const exps = day.reservations.filter((r) => r.experiences.length);
  const pendientes = day.reservations.filter((r) => r.status === 'pendiente');

  if (celebra.length) {
    notes.push(
      `${plural(celebra.length, 'celebración', 'celebraciones')}: ${celebra
        .slice(0, 4)
        .map((r) => `${r.name.split(' ')[0]} (${r.occasionLabel.toLowerCase()}, ${r.time})`)
        .join('; ')}`
    );
  }
  if (pendientes.length) notes.push(`${pendientes.length} por confirmar garantía. Llamar antes del servicio.`);
  if (grandes.length) {
    notes.push(`Grupos grandes: ${grandes.map((r) => `${r.party}p a las ${r.time} en ${r.tableId}`).join('; ')}`);
  }
  if (accesibles.length) notes.push(`${accesibles.length} con acceso en silla de ruedas: dejar paso libre.`);
  if (bebes.length) notes.push(`Alistar ${plural(bebes.length, 'silla', 'sillas')} para bebé.`);
  if (exps.length) notes.push(`${exps.length} mesas con experiencia contratada (avisar a barra y cocina).`);
  const sinPagar = day.reservations.filter(
    (r) => r.pago && r.pago.requerido && r.pago.estado !== 'pagado' && !['cancelada', 'no-show'].includes(r.status)
  );
  if (sinPagar.length) {
    notes.push(
      `${sinPagar.length} sin pagar (${money(
        sinPagar.reduce((s, r) => s + r.pago.monto, 0)
      )}): cobrar al llegar. ${sinPagar.map((r) => `${r.time} ${r.tableId}`).join(', ')}`
    );
  }
  if (day.waitlist.length) notes.push(`${day.waitlist.length} en lista de espera para hoy.`);
  if (!notes.length) notes.push('Servicio tranquilo, sin pendientes especiales.');

  fill($('#serviceNotes'), notes.map((n) => `<li>${esc(n)}</li>`).join(''));
}

/* ---------------------------------------------------------------- detalle */

async function openDetail(code) {
  const r = state.day.reservations.find((x) => x.code === code);
  if (!r) return;

  $('#detailCode').textContent = `${r.code} · ${r.source === 'web' ? 'reserva web' : 'por teléfono'}`;
  $('#detailTitle').textContent = `${r.name} · ${plural(r.party, 'persona', 'personas')}`;

  fill(
    $('#detailBody'),
    `<div class="detail-grid">
      <div><strong>Hora</strong>${prettyTime(r.time)}</div>
      <div><strong>Mesa</strong>${esc(r.tableId)} · ${esc(r.zoneName)}</div>
      <div><strong>Turno</strong>${r.turnMinutes} min</div>
      <div><strong>Estado</strong>${esc(statusLabel(r.status))}</div>
      <div><strong>Teléfono</strong><a href="tel:${esc(r.phone)}">${esc(r.phone)}</a></div>
      <div><strong>Correo</strong>${esc(r.email)}</div>
      <div><strong>Ocasión</strong>${esc(r.occasionLabel)}</div>
      <div><strong>Extras</strong>${money(r.estimate.extras + r.estimate.surcharge)}</div>
      ${
        r.pago && r.pago.requerido
          ? `<div><strong>Cobro</strong>${money(r.pago.monto)} · ${esc(
              r.pago.estado
            )}${r.pago.referencia ? `<br /><span class="mono" style="font-size:0.68rem">${esc(r.pago.referencia)}</span>` : ''}</div>`
          : ''
      }
    </div>
    ${
      r.pago && r.pago.requerido && r.pago.estado !== 'pagado'
        ? `<div class="table-move" style="margin-top:0;border-top:0;padding-top:0">
            <button class="btn btn-sm btn-gold" type="button" data-cobrar="${esc(
              r.code
            )}">Marcar cobrado en el restaurante</button>
          </div>`
        : ''
    }
    ${r.preferenceLabels.length ? `<p class="detail-notes"><b>Preferencias:</b> ${esc(r.preferenceLabels.join(' · '))}</p>` : ''}
    ${
      r.experienceDetail.length
        ? `<p class="detail-notes"><b>Experiencias:</b> ${r.experienceDetail
            .map((x) => `${esc(x.name)} (${money(x.per === 'persona' ? x.price * r.party : x.price)})`)
            .join(' · ')}</p>`
        : ''
    }
    ${r.notes ? `<p class="detail-notes"><b>Nota del huésped:</b> ${esc(r.notes)}</p>` : ''}
    <div class="table-move">
      <label class="field"><span>Mover a mesa</span>
        <select class="select input-sm" id="moveTable">
          ${state.config.tables
            .map((t) => `<option value="${t.id}" ${t.id === r.tableId ? 'selected' : ''}>${t.id} · ${t.min}-${t.max} p.</option>`)
            .join('')}
        </select>
      </label>
      <button class="btn btn-sm" type="button" data-move="${esc(r.code)}">Mover</button>
    </div>
    <div class="history">
      ${r.history
        .slice(-6)
        .map((h) => `<span>${new Date(h.at).toLocaleString('es-CO')} · ${esc(h.action)} · ${esc(h.by)}</span>`)
        .join('')}
    </div>`
  );

  const actions = [
    ['confirmada', 'Confirmar', 'btn'],
    ['sentada', 'Sentar', 'btn btn-gold'],
    ['completada', 'Cerrar mesa', 'btn'],
    ['no-show', 'No llegó', 'btn btn-danger'],
    ['cancelada', 'Cancelar', 'btn btn-danger']
  ]
    .filter(([id]) => id !== r.status)
    .map(([id, label, cls]) => `<button class="${cls} btn-sm" type="button" data-status="${id}">${label}</button>`)
    .join('');

  fill($('#detailFoot'), actions);

  const dlg = $('#detailDialog');
  dlg.showModal();

  dlg.onclick = async (e) => {
    const st = e.target.closest('[data-status]');
    if (st) {
      await patchReservation(r.code, { status: st.dataset.status });
      dlg.close();
    }
    const cobrar = e.target.closest('[data-cobrar]');
    if (cobrar) {
      try {
        await api(`/api/admin/payments/${cobrar.dataset.cobrar}`, {
          method: 'PATCH',
          body: { estado: 'pagado', metodo: 'efectivo' },
          admin: true
        });
        toast('Cobro registrado.', 'ok');
        loadDay();
      } catch (err) {
        toast(err.message, 'error');
      }
      dlg.close();
    }

    const move = e.target.closest('[data-move]');
    if (move) {
      await patchReservation(r.code, { tableId: $('#moveTable').value });
      dlg.close();
    }
  };
}

async function patchReservation(code, body) {
  try {
    await api(`/api/admin/reservations/${code}`, { method: 'PATCH', body, admin: true });
    toast('Reserva actualizada.', 'ok');
    loadDay();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function createReservation(e) {
  e.preventDefault();
  const form = e.target;
  const body = Object.fromEntries(new FormData(form).entries());
  body.party = Number(body.party);
  if (!body.tableId) delete body.tableId;
  if (!body.zone) delete body.zone;
  try {
    const res = await api('/api/admin/reservations', { method: 'POST', body, admin: true });
    toast(`Reserva ${res.reservation.code} creada en la mesa ${res.reservation.tableId}.`, 'ok', 6000);
    $('#newDialog').close();
    form.reset();
    if (res.reservation.date === state.date) loadDay();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* -------------------------------------------------------------- analítica */

async function loadStats() {
  let data;
  try {
    data = await api('/api/admin/stats?days=14', { admin: true });
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  fill(
    $('#statTotals'),
    `<div class="kpi"><b>${data.totals.reservations}</b><span>reservas</span></div>
     <div class="kpi"><b>${data.totals.covers}</b><span>cubiertos</span></div>
     <div class="kpi ${data.totals.noShowRate > 8 ? 'is-bad' : ''}"><b>${data.totals.noShowRate}%</b><span>no-show</span></div>
     <div class="kpi ${data.totals.cancelRate > 12 ? 'is-warn' : ''}"><b>${data.totals.cancelRate}%</b><span>cancelación</span></div>
     <div class="kpi"><b>${money(data.totals.extras)}</b><span>en experiencias</span></div>`
  );

  $('#statRange').textContent = `${prettyDate(data.series[0].date, { short: true })} — ${prettyDate(
    data.series.at(-1).date,
    { short: true }
  )}`;

  const maxCovers = Math.max(...data.series.map((s) => s.covers), 1);
  fill(
    $('#statSeries'),
    data.series
      .map(
        (s) => `<div class="bar ${s.open ? '' : 'is-closed'}" title="${esc(
          `${prettyDate(s.date)} · ${s.covers} cubiertos · ${s.total} reservas`
        )}">
          <b>${s.covers || ''}</b>
          <i style="height:${s.open ? Math.max(2, (s.covers / maxCovers) * 100) : 3}%"></i>
          <span>${DIAS[new Date(`${s.date}T12:00`).getDay()].slice(0, 3)} ${s.date.slice(8)}</span>
        </div>`
      )
      .join('')
  );

  const maxZone = Math.max(...data.byZone.map((z) => z.count), 1);
  fill(
    $('#statZones'),
    data.byZone
      .map(
        (z) => `<div class="rank">
          <div class="rank-top"><span>${esc(z.name)}</span><b>${z.count}</b></div>
          <div class="rank-bar"><i style="width:${(z.count / maxZone) * 100}%"></i></div>
        </div>`
      )
      .join('')
  );

  const maxHour = Math.max(...data.byHour.map((h) => h.covers), 1);
  fill(
    $('#statHours'),
    data.byHour
      .map(
        (h) => `<div class="bar" title="${h.covers} cubiertos">
          <b>${h.covers}</b>
          <i style="height:${(h.covers / maxHour) * 100}%"></i>
          <span>${h.hour}h</span>
        </div>`
      )
      .join('')
  );

  const maxOcc = Math.max(...data.byOccasion.map((o) => o.count), 1);
  fill(
    $('#statOccasions'),
    data.byOccasion.length
      ? data.byOccasion
          .map(
            (o) => `<div class="rank">
              <div class="rank-top"><span>${esc(o.label)}</span><b>${o.count}</b></div>
              <div class="rank-bar"><i style="width:${(o.count / maxOcc) * 100}%"></i></div>
            </div>`
          )
          .join('')
      : '<div class="empty">Sin celebraciones registradas.</div>'
  );
}

/* ------------------------------------------------------------ lista espera */

/** HH:MM local de un instante ISO, para pasarlo por prettyTime. */
const horaDe = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

async function loadWaitlist() {
  let data;
  try {
    data = await api('/api/admin/waitlist', { admin: true });
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  const { resumen } = data;

  // Que se vea de una si el automático está prendido y cuánto tiempo le da
  // a la gente: es lo primero que pregunta quien abre esta pestaña.
  $('#esperaModo').innerHTML = resumen.activa
    ? `Cuando se suelta una mesa, el sistema le ofrece <b>a una sola persona</b> por correo:
       ${resumen.ventanaLargaMin} min si falta más de un día, ${resumen.ventanaCortaMin} min si es para ya.`
    : '<b style="color:var(--warn)">Ofertas automáticas apagadas.</b> Aquí solo se anota; hay que llamar a mano.';

  fill(
    $('#esperaCounts'),
    `<div class="kpi"><b>${resumen.esperando}</b><span>esperando</span></div>
     <div class="kpi"><b>${resumen.ofrecidas}</b><span>ofrecidas</span></div>
     <div class="kpi"><b>${resumen.aceptadas}</b><span>aceptaron</span></div>
     <div class="kpi"><b>${resumen.vencidas}</b><span>se vencieron</span></div>`
  );

  const host = $('#waitlist');
  if (!data.waitlist.length) {
    fill(host, '<div class="empty">Nadie en lista de espera.</div>');
    return;
  }

  const BADGE = {
    esperando: 'badge-warn',
    ofrecida: 'badge-info',
    aceptada: 'badge-ok',
    vencida: 'badge-danger',
    cerrado: ''
  };
  const ETIQUETA = Object.fromEntries((data.estados || []).map((e) => [e.id, e.label]));

  fill(
    host,
    data.waitlist
      .map((w) => {
        const o = w.offer;
        // Una oferta viva es lo único urgente de esta lista: se dice cuándo
        // se vence, no solo que existe.
        const detalleOferta =
          w.status === 'ofrecida' && o
            ? `<span class="res-meta">Se le ofreció ${prettyTime(o.time)} · mesa ${esc(o.tableId)} ·
                 vence ${prettyTime(horaDe(o.venceAt))}</span>`
            : w.status === 'aceptada' && o
              ? `<span class="res-meta">Aceptó · <span class="mono">${esc(o.reservationCode || '')}</span></span>`
              : '';

        const acciones =
          w.status === 'esperando'
            ? `<input class="input input-sm" type="time" step="1800" value="${esc(w.sugerida || '19:30')}"
                 data-hora="${esc(w.id)}" aria-label="Hora para ofrecer" style="width:7.2rem" />
               <button class="btn btn-sm" type="button" data-ofrecer="${esc(w.id)}">Ofrecer</button>
               <button class="btn btn-sm btn-ghost" type="button" data-wait="${esc(w.id)}" data-to="cerrado">Cerrar</button>`
            : w.status === 'ofrecida'
              ? '<span class="muted">Esperando respuesta…</span>'
              : w.status === 'aceptada'
                ? ''
                : `<button class="btn btn-sm btn-ghost" type="button" data-wait="${esc(w.id)}" data-to="esperando">Volver a la lista</button>`;

        return `<div class="res">
          <span class="res-time">${esc(w.date.slice(5))}</span>
          <span>
            <span class="res-name">${esc(w.name)}</span>
            <span class="res-meta">${plural(w.party, 'persona', 'personas')} · ${esc(w.window)}${
              w.zone ? ` · ${esc(w.zone)}` : ''
            } · ${esc(w.phone)} · ${esc(w.email)}${w.notes ? ` · ${esc(w.notes)}` : ''}</span>
            ${detalleOferta}
          </span>
          <span class="res-tags">${acciones}</span>
          <span class="badge ${BADGE[w.status] || ''}">${esc(ETIQUETA[w.status] || w.status)}</span>
        </div>`;
      })
      .join('')
  );

  host.onclick = async (e) => {
    const ofrecer = e.target.closest('[data-ofrecer]');
    if (ofrecer) {
      const id = ofrecer.dataset.ofrecer;
      const hora = $(`[data-hora="${id}"]`, host);
      try {
        const res = await api(`/api/admin/waitlist/${id}/ofrecer`, {
          method: 'POST',
          body: { time: (hora?.value || '').slice(0, 5) },
          admin: true
        });
        toast(res.message, 'ok');
        loadWaitlist();
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }

    const btn = e.target.closest('[data-wait]');
    if (!btn) return;
    try {
      await api(`/api/admin/waitlist/${btn.dataset.wait}`, {
        method: 'PATCH',
        body: { status: btn.dataset.to },
        admin: true
      });
      loadWaitlist();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
}

/* ═══════════════════════════════════════════════════════ cola de correos */

async function loadMail() {
  let data;
  try {
    data = await api('/api/admin/mail', { admin: true });
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  const { cola, transporte, bandeja } = data;

  // Que quede claro si la cola aguanta un reinicio o no: es la diferencia
  // entre tener Redis y no tenerlo.
  $('#mailModo').innerHTML = cola.persistente
    ? `BullMQ sobre Redis · los trabajos sobreviven un reinicio · envío por <b>${esc(transporte.modo)}</b>`
    : `<b style="color:var(--warn)">Cola en memoria</b>: sin REDIS_URL, lo pendiente se pierde al reiniciar · envío por <b>${esc(
        transporte.modo
      )}</b>`;

  fill(
    $('#mailCounts'),
    `<div class="kpi"><b>${cola.counts.completed || 0}</b><span>enviados</span></div>
     <div class="kpi"><b>${cola.counts.delayed || 0}</b><span>programados</span></div>
     <div class="kpi"><b>${cola.counts.waiting || 0}</b><span>en espera</span></div>
     <div class="kpi ${cola.counts.failed ? 'is-bad' : ''}"><b>${cola.counts.failed || 0}</b><span>fallidos</span></div>`
  );

  fill(
    $('#mailList'),
    bandeja.length
      ? bandeja
          .map(
            (m) => `<div class="res">
              <span class="res-time">${new Date(m.at).toLocaleTimeString('es-CO', {
                hour: '2-digit',
                minute: '2-digit'
              })}</span>
              <span>
                <span class="res-name">${esc(m.asunto)}</span>
                <span class="res-meta">${esc(m.para)} · ${esc(m.tipo)} · <span class="mono">${esc(
                  m.code || ''
                )}</span></span>
              </span>
              <span class="res-tags">
                <button class="btn btn-sm" type="button" data-ver-correo="${esc(m.id)}">Ver</button>
              </span>
              <span class="badge badge-ok">${esc(m.via)}</span>
            </div>`
          )
          .join('')
      : `<div class="empty">Sin correos todavía.${
          transporte.real ? '' : ' En modo bandeja se guardan aquí en vez de salir a internet.'
        }</div>`
  );

  $('#mailList').onclick = (e) => {
    const btn = e.target.closest('[data-ver-correo]');
    if (btn) window.open(`/api/admin/mail/${btn.dataset.verCorreo}?pin=${state.pin}`, '_blank', 'noopener');
  };

  fill(
    $('#mailFailed'),
    cola.fallidos.length
      ? cola.fallidos
          .map(
            (f) => `<div class="res">
              <span class="res-time">×${f.intentos}</span>
              <span>
                <span class="res-name">${esc(f.datos?.tipo || 'trabajo')}</span>
                <span class="res-meta">${esc(f.datos?.code || '')} · ${esc(String(f.error || '').slice(0, 80))}</span>
              </span>
              <span class="res-tags">
                <button class="btn btn-sm" type="button" data-reintentar="${esc(f.id)}">Reintentar</button>
              </span>
            </div>`
          )
          .join('')
      : '<div class="empty">Ninguno. Todo salió.</div>'
  );

  $('#mailFailed').onclick = async (e) => {
    const btn = e.target.closest('[data-reintentar]');
    if (!btn) return;
    try {
      await api(`/api/admin/mail/${btn.dataset.reintentar}/retry`, { method: 'POST', admin: true });
      toast('Reencolado.', 'ok');
      loadMail();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
}
