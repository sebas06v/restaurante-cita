/* ==========================================================================
   Sofía · widget de chat. Habla con /api/chat por SSE y va escribiendo la
   respuesta a medida que llega, igual que una persona escribiendo.
   ========================================================================== */

import { $, esc, api, toast, node, download, copy, plural } from './lib.js';

const KEY = 'guayacan.chat';
const SUGGESTIONS = [
  'Mesa para dos el viernes',
  '¿Qué tienen sin gluten?',
  'Somos 8 para un cumpleaños',
  'Quiero cambiar mi reserva'
];

const state = {
  open: false,
  busy: false,
  sessionId: null,
  info: null,
  transcript: []
};

const BLOSSOM = `<svg viewBox="0 0 40 40" aria-hidden="true">
  <path d="M20 5c2.7 4.3 6.9 6 11.5 5.7-2 4.2-1.5 8.6 1 12.5-4.5-.8-8.6.8-11.7 4.1-3-3.3-7.2-4.9-11.7-4.1 2.5-3.9 3-8.3 1-12.5C14.7 11 17.3 9.3 20 5Z" fill="#1a1206"/>
  <circle cx="20" cy="19.5" r="3.3" fill="#f6dda1"/>
</svg>`;

let panel;
let log;
let input;
let sendBtn;
let suggestHost;
let launcher;

boot();

async function boot() {
  if (!document.querySelector('#reservar')) return; // solo en el sitio público
  build();
  restore();

  try {
    state.info = await api('/api/chat/info');
  } catch {
    state.info = { enabled: false };
  }
  paintStatus();
}

/* ══════════════════════════════════════════════════════════════ armazón */

function build() {
  launcher = node(`<button class="chat-launcher" type="button" aria-expanded="false" aria-controls="chatPanel">
    <span class="chat-launcher-mark">${BLOSSOM}</span>
    <span class="chat-launcher-text">
      <b>Reservar hablando</b>
      <span>con Sofía</span>
    </span>
  </button>`);

  panel = node(`<section class="chat-panel" id="chatPanel" aria-label="Chat de reservas con Sofía">
    <header class="chat-head">
      <span class="chat-avatar">${BLOSSOM}</span>
      <span class="chat-who">
        <b>Sofía</b>
        <span><i class="chat-dot" id="chatDot"></i><em id="chatStatus" style="font-style:normal">conectando</em></span>
      </span>
      <button class="icon-btn" type="button" data-chat-close aria-label="Cerrar el chat">✕</button>
    </header>

    <div class="chat-log" id="chatLog" role="log" aria-live="polite" aria-atomic="false"></div>

    <div class="chat-suggest" id="chatSuggest"></div>

    <form class="chat-form" id="chatForm">
      <textarea class="chat-input" id="chatInput" rows="1" maxlength="1200"
        placeholder="Escriba aquí… «mesa para 4 el sábado a las 8»"
        aria-label="Su mensaje"></textarea>
      <button class="chat-send" type="submit" id="chatSend" aria-label="Enviar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 12h15M13 6l6 6-6 6"/>
        </svg>
      </button>
      <p class="chat-legal">Sofía solo atiende temas del restaurante, y reserva de verdad. Confirme los datos antes de aceptar.</p>
    </form>
  </section>`);

  document.body.append(launcher, panel);

  log = $('#chatLog', panel);
  input = $('#chatInput', panel);
  sendBtn = $('#chatSend', panel);
  suggestHost = $('#chatSuggest', panel);

  launcher.addEventListener('click', () => toggle(true));
  $('[data-chat-close]', panel).addEventListener('click', () => toggle(false));
  $('#chatForm', panel).addEventListener('submit', onSubmit);

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 112)}px`;
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#chatForm', panel).requestSubmit();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.open) toggle(false);
  });

  // Cualquier enlace del sitio puede abrir el chat.
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="open-chat"]')) toggle(true);
  });

  log.addEventListener('click', (e) => {
    const ics = e.target.closest('[data-chat-ics]');
    if (ics) download(`/api/reservations/${ics.dataset.chatIcs}/ics`);
    const cp = e.target.closest('[data-chat-copy]');
    if (cp) copy(cp.dataset.chatCopy).then((ok) => toast(ok ? 'Código copiado.' : 'No pudimos copiar.', 'ok'));
  });

  suggestHost.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    input.value = btn.textContent;
    $('#chatForm', panel).requestSubmit();
  });
}

function toggle(open) {
  state.open = open;
  panel.classList.toggle('is-open', open);
  launcher.classList.toggle('is-hidden', open);
  launcher.setAttribute('aria-expanded', String(open));
  if (!open) return;

  if (!state.transcript.length) {
    if (state.info && state.info.enabled === false) paintStatus();
    else greet();
  }
  paintSuggestions();
  setTimeout(() => input.focus(), 120);
}

/* ══════════════════════════════════════════════════════════════ pintura */

function paintStatus() {
  const dot = $('#chatDot', panel);
  const label = $('#chatStatus', panel);
  if (state.info && state.info.enabled) {
    dot.classList.remove('is-off');
    label.textContent = 'en línea · reserva de verdad';
    input.disabled = false;
    sendBtn.disabled = false;
    return;
  }

  dot.classList.add('is-off');
  label.textContent = 'apagada';
  input.disabled = true;
  sendBtn.disabled = true;
  if (state.open && !log.querySelector('.msg-error')) {
    log.append(
      node(`<div class="msg msg-error">
        El chat con IA no está encendido en este servidor. Se prende con una llave de DeepSeek:
        copie <code>.env.example</code> a <code>.env</code>, ponga la llave en
        <code>DEEPSEEK_API_KEY</code> y relance <code>npm start</code>.
        Mientras tanto puede reservar en el formulario de arriba o llamarnos al +57 601 742 9080.
      </div>`)
    );
  }
}

function greet() {
  const hour = new Date().getHours();
  const saludo = hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches';
  push('bot', `${saludo}. Soy Sofía, de El Guayacán. ¿Para cuántas personas y qué día busca mesa?`);
}

function paintSuggestions() {
  suggestHost.innerHTML =
    state.transcript.length > 2 || !state.info?.enabled
      ? ''
      : SUGGESTIONS.map((s) => `<button type="button">${esc(s)}</button>`).join('');
}

function push(role, text) {
  const el = node(`<div class="msg msg-${role === 'me' ? 'me' : 'bot'}">${esc(text)}</div>`);
  log.append(el);
  state.transcript.push({ role, text });
  save();
  scroll();
  return el;
}

function scroll() {
  log.scrollTop = log.scrollHeight;
}

function bubble() {
  const el = node('<div class="msg msg-bot"></div>');
  log.append(el);
  scroll();
  return el;
}

/* ══════════════════════════════════════════════════════════════ envío */

async function onSubmit(e) {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || state.busy || !state.info?.enabled) return;

  push('me', text);
  input.value = '';
  input.style.height = 'auto';
  paintSuggestions();
  await ask(text);
}

async function ask(message) {
  state.busy = true;
  sendBtn.disabled = true;
  input.disabled = true;

  const typing = node('<div class="chat-typing"><i></i><i></i><i></i></div>');
  log.append(typing);
  scroll();

  let doing = null;
  let current = null;
  let buffer = '';

  const finish = () => {
    typing.remove();
    if (doing) doing.remove();
    if (current && buffer.trim()) state.transcript.push({ role: 'bot', text: buffer });
    if (current && !buffer.trim()) current.remove();
    save();
    state.busy = false;
    sendBtn.disabled = false;
    input.disabled = false;
    input.focus();
  };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sessionId: state.sessionId })
    });

    if (!res.ok || !res.body) throw new Error('sin respuesta');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let raw = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });

      const chunks = raw.split('\n\n');
      raw = chunks.pop() || '';

      for (const chunk of chunks) {
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;

        let event;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }

        if (event.type === 'session') {
          state.sessionId = event.id;
          save();
        }

        if (event.type === 'tool') {
          typing.remove();
          if (doing) doing.remove();
          doing = node(`<div class="chat-doing"><i></i>${esc(event.label)}…</div>`);
          log.append(doing);
          scroll();
        }

        if (event.type === 'text') {
          typing.remove();
          if (doing) {
            doing.remove();
            doing = null;
          }
          if (!current) {
            current = bubble();
            buffer = '';
          }
          buffer += event.delta;
          current.textContent = buffer;
          scroll();
        }

        if (event.type === 'card') {
          if (current && buffer.trim()) {
            state.transcript.push({ role: 'bot', text: buffer });
            current = null;
            buffer = '';
          }
          renderCard(event.reservation);
        }

        if (event.type === 'error') {
          typing.remove();
          if (doing) doing.remove();
          const el = node(
            `<div class="msg msg-error">${esc(event.message)}${
              event.setup ? `<code>${esc(event.setup)}</code>` : ''
            }</div>`
          );
          log.append(el);
          scroll();
        }
      }
    }
  } catch {
    typing.remove();
    log.append(
      node('<div class="msg msg-error">Se cortó la conexión. Intente otra vez o llámenos al +57 601 742 9080.</div>')
    );
    scroll();
  } finally {
    finish();
  }
}

function renderCard(r) {
  const el = node(`<div class="chat-card">
    <span class="chat-card-code">${esc(r.code)}</span>
    <span class="chat-card-when">${esc(r.prettyDate)}, ${esc(r.prettyTime)}</span>
    <span class="chat-card-meta">${esc(r.zoneName)} · mesa ${esc(r.tableId)} · ${plural(
      r.party,
      'persona',
      'personas'
    )} · a nombre de ${esc(r.name)}</span>
    <span class="chat-card-actions">
      <button class="btn btn-sm btn-gold" type="button" data-chat-ics="${esc(r.code)}">Al calendario</button>
      <button class="btn btn-sm" type="button" data-chat-copy="${esc(r.code)}">Copiar código</button>
    </span>
  </div>`);
  log.append(el);
  state.transcript.push({ role: 'card', reservation: r });
  save();
  scroll();
}

/* ═════════════════════════════════════════════════ memoria de la pestaña */

function save() {
  try {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ sessionId: state.sessionId, transcript: state.transcript.slice(-40) })
    );
  } catch {
    /* modo privado: el chat sigue funcionando, solo no recuerda al recargar */
  }
}

function restore() {
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
  } catch {
    saved = null;
  }
  if (!saved || !saved.transcript?.length) return;

  state.sessionId = saved.sessionId;
  state.transcript = saved.transcript;

  for (const entry of saved.transcript) {
    if (entry.role === 'card') renderCardSilently(entry.reservation);
    else log.append(node(`<div class="msg msg-${entry.role === 'me' ? 'me' : 'bot'}">${esc(entry.text)}</div>`));
  }
  scroll();
}

function renderCardSilently(r) {
  const before = state.transcript;
  state.transcript = [];
  renderCard(r);
  state.transcript = before;
}
