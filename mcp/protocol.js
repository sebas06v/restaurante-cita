#!/usr/bin/env node
/**
 * ==========================================================================
 * El Guayacán · MCP · catálogo y despachador (sin transporte)
 * ==========================================================================
 * Expone la operación del restaurante como herramientas, recursos y prompts
 * para que un asistente pueda consultar y reservar hablando en español.
 *
 * Lo consumen dos transportes: mcp/server.js (stdio) y POST /mcp (HTTP).
 * Sin dependencias: solo `node:*` y la API HTTP del propio restaurante.
 *
 *   Uso:  node mcp/server.js
 *   Env:  GUAYACAN_URL (default http://127.0.0.1:4321)
 *         GUAYACAN_PIN (default 2408)  → habilita las herramientas de sala
 *
 * Regla de oro: por stdout solo salen mensajes del protocolo. Todo log va
 * a stderr.
 * ==========================================================================
 */

const BASE = (process.env.GUAYACAN_URL || 'http://127.0.0.1:4321').replace(/\/$/, '');
const PIN = process.env.GUAYACAN_PIN || '2408';
const SERVER = { name: 'el-guayacan', version: '1.0.0', title: 'El Guayacán · reservas' };
const DEFAULT_PROTOCOL = '2024-11-05';

const log = (...args) => console.error('[mcp]', ...args);

/* ══════════════════════════════════════════════════ cliente de la API HTTP */

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
}

async function call(path, { method = 'GET', body, admin = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (admin) headers['x-admin-pin'] = PIN;

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (err) {
    throw new ApiError(
      `No hay respuesta del sistema de reservas en ${BASE}. ¿Está corriendo \`npm start\`?`,
      503
    );
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(data.error || `Error ${res.status}`, res.status, data);
  return data;
}

/* ═══════════════════════════════════════════════════════════════ formato */

const money = (n) => `$ ${Math.round(n || 0).toLocaleString('es-CO')}`;
const people = (n) => `${n} ${n === 1 ? 'persona' : 'personas'}`;

function ampm(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const suf = h < 12 ? 'a.m.' : 'p.m.';
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${suf}`;
}

/** Config del restaurante, cacheada 5 minutos: casi nunca cambia. */
let configCache = { at: 0, data: null };
async function config() {
  if (configCache.data && Date.now() - configCache.at < 300000) return configCache.data;
  const data = await call('/api/config');
  configCache = { at: Date.now(), data };
  return data;
}

async function today() {
  return (await config()).today;
}

/* ══════════════════════════════════════════════════════════ herramientas */

const S = {
  fecha: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Fecha en formato AAAA-MM-DD.' },
  hora: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', description: 'Hora en formato 24h, HH:MM.' },
  personas: { type: 'integer', minimum: 1, maximum: 12, description: 'Número de comensales (1 a 12).' },
  codigo: { type: 'string', description: 'Código de la reserva, por ejemplo GY-4KQ7.' }
};

const TOOLS = [
  {
    name: 'consultar_disponibilidad',
    title: 'Consultar disponibilidad de un día',
    description:
      'Horarios con mesa libre para un día y un tamaño de grupo. Devuelve cada servicio ' +
      '(almuerzo, cena) con sus horas y en qué salones queda mesa. Úsela antes de crear una reserva.',
    inputSchema: {
      type: 'object',
      properties: {
        personas: S.personas,
        fecha: { ...S.fecha, description: 'Fecha AAAA-MM-DD. Si se omite, se usa hoy.' },
        salon: {
          type: 'string',
          enum: ['terraza', 'salon', 'patio', 'barra', 'privado'],
          description: 'Filtra los horarios que tengan mesa en ese salón.'
        }
      },
      required: ['personas']
    },
    handler: async ({ personas, fecha, salon }) => {
      const date = fecha || (await today());
      const data = await call(`/api/availability?date=${date}&party=${personas}`);

      if (data.problem) {
        const alt = data.suggestions.map((s) => `· ${s.label} desde ${ampm(s.time)}`).join('\n');
        return {
          text: `El ${data.prettyDate} no se puede reservar: ${data.problem}${alt ? `\n\nFechas cercanas:\n${alt}` : ''}`,
          data
        };
      }

      const lines = [`Disponibilidad para ${people(personas)} el ${data.prettyDate}`, ''];
      for (const service of data.services) {
        const open = service.slots.filter((s) => ['free', 'ultimas'].includes(s.status));
        const usable = salon ? open.filter((s) => s.zones.includes(salon)) : open;
        lines.push(`${service.label} (${service.open}–${service.close}, última entrada ${service.lastSeating})`);
        if (!usable.length) {
          lines.push('  sin mesas para ese grupo');
        } else {
          lines.push(
            `  ${usable
              .map((s) => `${s.time}${s.status === 'ultimas' ? '*' : ''}`)
              .join('  ')}`
          );
          lines.push(`  (* quedan 2 mesas o menos · salones: ${[...new Set(usable.flatMap((s) => s.zones))].join(', ')})`);
        }
        lines.push('');
      }
      lines.push(`La mesa se reserva por ${data.turnMinutes} minutos.`);
      return { text: lines.join('\n'), data };
    }
  },

  {
    name: 'proximas_fechas_libres',
    title: 'Buscar los próximos días con mesa',
    description:
      'Recorre el calendario y devuelve qué días tienen mesa para un grupo, con su nivel de ocupación. ' +
      'Sirve para responder "¿cuándo hay para 6 personas?".',
    inputSchema: {
      type: 'object',
      properties: {
        personas: S.personas,
        desde: { ...S.fecha, description: 'Fecha inicial AAAA-MM-DD. Por defecto hoy.' },
        dias: { type: 'integer', minimum: 1, maximum: 60, description: 'Cuántos días revisar (default 14).' }
      },
      required: ['personas']
    },
    handler: async ({ personas, desde, dias = 14 }) => {
      const from = desde || (await today());
      const data = await call(`/api/calendar?from=${from}&days=${dias}&party=${personas}`);
      const lines = [`Próximos ${dias} días para ${people(personas)}:`, ''];
      for (const day of data.calendar) {
        if (!day.open) {
          lines.push(`${day.date}  cerrado — ${day.reason}`);
          continue;
        }
        const presion = day.load >= 70 ? 'casi lleno' : day.load >= 35 ? 'con movimiento' : 'holgado';
        lines.push(
          `${day.date}  ${String(day.slots).padStart(2)} horarios · ${presion} · primera hora ${day.first || '—'}`
        );
      }
      return { text: lines.join('\n'), data };
    }
  },

  {
    name: 'estado_sala',
    title: 'Ver el plano de la sala a una hora',
    description:
      'Estado mesa por mesa (libre, ocupada, bloqueada) en los cinco salones a una fecha y hora concretas. ' +
      'Incluye quién ocupa cada mesa cuando la información existe.',
    inputSchema: {
      type: 'object',
      properties: { fecha: S.fecha, hora: S.hora, personas: S.personas },
      required: ['fecha', 'hora']
    },
    handler: async ({ fecha, hora, personas }) => {
      const q = personas ? `&party=${personas}` : '';
      const data = await call(`/api/floor?date=${fecha}&time=${hora}${q}`);
      const lines = [`Sala el ${fecha} a las ${ampm(hora)}`];
      if (personas) {
        lines.push(
          '(se evalúa el turno completo desde esa hora, por eso pueden aparecer reservas posteriores)'
        );
      }
      lines.push('');
      for (const zone of data.zones) {
        lines.push(`${zone.name} — ${zone.free} libres de ${zone.tables.length}`);
        for (const t of zone.tables) {
          const detalle =
            t.status === 'ocupada'
              ? `${t.reservation.name} (${people(t.reservation.party)}, ${t.reservation.time}, ${t.reservation.status})`
              : t.status === 'no-aplica'
                ? `no aplica para ${people(personas)}`
                : t.status;
          lines.push(`  ${t.id.padEnd(3)} ${t.min}-${t.max}p  ${detalle}`);
        }
        lines.push('');
      }
      return { text: lines.join('\n'), data };
    }
  },

  {
    name: 'crear_reserva',
    title: 'Crear una reserva',
    description:
      'Reserva una mesa y devuelve el código de confirmación. Confirme siempre fecha, hora y número de ' +
      'personas con el huésped antes de llamar esta herramienta: escribe en la agenda real.',
    inputSchema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre y apellido del huésped.' },
        telefono: { type: 'string', description: 'Celular de contacto.' },
        correo: { type: 'string', description: 'Correo electrónico para la confirmación.' },
        personas: S.personas,
        fecha: S.fecha,
        hora: S.hora,
        salon: {
          type: 'string',
          enum: ['terraza', 'salon', 'patio', 'barra', 'privado'],
          description: 'Salón preferido. Si se omite, la casa asigna el mejor disponible.'
        },
        ocasion: {
          type: 'string',
          enum: ['ninguna', 'cumpleanos', 'aniversario', 'romantica', 'negocios', 'familiar', 'grado'],
          description: 'Motivo de la visita, para preparar la mesa.'
        },
        preferencias: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Identificadores de preferencias: silla-bebe, accesible, tranquila, ventana, vegetariano, ' +
            'sin-gluten, sin-lactosa, torta, mascota.'
        },
        experiencias: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Complementos: maridaje-aguardiente, cata-cafe, degustacion, serenata, decoracion.'
        },
        notas: { type: 'string', description: 'Cualquier detalle en palabras del huésped.' }
      },
      required: ['nombre', 'telefono', 'correo', 'personas', 'fecha', 'hora']
    },
    handler: async (args) => {
      const body = {
        name: args.nombre,
        phone: args.telefono,
        email: args.correo,
        party: args.personas,
        date: args.fecha,
        time: args.hora,
        zone: args.salon || null,
        occasion: args.ocasion || 'ninguna',
        preferences: args.preferencias || [],
        experiences: args.experiencias || [],
        notes: args.notas || ''
      };

      let data;
      try {
        data = await call('/api/reservations', { method: 'POST', body });
      } catch (err) {
        const alts = err.data.alternatives || [];
        const fechas = err.data.dates || [];
        const extra = [
          alts.length ? `Horas con mesa ese día: ${alts.map((a) => a.time).join(', ')}` : '',
          fechas.length ? `Otros días: ${fechas.map((f) => `${f.date} ${f.time}`).join(', ')}` : ''
        ]
          .filter(Boolean)
          .join('\n');
        throw new ApiError(extra ? `${err.message}\n${extra}` : err.message, err.status, err.data);
      }

      const r = data.reservation;
      const lines = [
        `Reserva confirmada · ${r.code}`,
        '',
        `${r.name} · ${people(r.party)}`,
        `${r.prettyDate}, ${r.prettyTime}`,
        `${r.zoneName} · mesa ${r.tableId} · turno de ${r.turnMinutes} minutos`,
        `Estado: ${r.status}`
      ];
      if (r.experienceDetail.length) {
        lines.push(`Experiencias: ${r.experienceDetail.map((x) => x.name).join(', ')} (${money(r.estimate.extras)})`);
      }
      if (r.preferenceLabels.length) lines.push(`Preferencias: ${r.preferenceLabels.join(', ')}`);
      if (r.pago && r.pago.requerido) {
        lines.push(
          r.pago.estado === 'pagado'
            ? `Pago recibido: ${money(r.pago.monto)}.`
            : `Falta el pago de ${money(r.pago.monto)}: la mesa queda apartada y solo se cierra al pagar.`
        );
      }
      if (r.deposit) lines.push(`Grupo grande: la casa llama al ${r.phone} para coordinar la garantía.`);
      lines.push('', `Calendario: ${BASE}/api/reservations/${r.code}/ics`);
      return { text: lines.join('\n'), data };
    }
  },

  {
    name: 'buscar_reserva',
    title: 'Buscar una reserva',
    description: 'Encuentra una reserva por su código, o todas las reservas activas de un teléfono.',
    inputSchema: {
      type: 'object',
      properties: {
        codigo: S.codigo,
        telefono: { type: 'string', description: 'Celular con el que se reservó.' }
      },
      anyOf: [{ required: ['codigo'] }, { required: ['telefono'] }]
    },
    handler: async ({ codigo, telefono }) => {
      if (!codigo && !telefono) throw new ApiError('Indique el código o el teléfono.', 400);
      const query = codigo ? `code=${encodeURIComponent(codigo)}` : `phone=${encodeURIComponent(telefono)}`;
      const data = await call(`/api/reservations/lookup?${query}`);
      const list = data.reservations || [data.reservation];
      const text = list
        .map(
          (r) =>
            [
              `${r.code} · ${r.status}`,
              `${r.name} · ${people(r.party)} · ${r.phone}`,
              `${r.prettyDate}, ${r.prettyTime}`,
              `${r.zoneName} · mesa ${r.tableId}`,
              r.occasion !== 'ninguna' ? `Ocasión: ${r.occasionLabel}` : '',
              r.notes ? `Nota: ${r.notes}` : ''
            ]
              .filter(Boolean)
              .join('\n')
        )
        .join('\n\n');
      return { text, data };
    }
  },

  {
    name: 'modificar_reserva',
    title: 'Cambiar fecha, hora o tamaño',
    description:
      'Mueve una reserva existente. Reasigna la mesa automáticamente y falla si no hay cupo, ' +
      'devolviendo las horas que sí tienen mesa.',
    inputSchema: {
      type: 'object',
      properties: { codigo: S.codigo, fecha: S.fecha, hora: S.hora, personas: S.personas },
      required: ['codigo']
    },
    handler: async ({ codigo, fecha, hora, personas }) => {
      const body = {};
      if (fecha) body.date = fecha;
      if (hora) body.time = hora;
      if (personas) body.party = personas;
      if (!Object.keys(body).length) throw new ApiError('No hay nada que cambiar.', 400);

      let data;
      try {
        data = await call(`/api/reservations/${codigo}`, { method: 'PATCH', body });
      } catch (err) {
        const alts = err.data.alternatives || [];
        throw new ApiError(
          alts.length ? `${err.message} Horas con mesa: ${alts.map((a) => a.time).join(', ')}` : err.message,
          err.status,
          err.data
        );
      }
      const r = data.reservation;
      return {
        text: `${r.code} quedó para el ${r.prettyDate} a las ${r.prettyTime}, ${people(r.party)}, ${r.zoneName} (mesa ${r.tableId}).`,
        data
      };
    }
  },

  {
    name: 'cancelar_reserva',
    title: 'Cancelar una reserva',
    description:
      'Cancela la reserva y libera la mesa. Es irreversible desde el lado del huésped: confirme con ' +
      'la persona antes de llamarla.',
    inputSchema: { type: 'object', properties: { codigo: S.codigo }, required: ['codigo'] },
    handler: async ({ codigo }) => {
      const data = await call(`/api/reservations/${codigo}`, { method: 'PATCH', body: { action: 'cancelar' } });
      return { text: `${data.reservation.code} quedó cancelada. La mesa volvió a la agenda.`, data };
    }
  },

  {
    name: 'anotar_lista_espera',
    title: 'Anotar en lista de espera',
    description:
      'Cuando un día está lleno o el grupo pasa de 12, deja los datos en la lista de espera. ' +
      'No reserva mesa, pero si ese día se suelta una que le sirva, al huésped le llega un correo ' +
      'con un botón para tomarla antes que nadie. Sin salón queda como «cualquiera», que es lo que ' +
      'más opciones le da.',
    inputSchema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        telefono: { type: 'string' },
        correo: { type: 'string' },
        personas: { type: 'integer', minimum: 1, maximum: 120 },
        fecha: S.fecha,
        franja: { type: 'string', enum: ['almuerzo', 'cena', 'cualquiera'] },
        salon: { type: 'string', enum: ['terraza', 'salon', 'patio', 'barra', 'privado'] },
        notas: { type: 'string' }
      },
      required: ['nombre', 'telefono', 'correo', 'personas', 'fecha']
    },
    handler: async (args) => {
      const grande = args.personas > 12;
      const data = await call('/api/waitlist', {
        method: 'POST',
        body: {
          name: args.nombre,
          phone: args.telefono,
          email: args.correo,
          party: grande ? 12 : args.personas,
          date: args.fecha,
          window: args.franja || 'cualquiera',
          zone: args.salon || null,
          notes: grande ? `Grupo de ${args.personas}. ${args.notas || ''}`.trim() : args.notas || ''
        }
      });
      return { text: data.message, data };
    }
  },

  {
    name: 'ver_carta',
    title: 'Consultar la carta',
    description:
      'La carta con precios. Sirve para recomendar platos, resolver dudas de alérgenos o armar una ' +
      'sugerencia de menú antes de reservar.',
    inputSchema: {
      type: 'object',
      properties: {
        seccion: {
          type: 'string',
          enum: ['entradas', 'fogon', 'huerta', 'postres', 'bar'],
          description: 'Sección de la carta. Si se omite, se devuelve completa.'
        },
        solo_vegetariano: { type: 'boolean', description: 'Filtra platos vegetarianos o veganos.' }
      }
    },
    handler: async ({ seccion, solo_vegetariano: soloVeg }) => {
      const { menu } = await config();
      const sections = seccion ? menu.filter((s) => s.id === seccion) : menu;
      const lines = [];
      for (const section of sections) {
        const items = soloVeg ? section.items.filter((i) => i.tags.length) : section.items;
        if (!items.length) continue;
        lines.push(`${section.name.toUpperCase()}${section.note ? ` — ${section.note}` : ''}`);
        for (const item of items) {
          const tags = item.tags.length ? ` [${item.tags.join('/')}]` : '';
          lines.push(`  ${item.name} · ${money(item.price)}${tags}`);
          lines.push(`    ${item.desc}`);
        }
        lines.push('');
      }
      return { text: lines.join('\n'), data: { sections } };
    }
  },

  /* ----------------------------------------------- herramientas de sala */

  {
    name: 'agenda_del_dia',
    title: 'Agenda del día (equipo)',
    description:
      'Vista de servicio: indicadores, reservas hora por hora, notas de preparación y bloqueos. ' +
      'Es la herramienta para el brief del turno.',
    admin: true,
    inputSchema: {
      type: 'object',
      properties: { fecha: { ...S.fecha, description: 'Por defecto hoy.' } }
    },
    handler: async ({ fecha }) => {
      const date = fecha || (await today());
      const data = await call(`/api/admin/day?date=${date}`, { admin: true });
      if (!data.open) return { text: `${data.prettyDate}: cerrado. No hay servicio.`, data };

      const m = data.metrics;
      const lines = [
        `${data.prettyDate}`,
        data.services.map((s) => `${s.label} ${s.open}–${s.close}`).join('  ·  '),
        '',
        `${m.total} reservas · ${m.covers} cubiertos · ocupación ${m.occupancy}% · promedio ${m.averageParty} por mesa`,
        `Estados: ${Object.entries(m.byStatus).map(([k, v]) => `${k} ${v}`).join(', ') || 'sin reservas'}`,
        ''
      ];

      for (const r of data.reservations) {
        const marcas = [
          r.occasion !== 'ninguna' ? r.occasionLabel : '',
          r.deposit ? 'garantía' : '',
          ...r.preferenceLabels,
          r.experiences.length ? `${r.experiences.length} exp.` : ''
        ]
          .filter(Boolean)
          .join(' · ');
        lines.push(
          `${r.time}  ${r.tableId.padEnd(3)} ${String(r.party).padStart(2)}p  ${r.name.padEnd(24)} ${r.status}${
            marcas ? `  — ${marcas}` : ''
          }`
        );
        if (r.notes) lines.push(`        nota: ${r.notes}`);
      }

      if (data.blocks.length) {
        lines.push('', 'Bloqueos:');
        for (const b of data.blocks) lines.push(`  ${b.from}–${b.to} ${b.scope} — ${b.reason}`);
      }
      if (data.waitlist.length) {
        lines.push('', `Lista de espera: ${data.waitlist.length} personas pendientes de llamada.`);
      }
      return { text: lines.join('\n'), data };
    }
  },

  {
    name: 'marcar_estado',
    title: 'Marcar estado de una reserva (equipo)',
    description:
      'Cambia el estado de una reserva durante el servicio: confirmada, sentada, completada, no-show o cancelada.',
    admin: true,
    inputSchema: {
      type: 'object',
      properties: {
        codigo: S.codigo,
        estado: {
          type: 'string',
          enum: ['pendiente', 'confirmada', 'sentada', 'completada', 'no-show', 'cancelada']
        },
        mesa: { type: 'string', description: 'Mover a otra mesa, por ejemplo S7.' }
      },
      required: ['codigo']
    },
    handler: async ({ codigo, estado, mesa }) => {
      const body = {};
      if (estado) body.status = estado;
      if (mesa) body.tableId = mesa;
      if (!Object.keys(body).length) throw new ApiError('Indique estado o mesa.', 400);
      const data = await call(`/api/admin/reservations/${codigo}`, { method: 'PATCH', body, admin: true });
      const r = data.reservation;
      return { text: `${r.code}: ${r.name} queda en "${r.status}", mesa ${r.tableId}.`, data };
    }
  },

  {
    name: 'bloquear_franja',
    title: 'Bloquear una franja (equipo)',
    description:
      'Cierra mesas, un salón o todo el restaurante en un rango de horas (lluvia, evento privado, ' +
      'mantenimiento). Avisa qué reservas quedan dentro del bloqueo.',
    admin: true,
    inputSchema: {
      type: 'object',
      properties: {
        fecha: S.fecha,
        desde: S.hora,
        hasta: S.hora,
        alcance: {
          type: 'string',
          description: '"all", el id de un salón (terraza, salon, patio, barra, privado) o el id de una mesa (T3).'
        },
        motivo: { type: 'string' }
      },
      required: ['fecha', 'desde', 'hasta']
    },
    handler: async ({ fecha, desde, hasta, alcance = 'all', motivo }) => {
      const data = await call('/api/admin/blocks', {
        method: 'POST',
        body: { date: fecha, from: desde, to: hasta, scope: alcance, reason: motivo || 'Bloqueo interno' },
        admin: true
      });
      const aviso = data.affected.length
        ? `\nOJO: ${data.affected.length} reservas caen dentro — ${data.affected
            .map((a) => `${a.code} ${a.name} ${a.time}`)
            .join('; ')}`
        : '';
      return { text: `Bloqueo ${data.block.id}: ${desde}–${hasta} sobre "${alcance}".${aviso}`, data };
    }
  },

  {
    name: 'metricas',
    title: 'Métricas del período (equipo)',
    description:
      'Cubiertos por día, distribución por salón, curva de llegada, cancelaciones y no-shows de los ' +
      'últimos días. Para decidir personal y compras.',
    admin: true,
    inputSchema: {
      type: 'object',
      properties: { dias: { type: 'integer', minimum: 3, maximum: 60, description: 'Default 14.' } }
    },
    handler: async ({ dias = 14 }) => {
      const data = await call(`/api/admin/stats?days=${dias}`, { admin: true });
      const t = data.totals;
      const lines = [
        `Últimos ${dias} días`,
        `${t.reservations} reservas · ${t.covers} cubiertos · cancelación ${t.cancelRate}% · no-show ${t.noShowRate}%`,
        `Experiencias vendidas: ${money(t.extras)}`,
        '',
        'Cubiertos por día:'
      ];
      for (const d of data.series) {
        lines.push(`  ${d.date}  ${String(d.covers).padStart(3)}  ${d.open ? '' : '(cerrado)'}`);
      }
      lines.push('', 'Por salón:');
      for (const z of data.byZone) lines.push(`  ${z.name.padEnd(24)} ${z.count}`);
      lines.push('', 'Curva de llegada (cubiertos por hora):');
      for (const h of data.byHour) lines.push(`  ${h.hour}:00  ${h.covers}`);
      return { text: lines.join('\n'), data };
    }
  }
];

/* ═════════════════════════════════════════════════════════════ recursos */

const RESOURCES = [
  {
    uri: 'guayacan://restaurante',
    name: 'Ficha del restaurante',
    description: 'Datos, horarios por día, salones, políticas de reserva y experiencias.',
    mimeType: 'application/json',
    read: async () => {
      const c = await config();
      return JSON.stringify(
        {
          restaurante: c.restaurant,
          horarios: c.hours,
          salones: c.zones,
          mesas: c.tables,
          experiencias: c.experiences,
          ocasiones: c.occasions,
          preferencias: c.preferences,
          politicas: {
            tolerancia_minutos: c.restaurant.holdMinutes,
            garantia_desde_personas: c.restaurant.depositFrom,
            maximo_en_linea: c.restaurant.maxPartyOnline,
            ventana_de_reserva_dias: c.restaurant.bookingWindowDays,
            anticipacion_minima_minutos: c.restaurant.minLeadMinutes
          }
        },
        null,
        2
      );
    }
  },
  {
    uri: 'guayacan://carta',
    name: 'La carta',
    description: 'Secciones, platos, descripciones y precios en pesos.',
    mimeType: 'application/json',
    read: async () => JSON.stringify((await config()).menu, null, 2)
  },
  {
    uri: 'guayacan://agenda/hoy',
    name: 'Agenda de hoy',
    description: 'Reservas e indicadores del día en curso (requiere PIN de sala).',
    mimeType: 'application/json',
    read: async () => {
      const data = await call(`/api/admin/day?date=${await today()}`, { admin: true });
      return JSON.stringify(data, null, 2);
    }
  }
];

/* ═══════════════════════════════════════════════════════════════ prompts */

const PROMPTS = [
  {
    name: 'brief_de_turno',
    title: 'Brief del turno',
    description: 'Resumen operativo del día para leer en la reunión previa al servicio.',
    arguments: [{ name: 'fecha', description: 'AAAA-MM-DD. Por defecto hoy.', required: false }],
    build: ({ fecha }) => [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            `Prepara el brief del turno${fecha ? ` del ${fecha}` : ' de hoy'} para el equipo de sala de El Guayacán.\n\n` +
            'Usa la herramienta agenda_del_dia y, si hace falta, estado_sala y metricas. Entrega:\n' +
            '1. Titular del día: cubiertos esperados y presión por servicio.\n' +
            '2. Mesas que necesitan preparación especial (celebraciones, sillas de bebé, accesibilidad).\n' +
            '3. Grupos grandes y garantías por confirmar, con la hora de llamada.\n' +
            '4. Riesgos: horas pico, bloqueos, mesas encadenadas.\n' +
            '5. Tres frases para el equipo, en tono directo.\n\n' +
            'Sé concreto: nombres, horas y números de mesa.'
        }
      }
    ]
  },
  {
    name: 'reservar_para_huesped',
    title: 'Reservar hablando con el huésped',
    description: 'Guion para tomar una reserva completa sin pedir datos de más.',
    arguments: [
      { name: 'personas', description: 'Número de comensales.', required: true },
      { name: 'fecha', description: 'Fecha deseada AAAA-MM-DD.', required: false },
      { name: 'ocasion', description: 'Motivo de la visita.', required: false }
    ],
    build: ({ personas, fecha, ocasion }) => [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            `Ayúdame a reservar en El Guayacán para ${personas} persona(s)` +
            `${fecha ? ` el ${fecha}` : ''}${ocasion ? `, es ${ocasion}` : ''}.\n\n` +
            'Procedimiento:\n' +
            '1. consultar_disponibilidad para ese día y grupo. Si está lleno, proximas_fechas_libres.\n' +
            '2. Ofrece máximo tres horas y describe el salón que corresponde a cada una.\n' +
            '3. Antes de crear_reserva confirma en una sola frase: fecha, hora, personas, salón y nombre.\n' +
            '4. Pide solo lo que falte: nombre y apellido, celular y correo.\n' +
            '5. Si hay celebración, sugiere una experiencia de la casa sin insistir.\n' +
            '6. Al final entrega el código de reserva y la política de tolerancia.\n\n' +
            'No inventes disponibilidad ni confirmes nada que la herramienta no haya devuelto.'
        }
      }
    ]
  },
  {
    name: 'rescatar_reserva',
    title: 'Rescatar una reserva en riesgo',
    description: 'Cuando el huésped quiere cambiar o cancelar, busca la mejor alternativa antes de soltar la mesa.',
    arguments: [{ name: 'codigo', description: 'Código de la reserva.', required: true }],
    build: ({ codigo }) => [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            `La reserva ${codigo} está en riesgo de cancelarse.\n\n` +
            '1. buscar_reserva para ver el detalle.\n' +
            '2. consultar_disponibilidad en el mismo día y en los dos siguientes, mismo tamaño de grupo.\n' +
            '3. Propón dos alternativas concretas y espera respuesta antes de modificar_reserva.\n' +
            '4. Solo usa cancelar_reserva si la persona lo pide expresamente.\n' +
            '5. Deja constancia de lo acordado en las notas.'
        }
      }
    ]
  }
];

/* ══════════════════════════════════════════════ despacho JSON-RPC 2.0 ══
   Sin transporte: recibe un mensaje y devuelve la respuesta (o null si era
   una notificación). Lo usan igual el stdio de mcp/server.js y la ruta
   HTTP /mcp del restaurante, que es la que se abre desde Postman.
   ══════════════════════════════════════════════════════════════════════ */

export const ERR = { PARSE: -32700, REQUEST: -32600, METHOD: -32601, PARAMS: -32602, INTERNAL: -32603 };

const WRITERS = [
  'crear_reserva',
  'modificar_reserva',
  'cancelar_reserva',
  'marcar_estado',
  'bloquear_franja',
  'anotar_lista_espera'
];

const publicTool = ({ name, title, description, inputSchema, admin }) => ({
  name,
  title,
  description: admin ? `${description} (requiere PIN de sala)` : description,
  inputSchema,
  annotations: {
    readOnlyHint: !WRITERS.includes(name),
    destructiveHint: ['cancelar_reserva', 'bloquear_franja'].includes(name),
    idempotentHint: ['marcar_estado', 'modificar_reserva'].includes(name)
  }
});

const HANDLERS = {
  initialize: (params) => ({
    protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL,
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
      logging: {}
    },
    serverInfo: SERVER,
    instructions:
      'Herramientas del restaurante El Guayacán (Bogotá). Consulte disponibilidad antes de reservar, ' +
      'confirme los datos con el huésped antes de escribir en la agenda y nunca invente horarios: ' +
      'todo horario ofrecido debe venir de consultar_disponibilidad.'
  }),

  ping: () => ({}),

  'tools/list': () => ({ tools: TOOLS.map(publicTool) }),

  'tools/call': async (params) => {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) {
      const e = new Error(`No existe la herramienta "${params?.name}".`);
      e.code = ERR.PARAMS;
      throw e;
    }
    try {
      const { text, data } = await tool.handler(params.arguments || {});
      return {
        content: [{ type: 'text', text }],
        structuredContent: data === undefined ? undefined : { resultado: data }
      };
    } catch (err) {
      // Un error de negocio no rompe la conversación: vuelve como contenido.
      log(`error en ${tool.name}:`, err.message);
      return {
        content: [{ type: 'text', text: `No se pudo completar: ${err.message}` }],
        isError: true
      };
    }
  },

  'resources/list': () => ({
    resources: RESOURCES.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType }))
  }),

  'resources/read': async (params) => {
    const resource = RESOURCES.find((r) => r.uri === params?.uri);
    if (!resource) {
      const e = new Error(`Recurso desconocido: ${params?.uri}`);
      e.code = ERR.PARAMS;
      throw e;
    }
    return {
      contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: await resource.read() }]
    };
  },

  'prompts/list': () => ({
    prompts: PROMPTS.map(({ name, title, description, arguments: args }) => ({
      name,
      title,
      description,
      arguments: args
    }))
  }),

  'prompts/get': (params) => {
    const prompt = PROMPTS.find((p) => p.name === params?.name);
    if (!prompt) {
      const e = new Error(`Prompt desconocido: ${params?.name}`);
      e.code = ERR.PARAMS;
      throw e;
    }
    return { description: prompt.description, messages: prompt.build(params.arguments || {}) };
  }
};

export const METHODS = Object.keys(HANDLERS);

/**
 * Despacha un mensaje JSON-RPC. Devuelve el objeto de respuesta, o null
 * cuando el mensaje era una notificación y no lleva respuesta.
 */
export async function dispatch(message) {
  const { id, method, params } = message || {};
  const isNotification = id === undefined || id === null;

  if (typeof method !== 'string') {
    return isNotification ? null : { jsonrpc: '2.0', id, error: { code: ERR.REQUEST, message: 'Falta "method".' } };
  }

  if (method.startsWith('notifications/')) {
    log(`notificación: ${method}`);
    return null;
  }

  const handler = HANDLERS[method];
  if (!handler) {
    if (isNotification) return null;
    return {
      jsonrpc: '2.0',
      id,
      error: { code: ERR.METHOD, message: `Método no implementado: ${method}`, data: { disponibles: METHODS } }
    };
  }

  try {
    const result = await handler(params);
    return isNotification ? null : { jsonrpc: '2.0', id, result };
  } catch (err) {
    log(`fallo en ${method}:`, err.message);
    if (isNotification) return null;
    return { jsonrpc: '2.0', id, error: { code: err.code || ERR.INTERNAL, message: err.message } };
  }
}

export { TOOLS, RESOURCES, PROMPTS, SERVER, DEFAULT_PROTOCOL, publicTool };
