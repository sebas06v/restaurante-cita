/**
 * Configuración del restaurante: identidad, horarios, salones, mesas,
 * carta y experiencias. Única fuente de verdad del negocio.
 */

export const RESTAURANT = {
  name: 'El Guayacán',
  tagline: 'Cocina colombiana de autor',
  address: 'Cra. 7 #69-42, Chapinero Alto, Bogotá',
  phone: '+57 601 742 9080',
  whatsapp: '+57 310 742 9080',
  email: 'reservas@elguayacan.co',
  timezoneOffset: -5, // America/Bogotá, sin horario de verano
  currency: 'COP',
  slotMinutes: 15, // granularidad de la malla de horarios
  holdMinutes: 15, // tolerancia antes de marcar no-show
  maxPartyOnline: 12, // grupos mayores pasan a solicitud de evento
  depositFrom: 8, // desde N personas se pide garantía
  bookingWindowDays: 60, // hasta cuándo se puede reservar
  minLeadMinutes: 45, // anticipación mínima para reservar hoy
  maxCoversPerSlot: 34 // límite de cocina: cubiertos que entran a la vez
};

/** 0 = domingo ... 6 = sábado */
export const SERVICE_HOURS = {
  0: [{ id: 'almuerzo', label: 'Almuerzo dominical', open: '11:30', close: '17:00', lastSeating: '15:30' }],
  1: [],
  2: [
    { id: 'almuerzo', label: 'Almuerzo', open: '12:00', close: '15:30', lastSeating: '14:30' },
    { id: 'cena', label: 'Cena', open: '18:00', close: '22:30', lastSeating: '21:00' }
  ],
  3: [
    { id: 'almuerzo', label: 'Almuerzo', open: '12:00', close: '15:30', lastSeating: '14:30' },
    { id: 'cena', label: 'Cena', open: '18:00', close: '22:30', lastSeating: '21:00' }
  ],
  4: [
    { id: 'almuerzo', label: 'Almuerzo', open: '12:00', close: '15:30', lastSeating: '14:30' },
    { id: 'cena', label: 'Cena', open: '18:00', close: '23:00', lastSeating: '21:30' }
  ],
  5: [
    { id: 'almuerzo', label: 'Almuerzo', open: '12:00', close: '15:30', lastSeating: '14:30' },
    { id: 'cena', label: 'Cena', open: '18:00', close: '23:30', lastSeating: '22:00' }
  ],
  6: [
    { id: 'brunch', label: 'Brunch', open: '11:00', close: '16:00', lastSeating: '14:30' },
    { id: 'cena', label: 'Cena', open: '18:00', close: '23:30', lastSeating: '22:00' }
  ]
};

/** Duración del turno de mesa según tamaño del grupo (minutos). */
export const TURN_MINUTES = [
  { upTo: 2, minutes: 90 },
  { upTo: 4, minutes: 105 },
  { upTo: 6, minutes: 120 },
  { upTo: 8, minutes: 150 },
  { upTo: 99, minutes: 180 }
];

/** Días cerrados por festivo o mantenimiento (YYYY-MM-DD). */
export const CLOSED_DATES = ['2026-12-25', '2027-01-01'];

export const ZONES = [
  {
    id: 'terraza',
    name: 'Terraza del Guayacán',
    subtitle: 'Al aire libre, bajo el árbol',
    description:
      'Ocho mesas alrededor del guayacán amarillo que le da nombre a la casa. Braseros al atardecer y vista a los cerros.',
    vibe: ['Aire libre', 'Vista a los cerros', 'Pet friendly'],
    icon: 'leaf',
    surcharge: 0
  },
  {
    id: 'salon',
    name: 'Salón Principal',
    subtitle: 'El corazón de la casa',
    description:
      'Techos altos, ladrillo a la vista y la cocina abierta al fondo. Es el salón donde se oye el fogón.',
    vibe: ['Cocina abierta', 'Clásico', 'Buena acústica'],
    icon: 'flame',
    surcharge: 0
  },
  {
    id: 'patio',
    name: 'Patio de Helechos',
    subtitle: 'Tranquilo y verde',
    description:
      'Patio interior cubierto, lleno de helechos y luz difusa. El más silencioso, ideal para conversar.',
    vibe: ['Silencioso', 'Cubierto', 'Luz natural'],
    icon: 'fern',
    surcharge: 0
  },
  {
    id: 'barra',
    name: 'Barra de Aguardiente',
    subtitle: 'Solo para uno o dos',
    description:
      'Cinco puestos frente al bartender. Coctelería con destilados colombianos y picadas de la casa.',
    vibe: ['Para dos', 'Coctelería', 'Servicio rápido'],
    icon: 'glass',
    surcharge: 0
  },
  {
    id: 'privado',
    name: 'Comedor La Lechona',
    subtitle: 'Privado, hasta 12',
    description:
      'Salón privado con mesa larga de nogal, sonido independiente y atención dedicada. Para negocios o celebraciones.',
    vibe: ['Privado', 'Hasta 12', 'Requiere garantía'],
    icon: 'door',
    surcharge: 45000
  }
];

/**
 * Mesas del restaurante. x/y/w/h están en un lienzo de 100x100 por salón,
 * lo que permite dibujar el plano real en el front.
 */
export const TABLES = [
  // Terraza
  { id: 'T1', zone: 'terraza', min: 1, max: 2, shape: 'round', x: 12, y: 18, w: 13, h: 13 },
  { id: 'T2', zone: 'terraza', min: 1, max: 2, shape: 'round', x: 12, y: 44, w: 13, h: 13 },
  { id: 'T3', zone: 'terraza', min: 2, max: 4, shape: 'square', x: 12, y: 70, w: 16, h: 15 },
  { id: 'T4', zone: 'terraza', min: 3, max: 4, shape: 'square', x: 40, y: 16, w: 18, h: 16 },
  { id: 'T5', zone: 'terraza', min: 3, max: 4, shape: 'square', x: 40, y: 44, w: 18, h: 16 },
  { id: 'T6', zone: 'terraza', min: 4, max: 6, shape: 'round', x: 40, y: 70, w: 20, h: 18 },
  { id: 'T7', zone: 'terraza', min: 2, max: 4, shape: 'square', x: 72, y: 20, w: 18, h: 16 },
  { id: 'T8', zone: 'terraza', min: 5, max: 8, shape: 'rect', x: 70, y: 48, w: 22, h: 34 },

  // Salón principal
  { id: 'S1', zone: 'salon', min: 1, max: 2, shape: 'round', x: 10, y: 14, w: 12, h: 12 },
  { id: 'S2', zone: 'salon', min: 1, max: 2, shape: 'round', x: 10, y: 38, w: 12, h: 12 },
  { id: 'S3', zone: 'salon', min: 2, max: 4, shape: 'square', x: 10, y: 62, w: 16, h: 15 },
  { id: 'S4', zone: 'salon', min: 3, max: 4, shape: 'square', x: 36, y: 14, w: 17, h: 16 },
  { id: 'S5', zone: 'salon', min: 3, max: 4, shape: 'square', x: 36, y: 40, w: 17, h: 16 },
  { id: 'S6', zone: 'salon', min: 4, max: 6, shape: 'round', x: 34, y: 66, w: 21, h: 19 },
  { id: 'S7', zone: 'salon', min: 4, max: 6, shape: 'round', x: 66, y: 16, w: 21, h: 19 },
  { id: 'S8', zone: 'salon', min: 6, max: 10, shape: 'rect', x: 64, y: 46, w: 26, h: 36 },

  // Patio
  { id: 'P1', zone: 'patio', min: 1, max: 2, shape: 'round', x: 14, y: 20, w: 14, h: 14 },
  { id: 'P2', zone: 'patio', min: 1, max: 2, shape: 'round', x: 14, y: 52, w: 14, h: 14 },
  { id: 'P3', zone: 'patio', min: 2, max: 4, shape: 'square', x: 44, y: 18, w: 18, h: 17 },
  { id: 'P4', zone: 'patio', min: 3, max: 4, shape: 'square', x: 44, y: 50, w: 18, h: 17 },
  { id: 'P5', zone: 'patio', min: 4, max: 6, shape: 'round', x: 74, y: 22, w: 20, h: 19 },
  { id: 'P6', zone: 'patio', min: 4, max: 6, shape: 'round', x: 74, y: 55, w: 20, h: 19 },

  // Barra
  { id: 'B1', zone: 'barra', min: 1, max: 2, shape: 'stool', x: 14, y: 56, w: 12, h: 12 },
  { id: 'B2', zone: 'barra', min: 1, max: 2, shape: 'stool', x: 30, y: 56, w: 12, h: 12 },
  { id: 'B3', zone: 'barra', min: 1, max: 2, shape: 'stool', x: 46, y: 56, w: 12, h: 12 },
  { id: 'B4', zone: 'barra', min: 1, max: 2, shape: 'stool', x: 62, y: 56, w: 12, h: 12 },
  { id: 'B5', zone: 'barra', min: 1, max: 2, shape: 'stool', x: 78, y: 56, w: 12, h: 12 },

  // Privado
  { id: 'V1', zone: 'privado', min: 6, max: 12, shape: 'rect', x: 26, y: 14, w: 48, h: 52 }
];

export const OCCASIONS = [
  { id: 'ninguna', label: 'Sin ocasión especial', icon: '·' },
  { id: 'cumpleanos', label: 'Cumpleaños', icon: '✦' },
  { id: 'aniversario', label: 'Aniversario', icon: '❦' },
  { id: 'romantica', label: 'Cita romántica', icon: '♥' },
  { id: 'negocios', label: 'Almuerzo de negocios', icon: '▤' },
  { id: 'familiar', label: 'Reunión familiar', icon: '⌂' },
  { id: 'grado', label: 'Grado o logro', icon: '☗' }
];

export const PREFERENCES = [
  { id: 'silla-bebe', label: 'Silla para bebé' },
  { id: 'accesible', label: 'Acceso en silla de ruedas' },
  { id: 'tranquila', label: 'Mesa tranquila' },
  { id: 'ventana', label: 'Cerca de la ventana' },
  { id: 'vegetariano', label: 'Opciones vegetarianas' },
  { id: 'sin-gluten', label: 'Sin gluten' },
  { id: 'sin-lactosa', label: 'Sin lactosa' },
  { id: 'torta', label: 'Traemos torta' },
  { id: 'mascota', label: 'Vengo con mi perro' }
];

export const EXPERIENCES = [
  {
    id: 'maridaje-aguardiente',
    name: 'Maridaje de aguardientes',
    detail: 'Cuatro destilados anisados de Antioquia, Caldas y Tolima servidos con la comida.',
    price: 68000,
    per: 'persona'
  },
  {
    id: 'cata-cafe',
    name: 'Cata de cafés de origen',
    detail: 'Tres microlotes (Nariño, Huila, Sierra Nevada) en filtro, al cierre de la comida.',
    price: 42000,
    per: 'persona'
  },
  {
    id: 'degustacion',
    name: 'Menú degustación, 7 pasos',
    detail: 'El recorrido del chef por seis regiones. Se pide para toda la mesa.',
    price: 195000,
    per: 'persona'
  },
  {
    id: 'serenata',
    name: 'Serenata llanera',
    detail: 'Arpa, cuatro y maracas en vivo durante 20 minutos en su mesa.',
    price: 320000,
    per: 'mesa'
  },
  {
    id: 'decoracion',
    name: 'Montaje de celebración',
    detail: 'Flores de la sabana, velas y tarjeta escrita a mano en la mesa.',
    price: 95000,
    per: 'mesa'
  }
];

export const MENU = [
  {
    id: 'entradas',
    name: 'Para empezar',
    note: 'Se sirven al centro',
    items: [
      {
        name: 'Arepa de choclo con quesillo',
        price: 24000,
        tags: ['veg'],
        desc: 'Maíz tierno de Tuluá, quesillo del Huila derretido y mantequilla de hierbas.'
      },
      {
        name: 'Empanadas de pipián',
        price: 26000,
        tags: ['veg'],
        desc: 'Masa de maíz peto, relleno payanés de papa colorada y ají de maní.'
      },
      {
        name: 'Ceviche de camarón y lulo',
        price: 42000,
        tags: [],
        desc: 'Camarón de Tumaco, leche de tigre de lulo y chips de plátano verde.'
      },
      {
        name: 'Carpaccio de posta cartagenera',
        price: 39000,
        tags: [],
        desc: 'Res madurada, suero costeño, alcaparras y aceite de cilantro cimarrón.'
      },
      {
        name: 'Chicharrón carnudo con guacamole',
        price: 34000,
        tags: [],
        desc: 'Cerdo de finca, cocción de seis horas, aguacate hass y ají de la casa.'
      }
    ]
  },
  {
    id: 'fogon',
    name: 'Del fogón de leña',
    note: 'Cocina lenta, para compartir',
    items: [
      {
        name: 'Bandeja paisa de autor',
        price: 78000,
        tags: [],
        desc: 'Frijol cargamanto, chicharrón, chorizo de finca, morcilla, huevo de campo y tajadas.'
      },
      {
        name: 'Ajiaco santafereño',
        price: 62000,
        tags: [],
        desc: 'Tres papas, guascas frescas, pollo criollo, alcaparras, crema y aguacate.'
      },
      {
        name: 'Sancocho de gallina criolla',
        price: 68000,
        tags: [],
        desc: 'Cocido tres horas en leña, yuca, plátano y arracacha del Cauca.'
      },
      {
        name: 'Lechona tolimense',
        price: 84000,
        tags: [],
        desc: 'Cerdo relleno de arroz y arveja, cuero crocante y arepa de maíz blanco.'
      },
      {
        name: 'Posta negra cartagenera',
        price: 76000,
        tags: [],
        desc: 'Res en panela y cola, arroz con coco titoté y patacón pisao.'
      },
      {
        name: 'Mote de queso con costilla',
        price: 64000,
        tags: [],
        desc: 'Ñame espino, suero atollabuey y costilla de cerdo ahumada.'
      }
    ]
  },
  {
    id: 'huerta',
    name: 'De la huerta y del río',
    note: '',
    items: [
      {
        name: 'Trucha del páramo en hoja de bijao',
        price: 72000,
        tags: [],
        desc: 'Trucha de Guasca, mantequilla de ajo criollo y papas chorreadas.'
      },
      {
        name: 'Cazuela de frijol y verduras asadas',
        price: 54000,
        tags: ['veg', 'vegan'],
        desc: 'Cargamanto, calabaza, mazorca asada y hogao ahumado. Sin proteína animal.'
      },
      {
        name: 'Ensalada de la sabana',
        price: 38000,
        tags: ['veg'],
        desc: 'Hojas de Fusagasugá, uchuvas, queso paipa curado y vinagreta de mora.'
      },
      {
        name: 'Pargo rojo entero frito',
        price: 98000,
        tags: [],
        desc: 'Para dos. Arroz de coco, ensalada de mango biche y ají pique.'
      }
    ]
  },
  {
    id: 'postres',
    name: 'Dulces',
    note: '',
    items: [
      {
        name: 'Merengón de guanábana',
        price: 28000,
        tags: ['veg'],
        desc: 'Merengue seco, crema de leche y guanábana del Valle.'
      },
      {
        name: 'Postre de natas con brevas',
        price: 26000,
        tags: ['veg'],
        desc: 'Natas de leche cocida a fuego bajo y brevas caladas en panela.'
      },
      {
        name: 'Torta de cuatro leches y arequipe',
        price: 27000,
        tags: ['veg'],
        desc: 'Bizcocho embebido y arequipe de finca quemado al momento.'
      },
      {
        name: 'Helado de queso costeño y bocadillo',
        price: 24000,
        tags: ['veg'],
        desc: 'Helado salado, bocadillo veleño tibio y polvo de galleta.'
      }
    ]
  },
  {
    id: 'bar',
    name: 'Coctelería y bebidas',
    note: 'Barra de destilados colombianos',
    items: [
      {
        name: 'Guayacán sour',
        price: 34000,
        tags: [],
        desc: 'Aguardiente sin azúcar, lulo, clara de huevo y amargo de la casa.'
      },
      {
        name: 'Viche del Pacífico',
        price: 38000,
        tags: [],
        desc: 'Viche curado, borojó, miel de caña y hierbabuena.'
      },
      {
        name: 'Ron viejo y tamarindo',
        price: 36000,
        tags: [],
        desc: 'Ron 12 años, tamarindo, panela y bíter de cardamomo.'
      },
      {
        name: 'Refajo de la casa',
        price: 22000,
        tags: [],
        desc: 'Cerveza artesanal de Bogotá con soda de manzana y limón.'
      },
      {
        name: 'Jugos de fruta del día',
        price: 16000,
        tags: ['veg'],
        desc: 'Corozo, mora de Castilla, maracuyá o feijoa. En agua o en leche.'
      },
      {
        name: 'Café filtrado de origen',
        price: 14000,
        tags: ['veg', 'vegan'],
        desc: 'Microlote de la semana, molido al pedido.'
      }
    ]
  }
];

/**
 * ==========================================================================
 * Cobro de la reserva
 * ==========================================================================
 * Un valor fijo por reserva, no por persona: es una cuota de garantía para
 * evitar el no-show, abonable al consumo.
 *
 * El modo es SIMULADO: no hay pasarela, no se mueve dinero y la pantalla de
 * pago lo dice. Toda la lógica alrededor (estado, recibo, reflejo en el
 * panel) es la de verdad, así que conectar Wompi o Mercado Pago después es
 * cambiar una función, no rehacer el flujo.
 *
 * Se ajusta desde el entorno, sin tocar código:
 *   GUAYACAN_PAGO_MONTO   valor en pesos (default 30000)
 *   GUAYACAN_PAGO_EXIGIR  todos | grandes | ninguno (default todos)
 */
export const PAGO = {
  activo: process.env.GUAYACAN_PAGO_EXIGIR !== 'ninguno',
  modo: 'simulado',
  monto: Number(process.env.GUAYACAN_PAGO_MONTO) || 30000,
  por: 'reserva',
  exigir: process.env.GUAYACAN_PAGO_EXIGIR || 'todos',
  moneda: 'COP',
  abonable: true,
  // Métodos que ofrece la pantalla de pago. Son los de una pasarela
  // colombiana de verdad, para que el flujo se sienta real.
  metodos: [
    { id: 'pse', label: 'PSE', detalle: 'Débito desde su banco' },
    { id: 'nequi', label: 'Nequi', detalle: 'Pago desde la app' },
    { id: 'tarjeta', label: 'Tarjeta', detalle: 'Crédito o débito' }
  ]
};

/** ¿Esta reserva tiene que pagar para quedar en firme? */
export function requierePago(party) {
  if (!PAGO.activo) return false;
  if (PAGO.exigir === 'grandes') return party >= RESTAURANT.depositFrom;
  return true;
}

export const STATUSES = [
  { id: 'pendiente-pago', label: 'Por pagar' },
  { id: 'pendiente', label: 'Por confirmar' },
  { id: 'confirmada', label: 'Confirmada' },
  { id: 'sentada', label: 'En mesa' },
  { id: 'completada', label: 'Completada' },
  { id: 'no-show', label: 'No llegó' },
  { id: 'cancelada', label: 'Cancelada' }
];

/**
 * Estados que ocupan mesa. «pendiente-pago» cuenta: la mesa se aparta
 * mientras el huésped paga, si no, dos personas pagarían por la misma.
 */
export const ACTIVE_STATUSES = ['pendiente-pago', 'pendiente', 'confirmada', 'sentada'];

/**
 * PIN del panel de sala.
 *
 * En local vale el de demostración, que está en el README. Desplegado, ese PIN
 * es público y dejaría la agenda —con nombres y teléfonos— abierta a cualquiera,
 * así que si no se define GUAYACAN_PIN se genera uno al azar y se imprime en el
 * log de arranque. Nunca un PIN conocido en un servidor público.
 */
const DEMO_PIN = '2408';
const deployed = Boolean(process.env.RENDER || process.env.NODE_ENV === 'production');

export const ADMIN_PIN =
  process.env.GUAYACAN_PIN ||
  (deployed ? String(Math.floor(Math.random() * 900000) + 100000) : DEMO_PIN);

/** ¿El panel está protegido con el PIN de demostración, el que sale publicado? */
export const PIN_IS_DEMO = ADMIN_PIN === DEMO_PIN;
