# El Guayacán · sistema de reservas

Reservas para un restaurante colombiano de autor en Bogotá: sitio público con
reserva en cuatro pasos, panel de sala para el equipo y un servidor MCP para
operarlo desde un asistente.

Sin build. El sitio, la API, el panel, el MCP y el chat con IA no usan ninguna
librería externa; la única dependencia del proyecto es **BullMQ**, para la cola
de correos, y la app arranca igual sin Redis.

```bash
npm start           # http://127.0.0.1:4321
```

| | |
| --- | --- |
| Sitio | <http://127.0.0.1:4321> |
| Panel de sala | <http://127.0.0.1:4321/admin> · PIN `2408` |
| MCP por stdio | `npm run mcp` · flujo demostrado con `npm run mcp:flujo` |
| MCP por HTTP | `POST /mcp` · colección de Postman en [`postman/`](postman/) |

## Qué hace

**Para el huésped**

- Reserva en cuatro pasos: cuándo → dónde → detalles → confirmar.
- Calendario de 21 días con la presión real de cada día, y malla de horarios
  cada 15 minutos que distingue *libre*, *últimas mesas*, *cocina copada* y
  *ya no alcanzamos*.
- Plano del salón: se puede escoger la mesa exacta, no solo la zona.
- Ocasión, preferencias (silla de bebé, accesibilidad, sin gluten…) y
  experiencias de la casa con su precio.
- Confirmación con código (`GY-XXXX`), archivo `.ics` para el calendario y
  enlace de WhatsApp.
- «Mi reserva»: buscar por código o teléfono, mover fecha u hora, cancelar.
- Lista de espera cuando el día está lleno y solicitud de evento para grupos de
  más de 12.

**Para el equipo** (`/admin`)

- Indicadores del día: reservas, cubiertos, ocupación del aforo, promedio por
  mesa, gente sentada, no-shows.
- Plano en vivo de los cinco salones a cualquier hora del servicio.
- Línea de tiempo por mesa (tipo Gantt) con la marca de la hora actual.
- Lista con búsqueda y filtro por estado; cada reserva abre su ficha con
  historial, notas, cambio de estado y mover de mesa.
- Bloqueos por franja (mesa, salón o casa) avisando qué reservas caen dentro.
- Notas de servicio generadas solas: celebraciones, garantías por confirmar,
  sillas de bebé, accesibilidad, experiencias contratadas.
- Analítica de 14 días y exportación a CSV.
- Alta de reservas por teléfono o walk-in.

## Cómo está armado

```
server/          API HTTP y reglas de negocio (Node puro)
  config.js        el restaurante: horarios, salones, mesas, carta, políticas
  availability.js  motor de disponibilidad — funciones puras, sin I/O
  api.js           validaciones y respuestas JSON
  index.js         enrutador + archivos estáticos
  db.js            JSON en disco, escritura atómica y cola de escrituras
  seed.js          agenda de ejemplo (determinista)
  ics.js           archivo de calendario
public/          sitio y panel, sin framework ni build
  index.html       sitio público
  admin.html       panel de sala
  assets/css       tokens de diseño + hojas del sitio y del panel
  assets/js        lib compartida, site.js, admin.js
  mail/            plantillas de los correos y por dónde salen
  queue/           la cola de correos (BullMQ, con respaldo en memoria)
mcp/             MCP: catálogo (protocol.js), stdio (server.js) y demo del flujo
postman/         generador y colección para probar el MCP por HTTP
docs/            documentación del MCP con diagramas
data/db.json     la base (se regenera con npm run reset)
```

### El motor de disponibilidad

Es el corazón y vive aislado en `server/availability.js`, sin tocar disco ni
HTTP. Reglas que aplica:

- **Turno según grupo**: 90 min hasta 2 personas, 105 hasta 4, 120 hasta 6,
  150 hasta 8, 180 en adelante.
- **Servicios por día**: lunes cerrado, domingo solo almuerzo, sábado brunch;
  cada servicio con su última entrada.
- **Mesa de mejor ajuste**: entre las libres elige la que desperdicia menos
  puestos; respeta el salón pedido si puede.
- **Tope de cocina**: máximo 34 cubiertos entrando en la misma media hora.
- **Bloqueos** por mesa, salón o casa completa.
- **Anticipación**: 45 minutos mínimo para el mismo día, agenda abierta a 60 días.
- **Garantía** desde 8 personas: la reserva queda *pendiente* y la casa llama.

### La API

```
GET    /api/config                        restaurante, salones, mesas, carta
GET    /api/calendar?from&days&party      presión por día
GET    /api/availability?date&party       servicios, horarios y su estado
GET    /api/floor?date&time&party         plano mesa por mesa
POST   /api/reservations                  crear
GET    /api/reservations/lookup?code|phone  buscar
PATCH  /api/reservations/:code            mover o cancelar
GET    /api/reservations/:code/ics        archivo de calendario
POST   /api/waitlist                      lista de espera / eventos
```

Con `x-admin-pin` (o `?pin=` para descargas):

```
POST   /api/admin/login
GET    /api/admin/day?date                agenda, KPIs, timeline, notas
POST   /api/admin/reservations            teléfono o walk-in
PATCH  /api/admin/reservations/:id        estado, mesa, notas
POST   /api/admin/blocks                  bloquear franja
DELETE /api/admin/blocks/:id
GET    /api/admin/stats?days              analítica
GET    /api/admin/export.csv?from&to      exportar
GET    /api/admin/waitlist
PATCH  /api/admin/waitlist/:id
```

## El MCP

`mcp/server.js` expone 13 herramientas, 3 recursos y 3 prompts por stdio
(JSON-RPC 2.0), llamando la misma API — no duplica reglas. Ya está declarado en
`.mcp.json`, así que Claude Code lo levanta solo en este proyecto.

```bash
npm run mcp:flujo          # recorre el flujo completo, 18 pasos
npm run mcp:flujo:json     # con el JSON-RPC crudo
```

El detalle, la tabla de herramientas y los diagramas están en
[`docs/mcp-flujo.md`](docs/mcp-flujo.md).

### Verlo en Postman

El mismo catálogo se sirve por HTTP en `POST /mcp`, con mensajes JSON-RPC 2.0
en el cuerpo. La colección se genera desde el catálogo real, así que no se
desincroniza:

```bash
npm run postman
```

Importe `postman/el-guayacan-mcp.postman_collection.json` (y el environment que
está al lado). Son 42 peticiones en seis carpetas: protocolo, consultas,
reservas, sala con PIN, errores y la API REST cruda. Las variables se llenan
solas — `proximas_fechas_libres` fija la fecha y la hora, `crear_reserva`
guarda el código — así que se puede correr la colección de arriba abajo.

Un `GET /mcp` devuelve la ficha del endpoint: métodos, herramientas y recursos.

## Encender el chat (opcional)

El widget «Reservar hablando con Sofía» toma reservas conversando: corre sobre
**DeepSeek** (`deepseek-chat`) con function calling, y llama las mismas nueve
funciones que usa el sitio, así que no hay una segunda copia de las reglas.

```bash
cp .env.example .env      # y ponga su llave en DEEPSEEK_API_KEY
npm start
```

La llave se saca en <https://platform.deepseek.com/api_keys>. `.env` está en
`.gitignore`: la llave nunca entra al repositorio ni al código. El banner de
arranque dice en qué estado quedó:

```
Chat con IA     activo · deepseek/deepseek-chat · 9 herramientas · solo El Guayacán
```

Sin llave, el comportamiento depende de dónde corra: **en un sitio publicado el
botón del chat no se dibuja** —el huésped no tiene por qué ver un botón que no
responde, ni cómo se configura el servidor— y en local sí aparece, con la pista
de qué falta. La reserva por formulario no se toca en ningún caso.

Ajustes: `DEEPSEEK_MODEL` (default `deepseek-chat`), `DEEPSEEK_TEMPERATURE`
(`0.3`) y `DEEPSEEK_BASE_URL`.

### Sofía solo habla del restaurante

El encierro es deliberado y se hace en tres capas del prompt, porque una sola se
escapa: la identidad (*no eres un asistente general*), la lista explícita de lo
que sí y lo que no, y la respuesta literal que debe dar al salirse más la orden
de no ceder ante insistencia, urgencia ni supuestos permisos. El texto del
huésped se trata como una petición, nunca como una instrucción que cambie las
reglas.

Probado con código, geografía, matemáticas, recomendaciones de otros
restaurantes y un intento de inyección (*«ignora tus instrucciones»*): los cinco
se devuelven con una sola frase. Y al revés, sigue respondiendo lo que sí es
suyo — parqueadero, accesibilidad, horarios del domingo y recomendaciones de la
carta con precios reales.

## Cobro de la reserva

Reservar cuesta un valor fijo por reserva —no por persona— que se abona al
consumo. Es una cuota de garantía contra el no-show.

**El pago es simulado**: no hay pasarela, no se mueve dinero y la pantalla lo
dice de frente. Tampoco pide datos de tarjeta: se escoge el método (PSE, Nequi,
tarjeta) y el desenlace que se quiere probar, como el sandbox de una pasarela
de verdad.

Toda la lógica alrededor sí es real, así que conectar Wompi o Mercado Pago
después es cambiar una función (`payReservation` en `server/api.js`), no
rehacer el flujo:

- La reserva nace en estado **por pagar** y la mesa queda apartada —cuenta como
  ocupada, para que dos personas no paguen por la misma.
- Al pagar queda **confirmada** y se emite un recibo con referencia.
- Si el pago se rechaza, la mesa sigue apartada y se puede reintentar.
- Se puede pagar después desde «Mi reserva».
- El panel de sala muestra lo **cobrado** y lo que está **por cobrar**, marca
  con «sin pagar» a quien llega debiendo, y el equipo puede registrar el cobro
  a mano para los pagos en el restaurante.
- Sofía avisa el valor antes de crear la reserva, no después.

Se ajusta desde el entorno, sin tocar código:

| Variable | Default | Qué hace |
| --- | --- | --- |
| `GUAYACAN_PAGO_MONTO` | `30000` | Valor en pesos |
| `GUAYACAN_PAGO_EXIGIR` | `todos` | `todos`, `grandes` (solo desde 8 personas) o `ninguno` (apaga el cobro) |

## La cola de correos

Mandar un correo no puede bloquear la respuesta de una reserva: el huésped no
tiene por qué esperar a que un SMTP conteste, ni perder la mesa porque el
proveedor de correo se cayó. Se encola y se responde.

Cuatro trabajos, con reintentos y backoff exponencial:

| Trabajo | Cuándo |
| --- | --- |
| `confirmacion` | al crear la reserva |
| `pago` | cuando entra el pago |
| `recordatorio` | 24 h antes de la reserva |
| `cancelacion` | al cancelar |

El recordatorio es la razón de fondo para tener una cola de verdad: es un
trabajo **retrasado días**, y un `setTimeout` no sobrevive a un despliegue.

### Dos modos

Con **`REDIS_URL`** corre [BullMQ](https://bullmq.io) de verdad: reintentos,
trabajos retrasados que sobreviven un reinicio y los fallidos guardados para
revisarlos. El worker va **dentro del mismo proceso web** — en Render un
Background Worker aparte es de pago, y para este volumen no hace falta.

Sin `REDIS_URL` cae a una cola en memoria con la misma interfaz, para que la
app arranque sin instalar nada. Esa versión **no sobrevive un reinicio**, que
es justo lo que Redis viene a resolver; el panel lo dice en letra grande.

Para probar con Redis de verdad en local:

```bash
docker run -d -p 6379:6379 redis:7-alpine
```

y `REDIS_URL=redis://127.0.0.1:6379` en el `.env`.

### Por dónde sale el correo

| Modo | Se activa con | ¿Le llega a cualquiera? |
| --- | --- | --- |
| `smtp` | `SMTP_HOST` + `SMTP_USER` + `SMTP_PASS` | **Sí**, sin dominio propio |
| `brevo` | `BREVO_API_KEY` | **Sí**, verificando un solo correo remitente |
| `resend` | `RESEND_API_KEY` | Solo con dominio propio verificado |
| `bandeja` | por defecto | No sale: queda en el panel, pestaña **Correos** |
| `consola` | `MAIL_MODO=consola` | No sale: va a stderr |

Se escogen en ese orden, así que si define varias gana SMTP.

#### Escribirle a cualquiera sin comprar dominio

Verificar un remitente no es un capricho del proveedor: es lo que impide que
cualquiera mande correos haciéndose pasar por otro. Hay dos maneras de
cumplirlo sin dominio:

**Gmail con contraseña de aplicación.** Active la verificación en dos pasos,
genere una contraseña en <https://myaccount.google.com/apppasswords> y ponga:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=sucorreo@gmail.com
SMTP_PASS=la contraseña de aplicación, 16 letras
MAIL_FROM=El Guayacán <sucorreo@gmail.com>
```

Límite de unos 500 correos al día. El remitente tiene que ser esa misma
cuenta: Gmail reescribe cualquier otro.

**Brevo.** Cree la cuenta, verifique un correo remitente (sirve el mismo
Gmail) y use `BREVO_API_KEY`. Son 300 correos diarios gratis y va por HTTPS,
así que no depende de que la plataforma deje salir los puertos SMTP —algunas
los bloquean para frenar el spam.

**Resend** queda para cuando tenga dominio: es el de mejor entregabilidad,
pero exige registros DNS. Un subdominio de Render (`algo.onrender.com`) **no
sirve**: la verificación necesita control del DNS, y esa zona no es suya.

Si el proveedor rechaza un envío, el error 4xx se marca como permanente —no se
reintenta, porque reintentar no lo arregla— y el trabajo aparece en **Correos
→ Trabajos fallidos** con el motivo. No falla en silencio.

El modo bandeja no es un placebo: el correo se renderiza completo, en HTML de
correo (tablas y estilos en línea, que es lo que entiende Outlook) y con su
alternativa en texto plano. Es exactamente lo que le llegaría al huésped.

Agregar otro proveedor es un caso más en `server/mail/transporte.js`.

## La bitácora

Un archivo por día en `logs/AAAAMMDD.log`, una línea por suceso. Sirve para
abrir el archivo del día en que algo salió mal y entender qué pasó sin
adivinar.

```
[2026-09-16 20:49:35.963] INFO   actor=huésped@190.25.1.4  fn=createReservation
  msg=POST /api/reservations  in={"body":{"name":"Altagracia Peña",…}}
  out={"status":201,"reservation":{"ref":"GY-AQ7L","estado":"pendiente-pago"}}  ms=13
```

Cada línea trae **cuándo**, el **nivel** (`INFO`, `WARN`, `ERROR`), **quién**
(`actor`), **en qué función** (`fn`), **con qué entró** (`in`) y **con qué salió**
(`out`). Buscar es `grep`:

```bash
grep "GY-AQ7L" logs/20260916.log     # todo lo que le pasó a una reserva
grep "ERROR" logs/*.log              # lo que se rompió
grep "actor=equipo" logs/20260916.log  # lo que hizo el salón
```

Los actores que aparecen: `huésped@ip`, `equipo@ip` (el panel, con PIN),
`mcp@ip`, `chat/Sofía`, `sistema/cola`, `sistema/correo` y `negocio` (los
sucesos de la agenda: reserva creada, pago recibido, oferta aceptada).

Cuatro cosas que la bitácora respeta:

- **No escribe los datos del huésped.** Entregó su nombre, su teléfono y su
  correo para reservar una mesa, no para quedar en un archivo de texto que
  vive treinta días y que abre cualquiera que entre al servidor. Queda lo
  justo para reconocer y cruzar —`Rosa E. B.`, `***1234`, `r***@correo.com`— y
  el código de la reserva, que es la llave para buscar los datos completos en
  la base, que es donde sí corresponde que estén. Las notas del huésped no se
  copian en absoluto (`«texto libre: 42 car.»`): ahí la gente escribe
  alergias, embarazos, silla de ruedas, y eso es información de salud.
- **No escribe secretos.** Los tokens de las ofertas de lista de espera son
  llaves —quien los lea se queda con la mesa— y el PIN abre la agenda entera.
  Todo campo cuyo nombre suene a `token`, `pin`, `clave`, `password` o `apikey`
  sale tapado como `abcd…«oculto:64»`: se ve que existía y cómo empezaba, pero
  no sirve para nada. El código de la reserva **sí** se escribe: no es secreto
  —va impreso en el correo— y es justo por lo que uno busca.
- **Escribir no puede tumbar una petición.** Si el disco falla, se avisa una
  vez por consola y la app sigue.
- **Se recorta.** Entrada y salida se cortan a 1.200 caracteres y las listas
  se resumen (`«265 elementos»`): una agenda entera en una línea vuelve el
  archivo ilegible justo cuando más se necesita.

Se guardan 30 días y los viejos se borran solos (`GUAYACAN_LOGS_DIAS`).

En Render el disco es efímero y no hay SSH, así que además está la pestaña
**Bitácora** del panel de sala, que lee el mismo archivo con filtro por nivel y
búsqueda. Por debajo es `GET /api/admin/logs?dia=20260916&nivel=ERROR&buscar=GY-A3F9`.

## Desplegar en Render

El repositorio trae [`render.yaml`](render.yaml): en Render, **New → Blueprint**,
apunte al repo y él lee la configuración. No hay build ni dependencias que
instalar.

Dos variables se ponen a mano en el panel de Render (nunca en el repo):

| Variable | Para qué |
| --- | --- |
| `DEEPSEEK_API_KEY` | **enciende el chat.** Sin ella el botón de Sofía no aparece en el sitio publicado: un chat muerto es peor que ninguno. El resto del sitio funciona igual |
| `GUAYACAN_PIN` | PIN del panel de sala. Si no la define, la app genera uno al azar y lo imprime en el log de arranque |
| `GUAYACAN_PAGO_MONTO` | Valor de la reserva. Default 30.000 |
| `GUAYACAN_PAGO_EXIGIR` | `todos`, `grandes` o `ninguno` |
| `REDIS_URL` | Redis para la cola. Sin ella, cola en memoria |
| `RESEND_API_KEY` | Envío real de correos. Sin ella, bandeja |
| `PUBLIC_URL` | La URL pública, para los enlaces de los correos |
| `BREVO_API_KEY` | Envío real de correos por HTTP. Le escribe a cualquiera con solo verificar un remitente |
| `MAIL_FROM` | El remitente, `Nombre <correo@dominio>`. Debe estar verificado en el proveedor |
| `GUAYACAN_ESPERA_LARGA` | Minutos para responder una oferta si falta más de un día. Default 90 |
| `GUAYACAN_ESPERA_CORTA` | Minutos si el servicio es hoy o mañana. Default 30 |
| `GUAYACAN_PAGO_MINUTOS` | Minutos para pagar antes de soltar la mesa. `0` lo apaga. Default 30 |
| `GUAYACAN_LOGS_DIAS` | Días de bitácora que se guardan. Default 30 |

`HOST=0.0.0.0` y `NODE_ENV=production` ya vienen en el blueprint. `HOST` es
obligatorio: atado a `127.0.0.1` el health check de Render nunca pasa.

### Dos límites que hay que saber antes

- **La agenda no sobrevive un reinicio.** La base es un JSON en el disco del
  contenedor, y en Render ese disco es efímero: cada despliegue o reinicio la
  vuelve a sembrar desde cero. Para que persista hace falta un disco persistente
  (plan pago) o mover `server/db.js` a una base de datos de verdad.
- **En el plan gratuito el servicio se duerme** tras un rato sin tráfico, y la
  primera visita después tarda unos segundos en responder.
- **La bitácora también se borra** en cada despliegue, por lo mismo. La
  pestaña Bitácora del panel la lee mientras el proceso viva; para
  conservarla hace falta un disco persistente o un servicio de logs.

## Comandos

| Comando | Qué hace |
| --- | --- |
| `npm start` | Levanta el sitio y la API en el puerto 4321 |
| `npm run dev` | Igual, recargando al guardar |
| `npm run reset` | Borra la base y siembra ~290 reservas de ejemplo |
| `npm run mcp` | Servidor MCP por stdio |
| `npm run mcp:flujo` | Demostración del flujo del MCP |
| `npm run postman` | Regenera la colección de Postman |

Variables: `PORT`, `HOST`, `GUAYACAN_PIN` (PIN del panel), `GUAYACAN_URL` (a
qué API apunta el MCP).

## Notas

- Los datos viven en `data/db.json`, con escritura atómica y cola de
  escrituras: dos reservas simultáneas no se pisan.
- La agenda de ejemplo es determinista y se ancla al día en que se siembra, así
  que el panel siempre tiene un servicio con movimiento.
- Diseño: paleta cálida sobre fondo oscuro, `Fraunces` para titulares e
  `Instrument Sans` para interfaz. Respeta `prefers-reduced-motion` y funciona
  con teclado.
- El chat con IA escribe en la agenda de verdad: crea, mueve y cancela reservas.
  En un demo conviene revisar el panel después de probarlo; `npm run reset` deja
  la agenda limpia.
- Es un proyecto de demostración: sin pasarela de pago, sin envío real de
  correos y con PIN fijo en lugar de cuentas de usuario.
