#!/usr/bin/env node
/**
 * ==========================================================================
 * Genera la colección de Postman a partir del catálogo real del MCP.
 * ==========================================================================
 * Lee `mcp/protocol.js`, así que si mañana se agrega una herramienta, la
 * colección la incluye sola: no hay una segunda lista que se desactualice.
 *
 *   npm run postman
 *
 * Salida:
 *   postman/el-guayacan-mcp.postman_collection.json
 *   postman/el-guayacan.postman_environment.json
 * ==========================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { TOOLS, RESOURCES, PROMPTS, METHODS, publicTool } from '../mcp/protocol.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

/* ──────────────────────────────────────────────────────── piezas comunes */

const uuid = () => crypto.randomUUID();
const json = (obj) => JSON.stringify(obj, null, 2);

const HEADERS = [{ key: 'Content-Type', value: 'application/json' }];

const url = (pathParts, query) => ({
  raw: `{{baseUrl}}/${pathParts.join('/')}${
    query && query.length ? `?${query.map((q) => `${q.key}=${q.value}`).join('&')}` : ''
  }`,
  host: ['{{baseUrl}}'],
  path: pathParts,
  ...(query && query.length ? { query } : {})
});

const script = (lines) => ({ type: 'text/javascript', exec: lines });

/** Petición JSON-RPC al endpoint /mcp. */
function rpc({ name, method, params, description, tests = [], id = '{{rpcId}}' }) {
  const body = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
  // El id va sin comillas para que Postman inyecte el número.
  const raw = json(body).replace(`"id": "{{rpcId}}"`, '"id": {{rpcId}}');

  return {
    name,
    event: tests.length ? [{ listen: 'test', script: script(tests) }] : [],
    request: {
      method: 'POST',
      header: HEADERS,
      body: { mode: 'raw', raw, options: { raw: { language: 'json' } } },
      url: url(['mcp']),
      description
    },
    response: []
  };
}

/** Petición a la API REST del restaurante. */
function rest({ name, method = 'GET', pathParts, query, body, headers = [], description, tests = [] }) {
  return {
    name,
    event: tests.length ? [{ listen: 'test', script: script(tests) }] : [],
    request: {
      method,
      header: [...(body ? HEADERS : []), ...headers],
      ...(body ? { body: { mode: 'raw', raw: json(body), options: { raw: { language: 'json' } } } } : {}),
      url: url(pathParts, query),
      description
    },
    response: []
  };
}

const OK_RPC = [
  "pm.test('responde 200', () => pm.response.to.have.status(200));",
  'const cuerpo = pm.response.json();',
  "pm.test('es JSON-RPC 2.0', () => pm.expect(cuerpo.jsonrpc).to.eql('2.0'));",
  "pm.test('sin error de protocolo', () => pm.expect(cuerpo.error, JSON.stringify(cuerpo.error)).to.be.undefined);"
];

const OK_TOOL = [
  ...OK_RPC,
  "pm.test('la herramienta no falló', () => pm.expect(cuerpo.result.isError, cuerpo.result.content && cuerpo.result.content[0] && cuerpo.result.content[0].text).to.not.eql(true));",
  "pm.test('trae texto y datos', () => {",
  '  pm.expect(cuerpo.result.content[0].type).to.eql("text");',
  '  pm.expect(cuerpo.result.structuredContent).to.be.an("object");',
  '});',
  "console.log(cuerpo.result.content.map((c) => c.text).join('\\n'));"
];

/* ─────────────────────────── argumentos de ejemplo por herramienta ───── */

const EXAMPLES = {
  consultar_disponibilidad: {
    args: { personas: 4, fecha: '{{fecha}}' },
    nota: 'Los horarios que devuelve son los únicos que se le pueden ofrecer a un huésped.'
  },
  proximas_fechas_libres: {
    args: { personas: 4, dias: 10 },
    nota:
      'Córrala primero: su test guarda en las variables `fecha` y `hora` el primer día y la primera hora ' +
      'con mesa, y el resto de la colección los usa.',
    tests: [
      ...OK_TOOL,
      'const dias = cuerpo.result.structuredContent.resultado.calendar.filter((d) => d.open && d.slots > 2);',
      "pm.test('hay al menos un día con mesa', () => pm.expect(dias.length).to.be.above(0));",
      'if (dias.length) {',
      "  pm.collectionVariables.set('fecha', dias[0].date);",
      "  pm.collectionVariables.set('hora', dias[0].first);",
      "  console.log('fecha =', dias[0].date, '· hora =', dias[0].first);",
      '}'
    ]
  },
  estado_sala: {
    args: { fecha: '{{fecha}}', hora: '{{hora}}', personas: 4 },
    nota: 'El plano mesa por mesa. Ojo: evalúa el turno completo desde esa hora.'
  },
  ver_carta: {
    args: { seccion: 'fogon' },
    nota: 'Quite `seccion` para traer la carta completa, o agregue `solo_vegetariano: true`.'
  },
  crear_reserva: {
    args: {
      nombre: 'Mariana Arboleda',
      telefono: '+57 311 448 2076',
      correo: 'mariana.arboleda@correo.com',
      personas: 4,
      fecha: '{{fecha}}',
      hora: '{{hora}}',
      salon: 'terraza',
      ocasion: 'aniversario',
      preferencias: ['tranquila', 'ventana'],
      experiencias: ['maridaje-aguardiente'],
      notas: 'Diez años de casados. Si se puede, mesa apartada del paso.'
    },
    nota:
      'ESCRIBE en la agenda de verdad. Su test guarda el código en la variable `codigo`, que usan ' +
      'las peticiones de buscar, modificar y cancelar.',
    tests: [
      ...OK_TOOL,
      'const r = cuerpo.result.structuredContent.resultado.reservation;',
      "pm.test('devuelve código y mesa', () => {",
      '  pm.expect(r.code).to.match(/^GY-[A-Z0-9]{4}$/);',
      '  pm.expect(r.tableId).to.be.a("string");',
      '});',
      "pm.collectionVariables.set('codigo', r.code);",
      "console.log('reserva', r.code, '· mesa', r.tableId, '·', r.prettyDate, r.prettyTime);"
    ]
  },
  buscar_reserva: {
    args: { codigo: '{{codigo}}' },
    nota: 'También acepta `telefono` en vez de `codigo`.'
  },
  modificar_reserva: {
    args: { codigo: '{{codigo}}', personas: 3 },
    nota:
      'Reasigna la mesa sola. Pruebe a subir el grupo a 8: si no cabe, el error trae las horas que sí ' +
      'tienen mesa, que es justo lo que el modelo necesita para seguir hablando.'
  },
  cancelar_reserva: {
    args: { codigo: '{{codigo}}' },
    nota: 'Destructiva: libera la mesa. Déjela de última en la carpeta.'
  },
  anotar_lista_espera: {
    args: {
      nombre: 'Grupo Cifuentes',
      telefono: '+57 300 000 0000',
      correo: 'grupo@correo.com',
      personas: 20,
      fecha: '{{fecha}}',
      franja: 'cena',
      notas: 'Cierre de trimestre, quieren salón privado.'
    },
    nota: 'La salida para grupos de más de 12 y para días llenos. No reserva mesa.'
  },
  agenda_del_dia: {
    args: { fecha: '{{fecha}}' },
    nota: 'Necesita GUAYACAN_PIN en el servidor del MCP. Es la vista del equipo de sala.'
  },
  marcar_estado: {
    args: { codigo: '{{codigo}}', estado: 'sentada' },
    nota: 'Estados: pendiente, confirmada, sentada, completada, no-show, cancelada.'
  },
  bloquear_franja: {
    args: {
      fecha: '{{fecha}}',
      desde: '20:00',
      hasta: '21:30',
      alcance: 'terraza',
      motivo: 'Brasero en reparación'
    },
    nota: 'Avisa qué reservas quedan dentro del bloqueo. `alcance` acepta all, un salón o una mesa.'
  },
  metricas: {
    args: { dias: 14 },
    nota: 'Cubiertos por día, ocupación, cancelaciones y no-shows.'
  }
};

/* ──────────────────────────────────────────────── carpetas de la colección */

const annotated = TOOLS.map(publicTool);
const findTool = (name) => annotated.find((t) => t.name === name);

function toolRequest(name) {
  const meta = findTool(name);
  const example = EXAMPLES[name] || { args: {} };
  const tag = [
    meta.annotations.readOnlyHint ? 'Solo lectura.' : 'Escribe en la agenda.',
    meta.annotations.destructiveHint ? 'Destructiva.' : ''
  ]
    .filter(Boolean)
    .join(' ');

  return rpc({
    name,
    method: 'tools/call',
    params: { name, arguments: example.args },
    description: `${meta.description}\n\n${tag}${example.nota ? `\n\n${example.nota}` : ''}`,
    tests: example.tests || OK_TOOL
  });
}

const protocolo = {
  name: '0 · Protocolo',
  description:
    'El saludo del MCP y su catálogo. `initialize` primero: es el que negocia la versión y le entrega al ' +
    'cliente las instrucciones del restaurante.',
  item: [
    rpc({
      name: 'initialize',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: { roots: { listChanged: false } },
        clientInfo: { name: 'postman', version: '1.0.0' }
      },
      description: 'Handshake. Devuelve serverInfo, capacidades e instrucciones para el modelo.',
      tests: [
        ...OK_RPC,
        "pm.test('se presenta', () => pm.expect(cuerpo.result.serverInfo.name).to.eql('el-guayacan'));",
        "pm.test('trae instrucciones', () => pm.expect(cuerpo.result.instructions).to.be.a('string'));",
        'console.log(cuerpo.result.instructions);'
      ]
    }),
    rpc({
      name: 'notifications/initialized',
      method: 'notifications/initialized',
      id: undefined,
      description:
        'Notificación: no lleva `id` y por eso no lleva respuesta. El servidor contesta 202 sin cuerpo.',
      tests: [
        "pm.test('acepta sin responder (202)', () => pm.response.to.have.status(202));",
        "pm.test('cuerpo vacío', () => pm.expect(pm.response.text()).to.eql(''));"
      ]
    }),
    rpc({ name: 'ping', method: 'ping', description: 'Latido. Resultado vacío.', tests: OK_RPC }),
    rpc({
      name: 'tools/list',
      method: 'tools/list',
      description:
        'Las herramientas con su esquema de entrada y sus anotaciones (readOnlyHint, destructiveHint), ' +
        'que son las que hacen que un cliente pida aprobación antes de escribir.',
      tests: [
        ...OK_RPC,
        `pm.test('están las ${annotated.length} herramientas', () => pm.expect(cuerpo.result.tools.length).to.eql(${annotated.length}));`,
        "console.table(cuerpo.result.tools.map((t) => ({ herramienta: t.name, lectura: t.annotations.readOnlyHint })));"
      ]
    }),
    rpc({
      name: 'resources/list',
      method: 'resources/list',
      description: 'Contexto que el modelo puede leer sin gastar una llamada de herramienta.',
      tests: [...OK_RPC, "console.log(cuerpo.result.resources.map((r) => r.uri).join('\\n'));"]
    }),
    ...RESOURCES.map((resource) =>
      rpc({
        name: `resources/read · ${resource.uri.replace('guayacan://', '')}`,
        method: 'resources/read',
        params: { uri: resource.uri },
        description: resource.description,
        tests: [
          ...OK_RPC,
          "pm.test('devuelve contenido', () => pm.expect(cuerpo.result.contents[0].text.length).to.be.above(10));"
        ]
      })
    ),
    rpc({
      name: 'prompts/list',
      method: 'prompts/list',
      description: 'Los guiones que el servidor le ofrece al cliente.',
      tests: OK_RPC
    }),
    ...PROMPTS.map((prompt) =>
      rpc({
        name: `prompts/get · ${prompt.name}`,
        method: 'prompts/get',
        params: {
          name: prompt.name,
          arguments: Object.fromEntries(
            (prompt.arguments || []).map((a) => [
              a.name,
              a.name === 'personas' ? '4' : a.name === 'fecha' ? '{{fecha}}' : a.name === 'codigo' ? '{{codigo}}' : 'aniversario'
            ])
          )
        },
        description: prompt.description,
        tests: [...OK_RPC, 'console.log(cuerpo.result.messages[0].content.text);']
      })
    )
  ]
};

const lectura = {
  name: '1 · Consultar · solo lectura',
  description: 'Nada de esto toca la agenda. Corra `proximas_fechas_libres` primero: fija `fecha` y `hora`.',
  item: ['proximas_fechas_libres', 'consultar_disponibilidad', 'estado_sala', 'ver_carta'].map(toolRequest)
};

const escritura = {
  name: '2 · Reservar · escribe en la agenda',
  description:
    'En orden: crear (guarda `codigo`), buscar, modificar y por último cancelar. `anotar_lista_espera` ' +
    'es la salida para grupos de más de 12.',
  item: [
    toolRequest('crear_reserva'),
    toolRequest('buscar_reserva'),
    toolRequest('modificar_reserva'),
    toolRequest('anotar_lista_espera'),
    toolRequest('cancelar_reserva')
  ]
};

const sala = {
  name: '3 · Sala · requiere PIN',
  description:
    'Herramientas del equipo. El PIN no viaja en la petición: lo lleva el servidor MCP en GUAYACAN_PIN. ' +
    'Vuelva a crear una reserva antes de `marcar_estado` si ya canceló la anterior.',
  item: ['agenda_del_dia', 'marcar_estado', 'bloquear_franja', 'metricas'].map(toolRequest)
};

const errores = {
  name: '4 · Errores · lo que ve el modelo cuando algo no cabe',
  description:
    'Un error de negocio vuelve como `isError: true` con la salida incluida; un error de protocolo vuelve ' +
    'como `error` de JSON-RPC. Son cosas distintas y aquí se ven las dos.',
  item: [
    rpc({
      name: 'Grupo de 20 · no cabe en línea',
      method: 'tools/call',
      params: {
        name: 'crear_reserva',
        arguments: {
          nombre: 'Grupo Cifuentes',
          telefono: '+57 300 000 0000',
          correo: 'grupo@correo.com',
          personas: 20,
          fecha: '{{fecha}}',
          hora: '{{hora}}'
        }
      },
      description: 'El máximo en línea son 12 personas. El texto de vuelta le dice al modelo qué hacer.',
      tests: [
        ...OK_RPC,
        "pm.test('marca isError', () => pm.expect(cuerpo.result.isError).to.eql(true));",
        'console.log(cuerpo.result.content[0].text);'
      ]
    }),
    rpc({
      name: 'Lunes · la casa descansa',
      method: 'tools/call',
      params: { name: 'consultar_disponibilidad', arguments: { personas: 2, fecha: '{{lunes}}' } },
      description: 'No es un fallo: devuelve el motivo y fechas cercanas con cupo.',
      tests: [...OK_RPC, 'console.log(cuerpo.result.content[0].text);']
    }),
    rpc({
      name: 'Herramienta inexistente',
      method: 'tools/call',
      params: { name: 'traer_aguardiente', arguments: {} },
      description: 'Error de parámetros (-32602): el nombre no está en el catálogo.',
      tests: [
        "pm.test('responde 200', () => pm.response.to.have.status(200));",
        'const cuerpo = pm.response.json();',
        "pm.test('error -32602', () => pm.expect(cuerpo.error.code).to.eql(-32602));"
      ]
    }),
    rpc({
      name: 'Método no implementado',
      method: 'sampling/createMessage',
      description: 'Error -32601. La respuesta lista los métodos que sí existen.',
      tests: [
        'const cuerpo = pm.response.json();',
        "pm.test('error -32601', () => pm.expect(cuerpo.error.code).to.eql(-32601));",
        "console.log('métodos disponibles:', cuerpo.error.data.disponibles.join(', '));"
      ]
    }),
    {
      name: 'JSON roto',
      event: [
        {
          listen: 'test',
          script: script([
            "pm.test('responde 400', () => pm.response.to.have.status(400));",
            "pm.test('error de parseo -32700', () => pm.expect(pm.response.json().error.code).to.eql(-32700));"
          ])
        }
      ],
      request: {
        method: 'POST',
        header: HEADERS,
        body: { mode: 'raw', raw: '{ "jsonrpc": "2.0", "id": 1, ', options: { raw: { language: 'json' } } },
        url: url(['mcp']),
        description: 'Cuerpo mal formado: el servidor responde con el error de parseo del protocolo.'
      },
      response: []
    }
  ]
};

const restApi = {
  name: '5 · API REST del restaurante',
  description:
    'Lo que el MCP llama por debajo. Sirve para depurar: si una herramienta devuelve algo raro, aquí se ' +
    've el JSON crudo. El PIN de sala va en la cabecera `x-admin-pin`.',
  item: [
    rest({
      name: 'GET /api/config',
      pathParts: ['api', 'config'],
      description: 'Restaurante, salones, mesas, carta, ocasiones, preferencias y experiencias.',
      tests: [
        "pm.test('200', () => pm.response.to.have.status(200));",
        "pm.collectionVariables.set('hoy', pm.response.json().today);",
        "pm.test('trae mesas', () => pm.expect(pm.response.json().tables.length).to.be.above(0));"
      ]
    }),
    rest({
      name: 'GET /api/calendar',
      pathParts: ['api', 'calendar'],
      query: [
        { key: 'from', value: '{{hoy}}' },
        { key: 'days', value: '14' },
        { key: 'party', value: '4' }
      ],
      description: 'Presión de la agenda día por día.'
    }),
    rest({
      name: 'GET /api/availability',
      pathParts: ['api', 'availability'],
      query: [
        { key: 'date', value: '{{fecha}}' },
        { key: 'party', value: '4' }
      ],
      description: 'Servicios, malla de horarios cada 15 minutos y estado de cada uno.'
    }),
    rest({
      name: 'GET /api/floor',
      pathParts: ['api', 'floor'],
      query: [
        { key: 'date', value: '{{fecha}}' },
        { key: 'time', value: '{{hora}}' },
        { key: 'party', value: '4' }
      ],
      description: 'Estado de las 28 mesas, con sus coordenadas para dibujar el plano.'
    }),
    rest({
      name: 'POST /api/reservations',
      method: 'POST',
      pathParts: ['api', 'reservations'],
      body: {
        name: 'Andrés Mejía',
        phone: '+57 320 551 0099',
        email: 'andres.mejia@correo.com',
        party: 2,
        date: '{{fecha}}',
        time: '{{hora}}',
        zone: 'patio',
        occasion: 'romantica',
        preferences: ['tranquila'],
        experiences: [],
        notes: ''
      },
      description: 'Crear reserva por la API directa. Guarda el código en `codigoRest`.',
      tests: [
        "pm.test('201 creada', () => pm.response.to.have.status(201));",
        "pm.collectionVariables.set('codigoRest', pm.response.json().reservation.code);"
      ]
    }),
    rest({
      name: 'GET /api/reservations/lookup',
      pathParts: ['api', 'reservations', 'lookup'],
      query: [{ key: 'code', value: '{{codigoRest}}' }],
      description: 'Buscar por código. También acepta `phone`.'
    }),
    rest({
      name: 'PATCH /api/reservations/:code · cancelar',
      method: 'PATCH',
      pathParts: ['api', 'reservations', '{{codigoRest}}'],
      body: { action: 'cancelar' },
      description: 'Cancela y libera la mesa.'
    }),
    rest({
      name: 'GET /api/reservations/:code/ics',
      pathParts: ['api', 'reservations', '{{codigoRest}}', 'ics'],
      description: 'Archivo de calendario. En Postman se ve como texto plano.'
    }),
    rest({
      name: 'GET /api/admin/day · PIN',
      pathParts: ['api', 'admin', 'day'],
      query: [{ key: 'date', value: '{{fecha}}' }],
      headers: [{ key: 'x-admin-pin', value: '{{pin}}' }],
      description: 'Agenda del día con KPIs, timeline por mesa y lista de espera.'
    }),
    rest({
      name: 'GET /api/admin/stats · PIN',
      pathParts: ['api', 'admin', 'stats'],
      query: [{ key: 'days', value: '14' }],
      headers: [{ key: 'x-admin-pin', value: '{{pin}}' }],
      description: 'Serie de cubiertos, reparto por salón, curva de llegada.'
    }),
    rest({
      name: 'GET /api/admin/export.csv',
      pathParts: ['api', 'admin', 'export.csv'],
      query: [
        { key: 'from', value: '{{hoy}}' },
        { key: 'to', value: '{{fecha}}' },
        { key: 'pin', value: '{{pin}}' }
      ],
      description: 'Exportación. Aquí el PIN va en la query porque la descarga sale por un enlace del navegador.'
    }),
    rest({
      name: 'GET /mcp · ficha del endpoint',
      pathParts: ['mcp'],
      description: 'Un GET a /mcp no abre un stream: devuelve qué métodos, herramientas y recursos hay.'
    })
  ]
};

/* ─────────────────────────────────────────────────── la colección entera */

const PRE_REQUEST = script([
  '// id incremental para cada mensaje JSON-RPC',
  "const id = Number(pm.collectionVariables.get('rpcId') || 0) + 1;",
  "pm.collectionVariables.set('rpcId', id);",
  '',
  '// Fechas por defecto, para que cualquier petición corra sola.',
  'const iso = (d) => d.toISOString().slice(0, 10);',
  'const hoy = new Date();',
  "if (!pm.collectionVariables.get('hoy')) pm.collectionVariables.set('hoy', iso(hoy));",
  '',
  "if (!pm.collectionVariables.get('fecha')) {",
  '  // el próximo día de servicio: los lunes la casa descansa',
  '  const d = new Date(hoy);',
  '  do { d.setDate(d.getDate() + 1); } while (d.getDay() === 1);',
  "  pm.collectionVariables.set('fecha', iso(d));",
  '}',
  "if (!pm.collectionVariables.get('hora')) pm.collectionVariables.set('hora', '19:00');",
  '',
  '// el próximo lunes, para la petición de día cerrado',
  "if (!pm.collectionVariables.get('lunes')) {",
  '  const l = new Date(hoy);',
  '  do { l.setDate(l.getDate() + 1); } while (l.getDay() !== 1);',
  "  pm.collectionVariables.set('lunes', iso(l));",
  '}'
]);

const collection = {
  info: {
    _postman_id: uuid(),
    name: 'El Guayacán · MCP',
    description: [
      '# El Guayacán · servidor MCP',
      '',
      'El MCP del restaurante hablando por HTTP, para poder verlo y probarlo desde Postman.',
      '',
      '## Antes de empezar',
      '',
      '1. `npm start` en el proyecto. El restaurante queda en `http://127.0.0.1:4321`.',
      '2. Importe también el environment `el-guayacan.postman_environment.json`, o deje las variables',
      '   de la colección como están.',
      '3. Corra la carpeta **0 · Protocolo** de arriba abajo, y después **1 · Consultar**.',
      '',
      '## Cómo funciona',
      '',
      'Todo va a un solo endpoint, `POST {{baseUrl}}/mcp`, con un mensaje JSON-RPC 2.0 en el cuerpo:',
      '',
      '```json',
      '{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",',
      '  "params": { "name": "consultar_disponibilidad", "arguments": { "personas": 4 } } }',
      '```',
      '',
      'El `id` lo inyecta la colección (variable `rpcId`, sube sola en cada petición). El mismo catálogo',
      'se sirve por stdio en `mcp/server.js`, que es como lo levanta Claude Code: este endpoint HTTP',
      'existe para depurar y para verlo aquí.',
      '',
      '## Variables que se llenan solas',
      '',
      '| Variable | Quién la escribe |',
      '| --- | --- |',
      '| `fecha`, `hora` | el test de `proximas_fechas_libres` (y un valor por defecto en el pre-request) |',
      '| `codigo` | el test de `crear_reserva` |',
      '| `codigoRest` | el test de `POST /api/reservations` |',
      '| `hoy` | el test de `GET /api/config` |',
      '| `rpcId` | el pre-request de la colección |',
      '',
      '## Ojo',
      '',
      'Las peticiones de la carpeta 2 y 3 **escriben en la agenda de verdad** (`data/db.json`).',
      'Para volver a empezar limpio: `npm run reset`.',
      '',
      `Generada por \`npm run postman\` desde el catálogo real del MCP: ${annotated.length} herramientas, ${RESOURCES.length} recursos, ${PROMPTS.length} prompts, ${METHODS.length} métodos.`
    ].join('\n'),
    schema: SCHEMA
  },
  event: [{ listen: 'prerequest', script: PRE_REQUEST }],
  variable: [
    { key: 'baseUrl', value: 'http://127.0.0.1:4321', type: 'string' },
    { key: 'pin', value: '2408', type: 'string' },
    { key: 'rpcId', value: '0', type: 'string' },
    { key: 'hoy', value: '', type: 'string' },
    { key: 'fecha', value: '', type: 'string' },
    { key: 'hora', value: '', type: 'string' },
    { key: 'lunes', value: '', type: 'string' },
    { key: 'codigo', value: '', type: 'string' },
    { key: 'codigoRest', value: '', type: 'string' }
  ],
  item: [protocolo, lectura, escritura, sala, errores, restApi]
};

const environment = {
  id: uuid(),
  name: 'El Guayacán · local',
  values: [
    { key: 'baseUrl', value: 'http://127.0.0.1:4321', type: 'default', enabled: true },
    { key: 'pin', value: '2408', type: 'secret', enabled: true }
  ],
  _postman_variable_scope: 'environment',
  _postman_exported_at: new Date().toISOString(),
  _postman_exported_using: 'npm run postman'
};

const collectionPath = path.join(HERE, 'el-guayacan-mcp.postman_collection.json');
const envPath = path.join(HERE, 'el-guayacan.postman_environment.json');

fs.writeFileSync(collectionPath, `${json(collection)}\n`);
fs.writeFileSync(envPath, `${json(environment)}\n`);

const count = (items) => items.reduce((sum, i) => sum + (i.item ? count(i.item) : 1), 0);

console.log('');
console.log('  Colección de Postman generada');
console.log(`  ${'─'.repeat(46)}`);
console.log(`  ${path.relative(process.cwd(), collectionPath)}`);
console.log(`  ${path.relative(process.cwd(), envPath)}`);
console.log('');
for (const folder of collection.item) {
  console.log(`  ${folder.name.padEnd(46)} ${String(count(folder.item)).padStart(2)} peticiones`);
}
console.log(`  ${''.padEnd(46)} ${String(count(collection.item)).padStart(2)} en total`);
console.log('');
