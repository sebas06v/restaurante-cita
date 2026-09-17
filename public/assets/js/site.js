/* ==========================================================================
   El Guayacán · sitio público. Flujo de reserva en cuatro pasos,
   consulta de reservas, carta y estado de la sala en vivo.
   ========================================================================== */

import {
  $, $$, esc, fill, node, api, toast, money, plural, download, copy,
  prettyDate, prettyTime, relativeDay, toISO, addDays, diffDays, weekday,
  DIAS, MESES, debounce
} from './lib.js';

/* Escalas del plano: mundo 100x100 dibujado en una caja 16:9 sin deformar. */
const PLAN_W = 0.84375;
const PLAN_H = 1.5;

/** "1 h 30 min", "2 h" */
const turnText = (minutes) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h} h${m ? ` ${m} min` : ''}`;
};

const state = {
  config: null,
  step: 1,
  party: 2,
  date: null,
  time: null,
  zone: null,
  tableId: null,
  occasion: 'ninguna',
  preferences: [],
  experiences: [],
  availability: null,
  floor: null,
  calendar: [],
  stripFrom: null,
  reservation: null,
  busy: false
};

/* ══════════════════════════════════════════════════════════════════ arranque */

init();

async function init() {
  petals();
  stickyHeader();
  mobileNav();
  wireDialogs();
  wireSteps();

  try {
    state.config = await api('/api/config');
  } catch {
    toast('No pudimos conectar con el servidor de reservas.', 'error', 9000);
    return;
  }

  state.date = state.config.today;
  state.stripFrom = state.config.today;

  renderStaticBits();
  renderPartyChips();
  renderOccasions();
  renderPreferences();
  renderExperiences();
  renderSalones();
  renderMenu();
  renderHours();
  renderRail();
  wireQuickbar();
  wireGuestForm();

  await loadCalendar();
  const firstOpen = state.calendar.find((d) => d.open && d.slots > 0);
  if (firstOpen) {
    state.date = firstOpen.date;
    $('#datePicker').value = state.date;
    $('#qDate').value = state.date;
  }
  renderStrip();
  await loadAvailability();
  loadTonight();
  spyNav();
}

/* ════════════════════════════════════════════════════════════════ decoración */

function petals() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const host = $('#petals');
  if (!host) return;
  for (let i = 0; i < 16; i += 1) {
    const p = document.createElement('i');
    p.className = 'petal';
    const size = 6 + Math.random() * 9;
    p.style.cssText = `left:${Math.random() * 100}%;width:${size}px;height:${size * 0.8}px;
      animation-duration:${11 + Math.random() * 13}s;animation-delay:${-Math.random() * 20}s;
      --drift:${(Math.random() - 0.5) * 220}px;opacity:0`;
    host.append(p);
  }
}

function stickyHeader() {
  const bar = $('#topbar');
  const onScroll = () => bar.classList.toggle('is-stuck', window.scrollY > 24);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
}

function mobileNav() {
  const burger = $('.burger');
  const nav = $('#topnav');
  burger.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    burger.setAttribute('aria-expanded', String(open));
  });
  nav.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') {
      nav.classList.remove('is-open');
      burger.setAttribute('aria-expanded', 'false');
    }
  });
}

function spyNav() {
  const links = $$('.topnav a');
  const sections = links.map((a) => $(a.getAttribute('href')));
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const index = sections.indexOf(entry.target);
        links.forEach((a, i) => a.classList.toggle('is-current', i === index));
      }
    },
    { rootMargin: '-45% 0px -50% 0px' }
  );
  sections.forEach((s) => s && io.observe(s));
}

/* ════════════════════════════════════════════════════════════ piezas fijas */

function renderStaticBits() {
  const { tables, restaurant } = state.config;
  $('#factTables').textContent = tables.length;
  $('#turnNote').textContent = '';

  const dp = $('#datePicker');
  dp.min = state.config.today;
  dp.max = addDays(state.config.today, restaurant.bookingWindowDays);
  dp.value = state.date || state.config.today;
  dp.addEventListener('change', () => {
    if (!dp.value) return;
    if (diffDays(state.config.today, dp.value) < 0) return;
    state.stripFrom = dp.value;
    pickDate(dp.value, { rebuildStrip: true });
  });

  const qd = $('#qDate');
  qd.min = state.config.today;
  qd.max = dp.max;
  qd.value = state.config.today;

  const qp = $('#qPeople');
  qp.innerHTML = Array.from({ length: restaurant.maxPartyOnline }, (_, i) => i + 1)
    .map((n) => `<option value="${n}" ${n === 2 ? 'selected' : ''}>${plural(n, 'persona', 'personas')}</option>`)
    .join('');

  $$('[data-scroll]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.stripFrom = addDays(state.stripFrom, Number(btn.dataset.scroll) * 7);
      if (diffDays(state.config.today, state.stripFrom) < 0) state.stripFrom = state.config.today;
      loadCalendar().then(renderStrip);
    })
  );
}

function renderPartyChips() {
  const max = state.config.restaurant.maxPartyOnline;
  const host = $('#partyChips');
  host.innerHTML = Array.from({ length: max }, (_, i) => i + 1)
    .map(
      (n) => `<button class="chip" type="button" role="button" aria-pressed="${n === state.party}"
        data-party="${n}">${n}${n === max ? '+' : ''}</button>`
    )
    .join('');
  host.onclick = (e) => {
    const btn = e.target.closest('[data-party]');
    if (!btn) return;
    state.party = Number(btn.dataset.party);
    state.time = null;
    state.tableId = null;
    $$('[data-party]', host).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    $('#qPeople').value = state.party;
    renderRail();
    loadCalendar().then(renderStrip);
    loadAvailability();
  };
}

function renderOccasions() {
  const host = $('#occasionChips');
  host.innerHTML = state.config.occasions
    .map(
      (o) => `<button class="chip" type="button" aria-pressed="${o.id === state.occasion}" data-occasion="${o.id}">
        <span aria-hidden="true">${o.icon}</span>${esc(o.label)}</button>`
    )
    .join('');
  host.onclick = (e) => {
    const btn = e.target.closest('[data-occasion]');
    if (!btn) return;
    state.occasion = btn.dataset.occasion;
    $$('[data-occasion]', host).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    renderRail();
  };
}

function renderPreferences() {
  const host = $('#prefChips');
  host.innerHTML = state.config.preferences
    .map((p) => `<button class="chip" type="button" aria-pressed="false" data-pref="${p.id}">${esc(p.label)}</button>`)
    .join('');
  host.onclick = (e) => {
    const btn = e.target.closest('[data-pref]');
    if (!btn) return;
    const on = btn.getAttribute('aria-pressed') === 'true';
    btn.setAttribute('aria-pressed', String(!on));
    state.preferences = $$('[data-pref]', host)
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.dataset.pref);
    renderRail();
  };
}

function renderExperiences() {
  const host = $('#expList');
  host.innerHTML = state.config.experiences
    .map(
      (x) => `<button class="exp" type="button" aria-pressed="false" data-exp="${x.id}">
        <span class="exp-check" aria-hidden="true">✓</span>
        <span class="exp-body">
          <span class="exp-name">${esc(x.name)}
            <span class="exp-price">${money(x.price)} / ${x.per}</span>
          </span>
          <span class="exp-detail">${esc(x.detail)}</span>
        </span>
      </button>`
    )
    .join('');
  host.onclick = (e) => {
    const btn = e.target.closest('[data-exp]');
    if (!btn) return;
    const on = btn.getAttribute('aria-pressed') === 'true';
    btn.setAttribute('aria-pressed', String(!on));
    state.experiences = $$('[data-exp]', host)
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.dataset.exp);
    renderRail();
  };
}

/* ══════════════════════════════════════════════════════════ paso 1: cuándo */

async function loadCalendar() {
  try {
    const data = await api(`/api/calendar?from=${state.stripFrom}&days=21&party=${state.party}`);
    state.calendar = data.calendar;
  } catch {
    state.calendar = [];
  }
}

function renderStrip() {
  const host = $('#dayStrip');
  if (!state.calendar.length) {
    fill(host, '<p class="muted">No pudimos cargar el calendario.</p>');
    return;
  }
  host.innerHTML = state.calendar
    .map((day) => {
      const d = new Date(`${day.date}T12:00:00`);
      const tight = day.open && day.load >= 65;
      const label = relativeDay(day.date, state.config.today);
      const dow = ['hoy', 'mañana'].includes(label) ? label : DIAS[weekday(day.date)].slice(0, 3);
      return `<button class="day ${tight ? 'is-tight' : ''}" type="button"
        aria-pressed="${day.date === state.date}" data-date="${day.date}"
        ${day.open && day.slots ? '' : 'disabled'}
        title="${esc(day.open ? `${day.slots} horarios libres` : day.reason)}">
        <span class="day-dow">${esc(dow)}</span>
        <span class="day-num">${d.getDate()}</span>
        <span class="day-mon">${MESES[d.getMonth()].slice(0, 3)}</span>
        <span class="day-load"><i style="width:${day.open ? Math.max(6, 100 - day.load) : 0}%"></i></span>
      </button>`;
    })
    .join('');

  host.onclick = (e) => {
    const btn = e.target.closest('[data-date]');
    if (!btn || btn.disabled) return;
    pickDate(btn.dataset.date);
  };

  const active = $('[aria-pressed="true"]', host);
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function pickDate(date, { rebuildStrip = false } = {}) {
  state.date = date;
  state.time = null;
  state.tableId = null;
  $('#datePicker').value = date;
  $('#qDate').value = date;
  if (rebuildStrip) loadCalendar().then(renderStrip);
  else $$('#dayStrip [data-date]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.date === date)));
  renderRail();
  loadAvailability();
}

async function loadAvailability() {
  const host = $('#slotsHost');
  fill(
    host,
    `<div class="service-group">
      <div class="skeleton" style="height:1.4rem;width:9rem"></div>
      <div class="skeleton" style="height:5.5rem"></div>
    </div>`
  );
  try {
    state.availability = await api(`/api/availability?date=${state.date}&party=${state.party}`);
  } catch (err) {
    fill(host, `<div class="notice">${esc(err.message)}</div>`);
    return;
  }
  renderSlots();
  gateStep1();
}

function renderSlots() {
  const host = $('#slotsHost');
  const data = state.availability;
  const turn = data.turnMinutes;
  $('#turnNote').textContent = `Su mesa queda reservada ${Math.floor(turn / 60)} h ${turn % 60 ? `${turn % 60} min` : ''}`.trim();

  if (data.problem) {
    fill(
      host,
      `<div class="notice">
        <strong>${esc(data.problem)}</strong>
        ${suggestionsMarkup(data.suggestions)}
      </div>`
    );
    return;
  }

  const anyOpen = data.services.some((s) => s.openCount > 0);
  const groups = data.services
    .map((service) => {
      const slots = service.slots
        .map((slot) => {
          const usable = slot.status === 'free' || slot.status === 'ultimas';
          const title =
            slot.status === 'lleno'
              ? 'Sin mesas para su grupo'
              : slot.status === 'cocina'
                ? 'La cocina está copada a esa hora'
                : slot.status === 'pasado'
                  ? 'Ya no alcanzamos a prepararla'
                  : `${plural(slot.tables, 'mesa libre', 'mesas libres')}`;
          return `<button class="slot ${slot.status === 'ultimas' ? 'is-tight' : ''}" type="button"
            data-time="${slot.time}" aria-pressed="${state.time === slot.time}"
            ${usable ? '' : 'disabled'} title="${esc(title)}">${prettyTime(slot.time).replace(' ', ' ')}</button>`;
        })
        .join('');
      return `<div class="service-group">
        <div class="service-head">
          <h5>${esc(service.label)}</h5>
          <span>${service.open} a ${service.close} · última entrada ${prettyTime(service.lastSeating)}</span>
        </div>
        <div class="slot-grid">${slots}</div>
      </div>`;
    })
    .join('');

  fill(
    host,
    anyOpen
      ? groups
      : `<div class="notice">
          <strong>El ${prettyDate(state.date)} ya está completo para ${plural(state.party, 'persona', 'personas')}.</strong>
          ${suggestionsMarkup(data.suggestions)}
          <div class="notice-actions">
            <button class="btn btn-sm" type="button" data-action="waitlist">Avísenme si se libera</button>
          </div>
        </div>${groups}`
  );

  host.onclick = (e) => {
    const slot = e.target.closest('[data-time]');
    if (slot && !slot.disabled) {
      state.time = slot.dataset.time;
      state.tableId = null;
      $$('[data-time]', host).forEach((b) => b.setAttribute('aria-pressed', String(b === slot)));
      renderRail();
      gateStep1();
      return;
    }
    const sug = e.target.closest('[data-suggest-date]');
    if (sug) {
      state.stripFrom = sug.dataset.suggestDate;
      pickDate(sug.dataset.suggestDate, { rebuildStrip: true });
      return;
    }
    if (e.target.closest('[data-action="waitlist"]')) openWaitlist();
  };
}

function suggestionsMarkup(list) {
  if (!list || !list.length) return '';
  return `<div class="notice-actions">${list
    .map(
      (s) => `<button class="chip" type="button" data-suggest-date="${s.date}">
        ${esc(s.label)} · ${prettyTime(s.time)}</button>`
    )
    .join('')}</div>`;
}

function gateStep1() {
  const ready = Boolean(state.date && state.time && state.party);
  const btn = $('[data-next="2"]');
  btn.disabled = !ready;
  $('#p1hint').textContent = ready
    ? `${plural(state.party, 'persona', 'personas')} · ${prettyDate(state.date)} · ${prettyTime(state.time)}`
    : 'Elija personas, día y hora para continuar.';
}

/* ═══════════════════════════════════════════════════════════ paso 2: dónde */

async function loadFloor() {
  const host = $('#zoneCards');
  fill(host, '<div class="skeleton" style="height:9rem"></div>'.repeat(3));
  try {
    state.floor = await api(`/api/floor?date=${state.date}&time=${state.time}&party=${state.party}`);
  } catch (err) {
    fill(host, `<div class="notice">${esc(err.message)}</div>`);
    return;
  }
  renderZones();
}

function renderZones() {
  const host = $('#zoneCards');
  const zones = state.floor.zones;

  host.innerHTML = zones
    .map((zone) => {
      const usable = zone.available;
      return `<button class="zone" type="button" data-zone="${zone.id}"
        aria-pressed="${state.zone === zone.id}" ${usable ? '' : 'disabled'}>
        <span class="zone-top">
          <span class="zone-name">${esc(zone.name)}</span>
          ${
            usable
              ? `<span class="badge badge-ok">${plural(zone.free, 'mesa', 'mesas')}</span>`
              : '<span class="badge badge-danger">Sin mesa</span>'
          }
        </span>
        <span class="zone-sub">${esc(zone.subtitle)}</span>
        <span class="zone-desc">${esc(zone.description)}</span>
        <ul class="zone-vibe">${zone.vibe.map((v) => `<li>${esc(v)}</li>`).join('')}</ul>
        ${zone.surcharge ? `<span class="zone-sub">+ ${money(zone.surcharge)} por el salón</span>` : ''}
      </button>`;
    })
    .join('');

  host.onclick = (e) => {
    const btn = e.target.closest('[data-zone]');
    if (!btn || btn.disabled) return;
    state.zone = btn.dataset.zone;
    state.tableId = null;
    $$('[data-zone]', host).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    renderFloorPlan();
    renderRail();
    $('[data-next="3"]').disabled = false;
  };

  if (state.zone && !zones.find((z) => z.id === state.zone && z.available)) state.zone = null;
  $('[data-next="3"]').disabled = !state.zone;
  if (state.zone) renderFloorPlan();
  else $('#floorBlock').hidden = true;
}

function renderFloorPlan() {
  const block = $('#floorBlock');
  const zone = state.floor.zones.find((z) => z.id === state.zone);
  if (!zone) {
    block.hidden = true;
    return;
  }
  block.hidden = false;

  const tables = zone.tables
    .map((t) => {
      const cls =
        t.status === 'libre' ? 'is-free' : t.status === 'ocupada' ? 'is-busy' : 'is-off';
      const picked = state.tableId === t.id ? 'is-picked' : '';
      const title =
        t.status === 'libre'
          ? `Mesa ${t.id} · ${t.min}-${t.max} personas`
          : t.status === 'ocupada'
            ? `Mesa ${t.id} · reservada a las ${prettyTime(t.reservation.time)}`
            : t.status === 'bloqueada'
              ? `Mesa ${t.id} · bloqueada`
              : `Mesa ${t.id} · para ${t.min}-${t.max} personas`;
      return `<button class="plan-table shape-${t.shape} ${cls} ${picked}" type="button"
        data-table="${t.id}" ${t.status === 'libre' ? '' : 'disabled'}
        title="${esc(title)}"
        style="left:${t.x}%;top:${t.y}%;width:${(t.w * PLAN_W).toFixed(2)}%;height:${(t.h * PLAN_H).toFixed(2)}%"
        >${t.id}</button>`;
    })
    .join('');

  fill(
    $('#floorPlan'),
    `<span class="plan-label">${esc(zone.name)}</span>
     <span class="plan-note">${prettyTime(state.time)} · ${plural(state.party, 'persona', 'personas')}</span>
     ${tables}`
  );

  $('#floorPlan').onclick = (e) => {
    const btn = e.target.closest('[data-table]');
    if (!btn || btn.disabled) return;
    state.tableId = state.tableId === btn.dataset.table ? null : btn.dataset.table;
    renderFloorPlan();
    renderRail();
  };
}

/* ═══════════════════════════════════════════════════════ paso 3: los datos */

function wireGuestForm() {
  const form = $('#guestForm');
  form.addEventListener('input', debounce(renderRail, 400));
  form.addEventListener('submit', (e) => e.preventDefault());
}

function guestData() {
  const form = $('#guestForm');
  const data = Object.fromEntries(new FormData(form).entries());
  return {
    name: (data.name || '').trim(),
    phone: (data.phone || '').trim(),
    email: (data.email || '').trim(),
    notes: (data.notes || '').trim()
  };
}

function validateGuest() {
  const g = guestData();
  const problems = {};
  if (g.name.length < 3 || !g.name.includes(' ')) problems.name = 'Escriba nombre y apellido.';
  if (g.phone.replace(/\D/g, '').length < 7) problems.phone = 'Falta el número completo.';
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(g.email)) problems.email = 'Revise el correo.';

  $$('[data-error-for]').forEach((el) => {
    const key = el.dataset.errorFor;
    el.hidden = !problems[key];
    el.textContent = problems[key] || '';
    const input = $(`[name="${key}"]`, $('#guestForm'));
    if (input) input.setAttribute('aria-invalid', String(Boolean(problems[key])));
  });

  return { ok: Object.keys(problems).length === 0, guest: g, problems };
}

/* ═════════════════════════════════════════════════════════ paso 4: repaso */

function estimate() {
  const zone = state.config.zones.find((z) => z.id === state.zone);
  const extras = state.config.experiences
    .filter((x) => state.experiences.includes(x.id))
    .reduce((sum, x) => sum + (x.per === 'persona' ? x.price * state.party : x.price), 0);
  const surcharge = zone ? zone.surcharge : 0;
  const deposit = state.party >= state.config.restaurant.depositFrom ? 50000 * state.party : 0;
  return { extras, surcharge, deposit, total: extras + surcharge + deposit };
}

function renderReview() {
  const g = guestData();
  const zone = state.config.zones.find((z) => z.id === state.zone);
  const est = estimate();
  const prefs = state.config.preferences.filter((p) => state.preferences.includes(p.id)).map((p) => p.label);
  const exps = state.config.experiences.filter((x) => state.experiences.includes(x.id));
  const occasion = state.config.occasions.find((o) => o.id === state.occasion);

  fill(
    $('#reviewHost'),
    `<div class="review">
      <div class="review-card">
        <p class="review-sub">${esc(zone ? zone.name : 'Salón por asignar')}${
          state.tableId ? ` · mesa ${esc(state.tableId)}` : ''
        }</p>
        <h4 class="review-title">${esc(prettyDate(state.date, { withYear: false }))}, ${prettyTime(state.time)}</h4>
        <div class="review-list">
          <div><span>Personas</span><span>${plural(state.party, 'persona', 'personas')}</span></div>
          <div><span>A nombre de</span><span>${esc(g.name || '—')}</span></div>
          <div><span>Contacto</span><span>${esc(g.phone || '—')}<br />${esc(g.email || '—')}</span></div>
          <div><span>Ocasión</span><span>${esc(occasion ? occasion.label : '—')}</span></div>
          ${prefs.length ? `<div><span>Preferencias</span><span>${esc(prefs.join(', '))}</span></div>` : ''}
          ${
            exps.length
              ? `<div><span>Experiencias</span><span>${exps
                  .map((x) => `${esc(x.name)} · ${money(x.per === 'persona' ? x.price * state.party : x.price)}`)
                  .join('<br />')}</span></div>`
              : ''
          }
          ${g.notes ? `<div><span>Notas</span><span>${esc(g.notes)}</span></div>` : ''}
        </div>
        ${
          est.total
            ? `<div class="review-total"><span>Estimado a pagar en el sitio</span><span>${money(
                est.extras + est.surcharge
              )}</span></div>
              ${
                est.deposit
                  ? `<p class="block-note">Grupo de ${state.party}: coordinamos por teléfono una garantía de ${money(
                      est.deposit
                    )}, abonable al consumo.</p>`
                  : ''
              }`
            : '<p class="block-note">Sin cargos por reservar. Solo paga lo que consuma.</p>'
        }
      </div>
    </div>`
  );
}

/* ══════════════════════════════════════════════════════════════════ resumen */

function renderRail() {
  const host = $('#railBody');
  if (!state.date) {
    fill(host, '<p class="rail-empty">Escoja fecha y hora y aquí va apareciendo su reserva.</p>');
    return;
  }
  const zone = state.config.zones.find((z) => z.id === state.zone);
  const est = estimate();
  const g = guestData();

  fill(
    host,
    `<p class="rail-when">${esc(prettyDate(state.date))}${state.time ? `<br />${prettyTime(state.time)}` : ''}</p>
     <div class="rail-line"><span>Personas</span><span>${state.party}</span></div>
     ${zone ? `<div class="rail-line"><span>Salón</span><span>${esc(zone.name)}</span></div>` : ''}
     ${state.tableId ? `<div class="rail-line"><span>Mesa</span><span class="mono">${esc(state.tableId)}</span></div>` : ''}
     ${g.name ? `<div class="rail-line"><span>Nombre</span><span>${esc(g.name)}</span></div>` : ''}
     ${
       state.experiences.length
         ? `<div class="rail-line"><span>Experiencias</span><span>${state.experiences.length}</span></div>`
         : ''
     }
     ${
       est.extras + est.surcharge
         ? `<div class="rail-line"><span>Extras</span><span>${money(est.extras + est.surcharge)}</span></div>`
         : ''
     }`
  );
}

/* ═══════════════════════════════════════════════════════════ navegación pasos */

function wireSteps() {
  document.addEventListener('click', async (e) => {
    const next = e.target.closest('[data-next]');
    if (next) {
      const target = next.dataset.next;
      if (target === '3' && !state.zone) return;
      if (target === '4') {
        const check = validateGuest();
        if (!check.ok) {
          toast('Faltan datos de contacto.', 'error');
          const firstBad = $('[aria-invalid="true"]');
          if (firstBad) firstBad.focus();
          return;
        }
      }
      await goStep(Number(target));
      return;
    }
    const prev = e.target.closest('[data-prev]');
    if (prev) goStep(Number(prev.dataset.prev));

    if (e.target.closest('[data-action="clear-table"]')) {
      state.tableId = null;
      renderFloorPlan();
      renderRail();
    }
  });

  $('#submitBooking').addEventListener('click', submitBooking);
}

async function goStep(step) {
  state.step = step;
  $$('.panel').forEach((p) => {
    p.hidden = p.dataset.panel !== String(step);
  });
  $$('#steps li').forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle('is-active', n === step);
    li.classList.toggle('is-done', n < step);
  });

  if (step === 2) await loadFloor();
  if (step === 4) renderReview();

  const anchor = $('#reservar');
  const top = anchor.getBoundingClientRect().top + window.scrollY - 90;
  window.scrollTo({ top, behavior: 'smooth' });
}

/* ═════════════════════════════════════════════════════════════════ confirmar */

async function submitBooking() {
  if (state.busy) return;
  const check = validateGuest();
  if (!check.ok) {
    await goStep(3);
    return;
  }

  const btn = $('#submitBooking');
  state.busy = true;
  btn.disabled = true;
  btn.textContent = 'Guardando…';

  try {
    const payload = {
      date: state.date,
      time: state.time,
      party: state.party,
      zone: state.zone,
      occasion: state.occasion,
      preferences: state.preferences,
      experiences: state.experiences,
      ...check.guest
    };
    const { reservation } = await api('/api/reservations', { method: 'POST', body: payload });
    state.reservation = reservation;

    // Con cobro, la mesa queda apartada pero no en firme: primero el pago y
    // solo despues la pantalla de confirmacion.
    const pendiente = reservation.pago && reservation.pago.requerido && reservation.pago.estado !== 'pagado';
    if (pendiente) {
      await renderPayment(reservation.code);
      showPanel('pago');
      toast('Mesa apartada. Complete el pago para dejarla en firme.', 'ok', 7000);
    } else {
      renderSuccess(reservation);
      showPanel('ok');
      toast('Reserva confirmada. Le enviamos el detalle al correo.', 'ok', 7000);
    }
  } catch (err) {
    // Un fallo de la API trae `data` con alternativas; un fallo de código no
    // trae nada. Antes se asumía lo primero y el propio catch reventaba,
    // escondiendo el error de verdad.
    console.error('[reserva]', err);
    const alts = err.data?.alternatives || [];
    if (alts.length) {
      toast(err.message, 'error', 8000);
      state.availability = null;
      await goStep(1);
      await loadAvailability();
      const host = $('#slotsHost');
      host.prepend(
        node(`<div class="notice">
          <strong>${esc(err.message)}</strong>
          <span>Estas horas sí tienen mesa para ${plural(state.party, 'persona', 'personas')}:</span>
          <div class="notice-actions">${alts
            .map((a) => `<button class="chip" type="button" data-time="${a.time}">${esc(a.label)}</button>`)
            .join('')}</div>
        </div>`)
      );
    } else {
      toast(err.message, 'error', 7000);
    }
  } finally {
    state.busy = false;
    btn.disabled = false;
    btn.textContent = 'Confirmar reserva';
  }
}

/** Salta a un panel, cierra el resto y marca los pasos como hechos. */
function showPanel(name) {
  $$('.panel').forEach((p) => {
    p.hidden = p.dataset.panel !== name;
  });
  $$('#steps li').forEach((li) => {
    li.classList.remove('is-active');
    li.classList.add('is-done');
  });
  window.scrollTo({ top: $('#reservar').offsetTop - 80, behavior: 'smooth' });
}

/* ============================================================== pago == */

/**
 * Pantalla de pago. Es una simulacion y lo dice de frente: no se cobra nada
 * y no se pide ningun dato de tarjeta. Solo el metodo y, para poder probar
 * los dos caminos, el desenlace, igual que el sandbox de una pasarela.
 */
async function renderPayment(code) {
  const host = $('#payHost');
  fill(host, '<div class="skeleton" style="height:14rem"></div>');

  let data;
  try {
    data = await api(`/api/payments/${code}`);
  } catch (err) {
    fill(host, `<div class="notice"><strong>${esc(err.message)}</strong></div>`);
    return;
  }

  state.pay = { code, metodo: data.metodos[0].id, resultado: 'aprobado' };

  fill(
    host,
    `<div class="pay">
      <p class="eyebrow">Paso final</p>
      <h3 class="panel-title">Confirme su mesa con ${money(data.pago.monto)}</h3>

      <div class="pay-sim">
        <strong>Pago de demostración</strong>
        No se cobra dinero real y no le pedimos datos de tarjeta. Escoja el método y el
        desenlace que quiera probar.
      </div>

      <div class="pay-grid">
        <div class="pay-resumen">
          <div class="rail-line"><span>Reserva</span><span class="mono">${esc(data.code)}</span></div>
          <div class="rail-line"><span>A nombre de</span><span>${esc(data.nombre)}</span></div>
          <div class="rail-line"><span>Cuándo</span><span>${esc(data.cuando)}</span></div>
          <div class="rail-line"><span>Personas</span><span>${data.personas}</span></div>
          <div class="review-total"><span>A pagar ahora</span><span>${money(data.pago.monto)}</span></div>
          ${data.abonable ? '<p class="block-note">Se abona a su consumo esa noche.</p>' : ''}
        </div>

        <div class="pay-form">
          <div class="block">
            <div class="block-head"><h4>Método de pago</h4></div>
            <div class="chips" id="payMetodos" role="group" aria-label="Método de pago">
              ${data.metodos
                .map(
                  (m, i) => `<button class="chip" type="button" data-metodo="${m.id}"
                    aria-pressed="${i === 0}">${esc(m.label)}</button>`
                )
                .join('')}
            </div>
            <p class="block-note" id="payMetodoNota">${esc(data.metodos[0].detalle)}</p>
          </div>

          <div class="block">
            <div class="block-head"><h4>Desenlace a simular</h4></div>
            <div class="chips" id="payResultado" role="group" aria-label="Resultado del pago">
              <button class="chip" type="button" data-resultado="aprobado" aria-pressed="true">Aprobado</button>
              <button class="chip" type="button" data-resultado="rechazado" aria-pressed="false">Rechazado</button>
            </div>
          </div>

          <div id="payError"></div>

          <footer class="panel-foot">
            <span class="panel-hint">La mesa está apartada mientras paga.</span>
            <button class="btn btn-ghost" type="button" data-action="pay-later">Pagar después</button>
            <button class="btn btn-gold btn-lg" type="button" id="payNow">Pagar ${money(data.pago.monto)}</button>
          </footer>
        </div>
      </div>
    </div>`
  );

  $('#payMetodos').onclick = (e) => {
    const btn = e.target.closest('[data-metodo]');
    if (!btn) return;
    state.pay.metodo = btn.dataset.metodo;
    $$('#payMetodos [data-metodo]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    const m = data.metodos.find((x) => x.id === btn.dataset.metodo);
    $('#payMetodoNota').textContent = m ? m.detalle : '';
  };

  $('#payResultado').onclick = (e) => {
    const btn = e.target.closest('[data-resultado]');
    if (!btn) return;
    state.pay.resultado = btn.dataset.resultado;
    $$('#payResultado [data-resultado]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  };

  $('#payNow').onclick = payNow;
  $('[data-action="pay-later"]', host).onclick = () => {
    renderSuccess({ ...state.reservation, pago: data.pago });
    showPanel('ok');
    toast('Le guardamos la mesa. Puede pagar desde «Mi reserva».', 'ok', 7000);
  };
}

async function payNow() {
  const btn = $('#payNow');
  btn.disabled = true;
  btn.textContent = 'Procesando…';
  fill($('#payError'), '');

  try {
    const res = await api(`/api/payments/${state.pay.code}`, {
      method: 'POST',
      body: { metodo: state.pay.metodo, resultado: state.pay.resultado }
    });
    state.reservation = res.reservation;
    renderSuccess(res.reservation, res.recibo);
    showPanel('ok');
    toast(res.message, 'ok', 7000);
  } catch (err) {
    fill(
      $('#payError'),
      `<div class="notice">
        <strong>${esc(err.message)}</strong>
        <span>La mesa sigue apartada. Pruebe con otro método, o cambie el desenlace a «Aprobado».</span>
      </div>`
    );
    btn.disabled = false;
    btn.textContent = 'Reintentar el pago';
  }
}

/** El estado de la reserva en palabras del huésped. */
function estadoBonito(r) {
  if (r.status === 'pendiente-pago') return 'Por pagar';
  if (r.status === 'pendiente') return 'Por confirmar garantía';
  return 'Confirmada';
}

function renderSuccess(r, recibo = null) {
  fill(
    $('#successHost'),
    `<div class="success">
      <div class="success-mark" aria-hidden="true">✓</div>
      <p class="eyebrow">Reserva confirmada</p>
      <h3>Nos vemos el ${esc(prettyDate(r.date))}</h3>
      <p class="lede" style="max-width:44ch;margin:0.8rem auto 0">
        ${esc(r.name.split(' ')[0])}, guardamos su mesa para ${plural(r.party, 'persona', 'personas')}
        a las ${prettyTime(r.time)} en ${esc(r.zoneName)}.
      </p>
      <div class="success-code">
        <span>${esc(r.code)}</span>
        <button class="icon-btn" type="button" data-copy="${esc(r.code)}" title="Copiar código">⧉</button>
      </div>
      <div class="success-grid">
        <div><strong>Cuándo</strong>${esc(prettyDate(r.date))}, ${prettyTime(r.time)}</div>
        <div><strong>Dónde</strong>${esc(r.zoneName)} · mesa ${esc(r.tableId)}</div>
        <div><strong>Mesa reservada</strong>${turnText(r.turnMinutes)}</div>
        <div><strong>Estado</strong>${estadoBonito(r)}</div>
        ${
          recibo
            ? `<div><strong>Pago</strong>${money(recibo.monto)} · ${esc(recibo.metodo)}<br />
                <span class="mono" style="font-size:0.72rem">${esc(recibo.referencia)}</span></div>`
            : r.pago && r.pago.requerido && r.pago.estado !== 'pagado'
              ? '<div><strong>Pago</strong>Pendiente</div>'
              : ''
        }
      </div>
      ${
        r.pago && r.pago.requerido && r.pago.estado !== 'pagado'
          ? `<div class="notice" style="text-align:left;max-width:34rem;margin:1rem auto 0">
              <strong>Falta el pago de ${money(r.pago.monto)}</strong>
              <span>Le apartamos la mesa, pero solo queda en firme cuando se reciba el pago.</span>
              <div class="notice-actions">
                <button class="btn btn-sm btn-gold" type="button" data-pagar="${esc(r.code)}">Pagar ahora</button>
              </div>
            </div>`
          : ''
      }
      ${
        r.deposit
          ? `<p class="block-note">Por ser un grupo de ${r.party}, lo llamamos hoy mismo al ${esc(
              r.phone
            )} para coordinar la garantía.</p>`
          : ''
      }
      <div class="success-actions">
        <button class="btn btn-gold" type="button" data-ics="${esc(r.code)}">Agregar al calendario</button>
        <a class="btn" href="https://wa.me/573107429080?text=${encodeURIComponent(
          `Hola, tengo la reserva ${r.code} para el ${prettyDate(r.date)} a las ${prettyTime(r.time)}.`
        )}" target="_blank" rel="noopener">Escribirnos</a>
        <button class="btn btn-ghost" type="button" onclick="window.print()">Imprimir</button>
        <button class="btn btn-ghost" type="button" data-action="restart">Hacer otra reserva</button>
      </div>
    </div>`
  );

  $('#successHost').onclick = async (e) => {
    const ics = e.target.closest('[data-ics]');
    if (ics) download(`/api/reservations/${ics.dataset.ics}/ics`);
    const cp = e.target.closest('[data-copy]');
    if (cp) toast((await copy(cp.dataset.copy)) ? 'Código copiado.' : 'No pudimos copiar.', 'ok');
    const pagar = e.target.closest('[data-pagar]');
    if (pagar) {
      await renderPayment(pagar.dataset.pagar);
      showPanel('pago');
    }
    if (e.target.closest('[data-action="restart"]')) window.location.reload();
  };
}

/* ══════════════════════════════════════════════════════════ estado de sala */

async function loadTonight() {
  const host = $('#tonightBody');
  const today = state.config.today;
  let date = today;
  let data = null;

  for (let i = 0; i < 8; i += 1) {
    const candidate = addDays(today, i);
    try {
      const res = await api(`/api/availability?date=${candidate}&party=2`);
      if (!res.problem && res.services.some((s) => s.openCount > 0)) {
        data = res;
        date = candidate;
        break;
      }
    } catch {
      break;
    }
  }

  if (!data) {
    fill(host, '<p class="muted">Escríbanos y le contamos cómo va la agenda.</p>');
    return;
  }

  const open = data.services.flatMap((s) => s.slots).filter((s) => s.status === 'free' || s.status === 'ultimas');
  const total = data.services.flatMap((s) => s.slots).length || 1;
  const free = Math.round((open.length / total) * 100);
  $('#factTonight').textContent = open.length;

  fill(
    host,
    `<p class="tonight-title">${date === today ? 'Hoy' : `El ${prettyDate(date)}`} quedan
      ${plural(open.length, 'horario', 'horarios')} para dos</p>
     <div class="tonight-meter"><i style="width:${free}%"></i></div>
     <div class="tonight-row"><span>Horarios libres</span><span>${open.length} de ${total}</span></div>
     <div class="tonight-slots">${open
       .slice(0, 6)
       .map((s) => `<button class="chip" type="button" data-jump="${s.time}" data-jump-date="${date}">${prettyTime(s.time)}</button>`)
       .join('')}</div>
     <div class="tonight-row"><span>Siguiente servicio</span><span>${esc(
       data.services.find((s) => s.openCount)?.label || '—'
     )}</span></div>`
  );

  host.onclick = (e) => {
    const btn = e.target.closest('[data-jump]');
    if (!btn) return;
    state.party = 2;
    $$('[data-party]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.party === '2')));
    state.stripFrom = btn.dataset.jumpDate;
    pickDate(btn.dataset.jumpDate, { rebuildStrip: true });
    setTimeout(() => {
      state.time = btn.dataset.jump;
      renderSlots();
      gateStep1();
      renderRail();
    }, 450);
    goStep(1);
  };
}

/* ═══════════════════════════════════════════════════════════════ salones/carta */

function renderSalones() {
  const host = $('#salonGrid');
  host.innerHTML = state.config.zones
    .map((zone) => {
      const tables = state.config.tables.filter((t) => t.zone === zone.id);
      const seats = tables.reduce((s, t) => s + t.max, 0);
      const plan = tables
        .map(
          (t) => `<span class="plan-table shape-${t.shape} is-free"
            style="left:${t.x}%;top:${t.y}%;width:${(t.w * PLAN_W).toFixed(2)}%;height:${(t.h * PLAN_H).toFixed(2)}%"></span>`
        )
        .join('');
      return `<article class="salon">
        <div class="salon-figure floorplan">${plan}</div>
        <h3>${esc(zone.name)}</h3>
        <p>${esc(zone.description)}</p>
        <div class="salon-foot">
          <span>${plural(tables.length, 'mesa', 'mesas')} · ${seats} puestos</span>
          <button class="btn btn-sm" type="button" data-pick-zone="${zone.id}">Reservar aquí</button>
        </div>
      </article>`;
    })
    .join('');

  host.onclick = (e) => {
    const btn = e.target.closest('[data-pick-zone]');
    if (!btn) return;
    state.zone = btn.dataset.pickZone;
    goStep(state.time ? 2 : 1);
    toast(`Salón elegido: ${state.config.zones.find((z) => z.id === state.zone).name}`, 'ok');
  };
}

function renderMenu() {
  const tabs = $('#menuTabs');
  const host = $('#menuHost');
  const menu = state.config.menu;
  let current = menu[0].id;

  const paint = () => {
    tabs.innerHTML = menu
      .map(
        (s) => `<button class="chip" type="button" role="tab" aria-pressed="${s.id === current}"
          data-menu="${s.id}">${esc(s.name)}</button>`
      )
      .join('');
    const section = menu.find((s) => s.id === current);
    fill(
      host,
      `${section.note ? `<p class="menu-note">${esc(section.note)}</p>` : ''}
       ${section.items
         .map(
           (item) => `<article class="dish">
            <h3 class="dish-name">${esc(item.name)}
              ${item.tags.includes('vegan') ? '<span class="dish-tag">vegano</span>' : ''}
              ${item.tags.includes('veg') && !item.tags.includes('vegan') ? '<span class="dish-tag">veg</span>' : ''}
            </h3>
            <span class="dish-price">${money(item.price)}</span>
            <p class="dish-desc">${esc(item.desc)}</p>
          </article>`
         )
         .join('')}`
    );
  };

  tabs.onclick = (e) => {
    const btn = e.target.closest('[data-menu]');
    if (!btn) return;
    current = btn.dataset.menu;
    paint();
  };
  paint();
}

function renderHours() {
  const order = [2, 3, 4, 5, 6, 0, 1];
  const today = weekday(state.config.today);
  fill(
    $('#hoursList'),
    order
      .map((day) => {
        const entry = state.config.hours.find((h) => h.day === day);
        const services = entry ? entry.services : [];
        const text = services.length
          ? services.map((s) => `${s.open}–${s.close}`).join(' · ')
          : '<span class="hours-closed">cerrado</span>';
        return `<li class="${day === today ? 'is-today' : ''}"><b>${DIAS[day]}</b><span>${text}</span></li>`;
      })
      .join('')
  );
}

/* ═════════════════════════════════════════════════════════════════ diálogos */

function wireDialogs() {
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="open-lookup"]')) {
      $('#lookupDialog').showModal();
    }
    if (e.target.closest('[data-action="open-event"]')) {
      const dlg = $('#eventDialog');
      const dateInput = dlg.querySelector('[name="date"]');
      if (state.config) {
        dateInput.min = state.config.today;
        dateInput.value = state.date || state.config.today;
      }
      dlg.showModal();
    }
    const close = e.target.closest('[data-close]');
    if (close) close.closest('dialog').close();
  });

  $$('dialog').forEach((dlg) =>
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close();
    })
  );

  wireLookup();
  wireEventForm();
  wireQuickHash();
}

async function wireQuickHash() {
  if (location.hash === '#mi-reserva') $('#lookupDialog').showModal();

  // Enlace directo a la pantalla de pago. Lo usan el correo de confirmación
  // y la página de la lista de espera, que llegan de fuera del sitio.
  const pagar = new URLSearchParams(location.search).get('pagar');
  if (pagar) {
    window.scrollTo({ top: $('#reservar').offsetTop - 80, behavior: 'smooth' });
    await renderPayment(pagar);
    showPanel('pago');
  }
}

function wireQuickbar() {
  $('#quickbar').addEventListener('submit', async (e) => {
    e.preventDefault();
    state.party = Number($('#qPeople').value);
    const date = $('#qDate').value || state.config.today;
    state.stripFrom = date;
    $$('[data-party]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.party) === state.party)));
    await loadCalendar();
    renderStrip();
    pickDate(date);
    await goStep(1);

    const service = $('#qService').value;
    if (service !== 'cualquiera' && state.availability) {
      const group = state.availability.services.find((s) => s.id === service || s.label.toLowerCase().includes(service));
      if (group && group.firstOpen) {
        state.time = group.firstOpen;
        renderSlots();
        gateStep1();
        renderRail();
      } else {
        toast(`No quedan mesas para ${service} ese día.`, 'error');
      }
    }
  });
}

function wireLookup() {
  const form = $('#lookupForm');
  const result = $('#lookupResult');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const code = (data.code || '').trim();
    const phone = (data.phone || '').trim();
    if (!code && !phone) {
      toast('Escriba el código o el celular.', 'error');
      return;
    }
    fill(result, '<div class="found"><div class="skeleton" style="height:6rem"></div></div>');
    try {
      const query = code ? `code=${encodeURIComponent(code)}` : `phone=${encodeURIComponent(phone)}`;
      const data2 = await api(`/api/reservations/lookup?${query}`);
      const list = data2.reservations || [data2.reservation];
      renderFound(list, result);
    } catch (err) {
      fill(result, `<div class="found"><div class="notice">${esc(err.message)}</div></div>`);
    }
  });
}

function renderFound(list, host) {
  fill(
    host,
    `<div class="found">
      ${list
        .map(
          (r) => `<article class="found-card" data-code="${esc(r.code)}">
        <div class="found-head">
          <div>
            <p class="found-when">${esc(r.prettyDate)}, ${esc(r.prettyTime)}</p>
            <p class="found-meta">${esc(r.zoneName)} · mesa ${esc(r.tableId)} · ${plural(
              r.party,
              'persona',
              'personas'
            )} · <span class="mono">${esc(r.code)}</span></p>
          </div>
          <span class="badge ${
            r.status === 'cancelada'
              ? 'badge-danger'
              : r.status === 'pendiente-pago'
                ? 'badge-warn'
                : r.status === 'pendiente'
                ? 'badge-warn'
                  : r.status === 'completada'
                    ? 'badge-info'
                    : 'badge-ok'
          }">${esc(statusLabel(r.status))}</span>
        </div>
        ${
          r.pago && r.pago.requerido
            ? `<p class="found-meta">Pago: ${
                r.pago.estado === 'pagado'
                  ? `${money(r.pago.monto)} recibido${r.pago.metodoLabel ? ` por ${esc(r.pago.metodoLabel)}` : ''}`
                  : `<strong style="color:var(--gold-300)">pendiente, ${money(r.pago.monto)}</strong>`
              }</p>`
            : ''
        }
        ${r.occasion !== 'ninguna' ? `<p class="found-meta">Celebran: ${esc(r.occasionLabel)}</p>` : ''}
        ${r.preferenceLabels.length ? `<p class="found-meta">${esc(r.preferenceLabels.join(' · '))}</p>` : ''}
        ${
          ['pendiente-pago', 'pendiente', 'confirmada'].includes(r.status)
            ? `<div class="found-actions">
                ${
                  r.pago && r.pago.requerido && r.pago.estado !== 'pagado'
                    ? `<button class="btn btn-sm btn-gold" type="button" data-pagar-lookup="${esc(r.code)}">Pagar ${money(
                        r.pago.monto
                      )}</button>`
                    : ''
                }
                <button class="btn btn-sm" type="button" data-edit="${esc(r.code)}">Cambiar fecha u hora</button>
                <button class="btn btn-sm" type="button" data-ics="${esc(r.code)}">Calendario</button>
                <button class="btn btn-sm btn-danger" type="button" data-cancel="${esc(r.code)}">Cancelar</button>
              </div>
              <div data-edit-host="${esc(r.code)}"></div>`
            : ''
        }
      </article>`
        )
        .join('')}
    </div>`
  );

  host.onclick = async (e) => {
    const ics = e.target.closest('[data-ics]');
    if (ics) download(`/api/reservations/${ics.dataset.ics}/ics`);

    const cancel = e.target.closest('[data-cancel]');
    if (cancel) {
      if (!window.confirm('¿Seguro que cancelamos esta reserva?')) return;
      try {
        const res = await api(`/api/reservations/${cancel.dataset.cancel}`, {
          method: 'PATCH',
          body: { action: 'cancelar' }
        });
        toast(res.message || 'Reserva cancelada.', 'ok');
        renderFound([res.reservation], host);
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    const pagar = e.target.closest('[data-pagar-lookup]');
    if (pagar) {
      $('#lookupDialog').close();
      await renderPayment(pagar.dataset.pagarLookup);
      showPanel('pago');
      return;
    }

    const edit = e.target.closest('[data-edit]');
    if (edit) openEditor(edit.dataset.edit, host);
  };
}

async function openEditor(code, host) {
  const card = $(`[data-code="${code}"]`, host);
  const editHost = $(`[data-edit-host="${code}"]`, card);
  if (editHost.dataset.open === '1') {
    editHost.innerHTML = '';
    editHost.dataset.open = '0';
    return;
  }
  editHost.dataset.open = '1';
  fill(editHost, '<div class="edit-grid"><div class="skeleton" style="height:3rem"></div></div>');

  const current = await api(`/api/reservations/lookup?code=${code}`).then((d) => d.reservation);
  const maxParty = state.config.restaurant.maxPartyOnline;

  const paint = async (date, party) => {
    const av = await api(`/api/availability?date=${date}&party=${party}&exclude=${code}`);
    const slots = av.services.flatMap((s) => s.slots).filter((s) => s.status === 'free' || s.status === 'ultimas');
    fill(
      editHost,
      `<div class="edit-grid">
        <label class="field"><span>Fecha</span>
          <input class="input" type="date" name="date" value="${date}" min="${state.config.today}" /></label>
        <label class="field"><span>Personas</span>
          <select class="select" name="party">${Array.from({ length: maxParty }, (_, i) => i + 1)
            .map((n) => `<option value="${n}" ${n === party ? 'selected' : ''}>${n}</option>`)
            .join('')}</select></label>
        <label class="field"><span>Hora</span>
          <select class="select" name="time">
            ${
              slots.length
                ? slots
                    .map(
                      (s) =>
                        `<option value="${s.time}" ${s.time === current.time ? 'selected' : ''}>${prettyTime(
                          s.time
                        )}</option>`
                    )
                    .join('')
                : '<option value="">Sin horarios libres</option>'
            }
          </select></label>
        <div style="display:flex;align-items:flex-end">
          <button class="btn btn-gold btn-sm" type="button" data-save="${esc(code)}" ${
            slots.length ? '' : 'disabled'
          }>Guardar</button>
        </div>
      </div>
      ${av.problem ? `<p class="field-error">${esc(av.problem)}</p>` : ''}`
    );

    $('[name="date"]', editHost).onchange = (e) => paint(e.target.value, Number($('[name="party"]', editHost).value));
    $('[name="party"]', editHost).onchange = (e) => paint($('[name="date"]', editHost).value, Number(e.target.value));
    $(`[data-save="${code}"]`, editHost).onclick = async () => {
      try {
        const res = await api(`/api/reservations/${code}`, {
          method: 'PATCH',
          body: {
            date: $('[name="date"]', editHost).value,
            time: $('[name="time"]', editHost).value,
            party: Number($('[name="party"]', editHost).value)
          }
        });
        toast(res.message || 'Reserva actualizada.', 'ok');
        renderFound([res.reservation], host);
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  };

  paint(current.date, current.party);
}

function statusLabel(id) {
  const found = state.config.statuses.find((s) => s.id === id);
  return found ? found.label : id;
}

function openWaitlist() {
  const dlg = $('#eventDialog');
  $('#eventTitle').textContent = 'Avísenme si se libera una mesa';
  const party = dlg.querySelector('[name="party"]');
  party.min = 1;
  party.value = state.party;
  dlg.querySelector('[name="date"]').value = state.date;
  dlg.showModal();
}

function wireEventForm() {
  $('#eventForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = Object.fromEntries(new FormData(form).entries());
    const party = Number(data.party);
    try {
      if (party > state.config.restaurant.maxPartyOnline) {
        await api('/api/waitlist', {
          method: 'POST',
          body: { ...data, party: state.config.restaurant.maxPartyOnline, notes: `Grupo de ${party}. ${data.notes}` }
        });
      } else {
        await api('/api/waitlist', { method: 'POST', body: { ...data, party } });
      }
      toast('Recibido. Lo llamamos hoy mismo.', 'ok', 6000);
      form.reset();
      $('#eventDialog').close();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}
