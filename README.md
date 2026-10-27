<p align="center">
  <img src="src/admin/public/logo.svg" alt="Logo de Agendo" width="88" />
</p>

<h1 align="center">Agendo · Citas por WhatsApp con IA local</h1>

<p align="center">
  Un recepcionista virtual para el WhatsApp de tu negocio: conversa con tus clientes, les ofrece huecos libres de verdad y deja la cita apuntada en Google Calendar y Google Sheets. Gratis, sin límites de mensajes y con la IA funcionando en tu propio ordenador.
</p>

<p align="center">
  <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-0e7c74" />
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-0f1b2d" />
  <img alt="IA local con Ollama" src="https://img.shields.io/badge/IA-Ollama%20local-0e7c74" />
  <img alt="Coste cero" src="https://img.shields.io/badge/coste-0%20%E2%82%AC-0f1b2d" />
  <img alt="Tests" src="https://img.shields.io/badge/tests-Vitest-0e7c74" />
</p>

---

## Qué es y por qué existe

Los negocios pequeños (una peluquería, un estudio de diseño, una clínica de fisioterapia, un taller…) reciben buena parte de sus citas por WhatsApp. Contestar a cada mensaje interrumpe el trabajo, y muchas soluciones automáticas dependen de APIs de pago con cupos de mensajes.

**Agendo** es una alternativa que se instala en un PC con Windows y cuesta **0 €**:

- **Atiende el WhatsApp del negocio** como un dispositivo vinculado más, igual que WhatsApp Web, escaneando un código QR.
- **Entiende lo que pide el cliente** con un modelo de lenguaje que corre en local con [Ollama]. Ninguna conversación sale a servicios de IA de terceros.
- **Consulta la agenda real** (el horario del negocio, sus festivos y los eventos de Google Calendar) y solo ofrece horas que de verdad están libres.
- **Reserva, cambia o cancela la cita** y la apunta en Google Calendar, en una hoja de Google Sheets y en su base de datos local.
- **Pasa la conversación a una persona** cuando el cliente lo pide, se enfada o pregunta algo que no sabe, y avisa al responsable por WhatsApp.
- **Varios negocios a la vez** desde un único programa, cada uno con su número, su configuración, su calendario y su hoja.
- **Panel web propio** para gente que no sabe de informática: agenda visual, listado de citas, conversaciones, el QR de WhatsApp y formularios sencillos para configurar el negocio.

> **Este repositorio solo contiene el programa.** No incluye ninguna cuenta, clave, número de WhatsApp ni dato de nadie. Para usarlo tienes que conectar tus propias cuentas: mira [Lo que necesitas para que funcione](#lo-que-necesitas-para-que-funcione).

## Una conversación real, paso a paso

> Ejemplo ficticio con el negocio de prueba incluido, un estudio de diseño web:

```text
Cliente:   Hola, tengo una panadería y quiero una web
Asistente: Te atiende el asistente virtual (IA) de Mi Estudio Web.
           ¡Genial! Te propongo una reunión inicial gratuita para ver qué necesitas.
           ¿Prefieres videollamada o llamada?
Cliente:   El jueves a las 10 por videollamada
           ⚙ consultar_disponibilidad → ocupado, alternativas reales
Asistente: Ese hueco ya está cogido. Te puedo ofrecer el jueves 29 de octubre
           a las 9:15, a las 11:15 o a las 11:30. ¿Cuál te viene mejor?
Cliente:   A las 11:15
Asistente: Perfecto. ¿A nombre de quién hago la reserva?
Cliente:   Marta Ruiz
           ⚙ crear_cita → comprueba de nuevo el hueco, crea el evento y la fila
Asistente: ¡Listo, Marta! Reunión inicial gratuita el jueves 29 de octubre
           a las 11:15 por videollamada. Te enviaremos el enlace antes.
```

Mientras tanto, en el panel aparece la conversación (con las consultas que ha hecho el asistente), la cita en la agenda y la fila nueva en la hoja.

## Cómo funciona por dentro

```text
 Cliente ──► Servidores de WhatsApp ──► TU PC ─────────────────────────────────────────┐
                                        │  1. Baileys recibe el mensaje (sesión QR)       │
                                        │  2. Filtros: grupos, duplicados, modo pruebas   │
                                        │  3. Prompt con datos del negocio + fecha de hoy │
                                        │  4. Ollama (qwen3:8b) decide qué hacer ─────────┼──► herramientas
                                        │  5. El código calcula huecos y valida todo ◄────┼─── consultar / crear /
                                        │  6. Google Calendar + Sheets + SQLite           │    cancelar / reprogramar
 Cliente ◄── Servidores de WhatsApp ◄───│  7. «Escribiendo…», pausa humana y respuesta    │
                                        └─────────────────────────────────────────────────┘
```

La IA **no toca la agenda directamente**. Pide cosas mediante herramientas (_tool calling_ de Ollama) y el código es quien decide:

| Herramienta                                              | Qué hace el código                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `consultar_disponibilidad`                               | Calcula huecos con el horario, los festivos, la antelación mínima, los días vista, el margen entre citas, el `freebusy` de Google y las citas guardadas. Devuelve libre u ocupado y hasta 5 alternativas: primero las del mismo día más cercanas a la hora pedida y después las de los días siguientes. |
| `crear_cita`                                             | Vuelve a comprobar el hueco **dentro de un bloqueo por negocio**, para que dos clientes no reserven el mismo hueco a la vez. Después crea el evento, la fila y el registro.                                                                                                                             |
| `ver_citas_cliente`, `cancelar_cita`, `reprogramar_cita` | Solo actúan sobre citas del teléfono que escribe. Al cancelar, la fila de la hoja cambia de estado; nunca se borra.                                                                                                                                                                                     |
| `derivar_a_humano`                                       | Pausa el asistente en ese chat y avisa al responsable. Se reactiva desde el panel.                                                                                                                                                                                                                      |
| `listar_servicios`                                       | Devuelve servicios, duraciones, precios y modalidades.                                                                                                                                                                                                                                                  |

### Hecho para que un modelo pequeño no se equivoque

Los modelos que caben en un PC normal se confunden más que los grandes. Por eso las reglas importantes **están en el código, no solo en el prompt**:

- **Calendario de los próximos 14 días en el prompt**, para que «el jueves» sea siempre la fecha correcta.
- **Día de la semana comprobado**: si el cliente dice «viernes» y el modelo consulta un sábado, la herramienta devuelve un error y el modelo lo corrige solo.
- **Nombre obligatorio**: la cita solo se crea con un nombre que el cliente haya escrito en la conversación. El nombre del perfil de WhatsApp no vale.
- **Validador de respuestas**: si el modelo menciona una hora que no ha salido de una herramienta, o da una cita por confirmada sin haberla creado, la respuesta se rechaza y se le pide que lo haga bien.
- **Sin citas duplicadas**: si el cliente ya tiene una cita de ese servicio, el modelo tiene que reprogramarla en vez de crear otra.
- **Sin dobles reservas**: hay un bloqueo por negocio y una segunda comprobación justo antes de reservar.
- **Cambio de hora en España** gestionado con zonas horarias IANA (Luxon) y cubierto por tests.

### WhatsApp sin sorpresas

- Ignora grupos, estados, difusiones, canales y el historial que se sincroniza al conectar.
- **Modo pruebas**: solo contesta a los números permitidos. Con tu propio número puedes probarlo en el chat «Mensajes para ti».
- **Sin bucles**: guarda los IDs de los mensajes que envía para no responderse a sí mismo.
- **Orden y duplicados**: procesa los mensajes de cada cliente de uno en uno y descarta los repetidos.
- Muestra «escribiendo…», espera unos segundos antes de contestar y se reconecta solo. Si la sesión caduca, avisa para volver a escanear el QR.

## El panel

En `http://localhost:3000`, protegido con usuario y contraseña. Solo se puede abrir desde el propio PC.

| Sección              | Para qué sirve                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Resumen**          | Estado de WhatsApp, de la IA y de Google, citas de hoy y próximas, clientes que esperan a una persona y tareas para dejarlo todo listo.                                  |
| **Agenda**           | Semana, mes o lista con las citas del asistente y lo que ya está ocupado en Google Calendar. Al pulsar una cita se ven sus detalles y se puede cancelar.                 |
| **Listado de citas** | La hoja de Google en forma de tabla, con buscador y filtro por estado.                                                                                                   |
| **Conversaciones**   | Los chats con burbujas al estilo WhatsApp y lo que ha consultado el asistente en cada paso. Incluye el botón para reactivarlo tras atender tú al cliente.                |
| **Mi negocio**       | Formularios para los datos generales, los servicios, dónde atiendes, el horario, los días cerrados, las reglas de reserva, lo que sabe el asistente, el equipo y Google. |
| **WhatsApp**         | El QR para vincular el número y la elección entre modo pruebas y en vivo.                                                                                                |
| **Actividad**        | Lo último que ha pasado, contado en lenguaje normal.                                                                                                                     |

## Legal y privacidad

- **Ley de IA de la UE (art. 50)**: el primer mensaje de cada conversación dice siempre que atiende un asistente virtual. Si el modelo no lo hace, el código lo añade.
- **RGPD**: todos los datos se quedan en tu PC y en tu cuenta de Google. Para borrar todo lo de un cliente:
  ```bash
  npm run gdpr:delete -- --tenant <negocio> --phone <telefono>
  ```
  Este comando borra conversaciones y citas de la base de datos y deja anónimos su nombre y teléfono en Calendar y Sheets.
- Los secretos solo están en `.env` y `credentials/`, y los teléfonos aparecen enmascarados en los registros. Ninguno de esos archivos se sube al repositorio.

> ⚠️ **Aviso importante.** WhatsApp no ofrece una forma oficial y gratuita de automatizar una cuenta; [Baileys] imita WhatsApp Web y WhatsApp podría bloquear el número. Para reducir el riesgo:
>
> - usa un número dedicado al negocio y con historial;
> - deja que el bot solo responda, sin escribir primero ni hacer envíos masivos;
> - mantén Baileys actualizado.

## Tecnología

| Parte      | Elección                                                                              |
| ---------- | ------------------------------------------------------------------------------------- |
| Lenguaje   | Node.js 22+ con TypeScript en modo `strict`, sin compilación previa (`tsx`)           |
| WhatsApp   | [Baileys] 7 (multi-dispositivo, direcciones LID)                                      |
| IA         | [Ollama] en local detrás de una interfaz `LLMProvider`; modelo por defecto `qwen3:8b` |
| Agenda     | Google Calendar API y Google Sheets API con una cuenta de servicio gratuita           |
| Datos      | SQLite con `better-sqlite3` y Drizzle ORM, con migraciones                            |
| Panel      | Hono, HTML y CSS propios, JavaScript sin framework y FullCalendar                     |
| Validación | Zod para `.env`, la configuración de cada negocio y los argumentos de la IA           |
| Calidad    | Vitest, ESLint y Prettier                                                             |

```text
src/
  config/       carga y validación del .env
  db/           esquema, migraciones y repositorios (SQLite + Drizzle)
  tenants/      esquema de configuración de cada negocio
  whatsapp/     sesiones Baileys, normalización de mensajes y flujo de entrada
  ai/           proveedor Ollama, prompt, agente, validador y herramientas
  scheduling/   cálculo de huecos y formato de fechas en español
  booking/      crear, cancelar y reprogramar con bloqueo por negocio
  google/       clientes de Calendar y Sheets
  admin/        servidor del panel y la web (public/)
scripts/        seed, alta de negocios, borrado RGPD y prueba de la IA
tests/          simulaciones de WhatsApp, Google y Ollama
examples/       negocio de ejemplo listo para usar
```

---

# Lo que necesitas para que funcione

Al descargar el repositorio tienes el programa completo, pero **ninguna de las piezas personales** que lo conectan con el mundo. Cada persona que lo use debe poner las suyas:

| Pieza                                                | ¿Viene en el repositorio?        | Qué tienes que hacer                                                                                                                                                           |
| ---------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Código, panel, tests y negocio de ejemplo            | ✅ Sí                            | Nada.                                                                                                                                                                          |
| Dependencias (`node_modules/`)                       | ❌ No                            | `npm install` ([paso 4](#4-instalar-y-arrancar)).                                                                                                                              |
| IA (Ollama y el modelo)                              | ❌ No                            | Instalar Ollama y descargar el modelo en tu equipo ([paso 1](#1-instalar-nodejs-ollama-y-el-modelo)).                                                                          |
| Archivo `.env` con tu usuario y contraseña del panel | ❌ No                            | Copiar `.env.example` a `.env` y poner tu propia contraseña ([paso 4](#4-instalar-y-arrancar)).                                                                                |
| Clave de Google (`credentials/google-key.json`)      | ❌ No                            | Crear **tu propio** proyecto de Google Cloud y **tu propia** cuenta de servicio, y descargar su clave ([paso 2](#2-crear-la-cuenta-de-servicio-de-google-gratis-sin-tarjeta)). |
| Calendario y hoja de Google                          | ❌ No                            | Usar los tuyos y compartirlos con tu cuenta de servicio ([paso 3](#3-lo-que-hace-cada-negocio-en-google)).                                                                     |
| Número de WhatsApp                                   | ❌ No                            | Vincular el WhatsApp de **tu** negocio escaneando el QR del panel ([paso 4](#4-instalar-y-arrancar)).                                                                          |
| Datos de tu negocio                                  | ❌ No (solo un ejemplo ficticio) | Rellenar servicios, horario, dirección… en **Mi negocio** ([paso 6](#6-checklist-para-dar-de-alta-un-negocio-nuevo)).                                                          |
| Base de datos y sesiones (`data/`, `sessions/`)      | ❌ No                            | Se crean solas la primera vez que arrancas.                                                                                                                                    |

### Requisitos del equipo

- **Sistema**: Windows 10 u 11. También funciona en macOS y Linux con los comandos equivalentes. No necesita Docker ni WSL.
- **Node.js**: 22 o superior.
- **Para la IA**: 16 GB de RAM y, a ser posible, una tarjeta gráfica NVIDIA con 8 GB de VRAM. Hay modelos más pequeños para equipos modestos ([tabla](#qué-modelo-elijo)).
- **Espacio en disco**: unos 6 GB libres para el modelo.
- **Encendido**: el equipo tiene que estar encendido y con internet mientras quieras que el asistente conteste.
- **Cuentas**: una cuenta de Google (gratuita) y un móvil con WhatsApp para el negocio.

### Lista rápida antes del primer arranque

- [ ] `npm install` terminado sin errores.
- [ ] Ollama abierto y el modelo descargado (`ollama list` lo muestra).
- [ ] `.env` creado a partir de `.env.example`, con tu contraseña.
- [ ] `credentials/google-key.json` con la clave de **tu** cuenta de servicio.
- [ ] Tu calendario y tu hoja compartidos con el correo de esa cuenta de servicio.
- [ ] `npm run seed` (crea el negocio de ejemplo) o un negocio nuevo creado desde el panel.

Con eso, `npm run dev` arranca el asistente y el panel. La consola avisa de lo que falte (Ollama apagado, modelo sin descargar o Google sin configurar), con el comando para arreglarlo. Sin la clave de Google también funciona: las citas se guardan solo en local.

> 🔒 **Nunca subas a GitHub ni compartas** tu `.env`, tu carpeta `credentials/`, `data/` ni `sessions/`. El `.gitignore` del proyecto ya los excluye. Si alguna vez se filtra tu clave de Google, bórrala en Google Cloud (**Cuentas de servicio → tu cuenta → Claves**) y crea otra: la antigua deja de funcionar al momento.

---

# Instalación paso a paso (Windows)

## 1. Instalar Node.js, Ollama y el modelo

1. **Node.js 22 o superior** (recomendado: la versión LTS): <https://nodejs.org>. Compruébalo con:
   ```bash
   node -v
   ```
2. **Ollama**: <https://ollama.com/download> (o `winget install Ollama.Ollama`). Al instalarlo queda en marcha en segundo plano. Verás el icono de la llama junto al reloj.
3. **Descarga el modelo**:
   ```bash
   ollama pull qwen3:8b
   ```

### ¿Qué modelo elijo?

| Modelo                       | Descarga | Necesita                                    | Cuándo usarlo                                                                                                  |
| ---------------------------- | -------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `qwen3:4b`                   | ~2,6 GB  | GPU de 4 GB o 8 GB de RAM                   | Equipos modestos. Comete más errores.                                                                          |
| **`qwen3:8b`** (por defecto) | ~5,2 GB  | **GPU de 8 GB** (o 16 GB de RAM, más lento) | **Recomendado.** En las pruebas reales fue el único de su tamaño que reservó, reprogramó y canceló sin fallos. |
| `qwen2.5:7b`                 | ~4,7 GB  | GPU de 6-8 GB                               | Funciona, pero a menudo no llama a las herramientas; el bot acaba pidiendo los datos otra vez.                 |
| `llama3.1:8b`                | ~4,9 GB  | GPU de 8 GB                                 | Peor en español.                                                                                               |
| `qwen3:14b`                  | ~9,3 GB  | GPU de 12 GB o más                          | Más fiable si tu equipo lo permite.                                                                            |

- Con GPU NVIDIA el modelo responde en 1-3 segundos.
- Solo con CPU puede tardar 10-30 segundos por mensaje.
- El modelo se cambia en `.env` (`OLLAMA_MODEL`).

## 2. Crear la cuenta de servicio de Google (gratis, sin tarjeta)

1. Entra en <https://console.cloud.google.com> y crea un proyecto nuevo.
   - En **Ubicación** elige **Sin organización**.
   - Las organizaciones nuevas bloquean por defecto la creación de claves.
2. En **APIs y servicios → Biblioteca**, activa **Google Calendar API** y **Google Sheets API**.
3. En **IAM y administración → Cuentas de servicio → Crear cuenta de servicio**, ponle un nombre y pulsa «Crear y cerrar». No necesita roles.
4. Abre la cuenta de servicio y ve a **Claves → Agregar clave → Crear clave nueva → JSON**. Se descarga un archivo.
5. Crea la carpeta `credentials` dentro del proyecto y guarda el archivo como `credentials/google-key.json`.
   - Está en `.gitignore`.
   - No lo compartas.
6. Copia el **email** de la cuenta de servicio (algo como `bot-citas@tu-proyecto.iam.gserviceaccount.com`). También aparece en el panel, en **Mi negocio → Google**.

Calendar API y Sheets API no tienen coste. Solo tienen límites de velocidad, que un negocio no llega a rozar.

## 3. Lo que hace cada negocio en Google

**Calendario**

1. En Google Calendar (web), crea un calendario para las citas o usa el tuyo.
2. En su **Configuración**, entra en **Compartir con determinadas personas** y añade el email de la cuenta de servicio con el permiso **«Hacer cambios y ver todos los detalles del evento»**.
3. En **Integrar el calendario**, copia el **ID del calendario**:
   - para el calendario principal es tu propio correo;
   - para los demás, es algo como `xxxx@group.calendar.google.com`.

**Hoja**

1. Crea una hoja de cálculo nueva y pulsa **Compartir**.
2. Añade el email de la cuenta de servicio como **Editor**.
3. No hace falta preparar nada más:
   - el bot crea la pestaña (por defecto `Citas`) si no existe;
   - escribe la cabecera si la pestaña está vacía.

Pega el ID del calendario y el enlace de la hoja en el panel: **Mi negocio → Google**.

## 4. Instalar y arrancar

```bash
npm install
```

```bash
copy .env.example .env
```

- Edita `.env`:
  - pon un `ADMIN_PASSWORD` propio;
  - en `ALLOWED_TEST_NUMBERS`, pon tu número en formato internacional sin `+` (por ejemplo, `34600111222`).
- Crea el negocio de ejemplo «Mi Estudio Web», en modo pruebas:
  ```bash
  npm run seed
  ```
- Arranca el bot:
  ```bash
  npm run dev
  ```

Después:

1. Abre <http://localhost:3000> y entra con `ADMIN_USER` / `ADMIN_PASSWORD`.
2. Ve a **WhatsApp**. Verás un QR.
3. En el móvil: **WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo**. Escanea el QR.
4. El estado pasará a **«Conectado»**.

Al arrancar, la consola indica si Ollama no responde o falta el modelo, con el comando exacto para arreglarlo.

## 5. Probar con un solo móvil («Mensajes para ti»)

1. Pon **tu propio número** (el que acabas de vincular) en los números de prueba: en **WhatsApp** dentro del panel, o en `ALLOWED_TEST_NUMBERS` del `.env`.
2. En WhatsApp, abre el chat contigo mismo («Tú» / «Mensajes para ti») y escribe, por ejemplo: «Hola, quiero una web para mi panadería».
3. El bot te responde en ese mismo chat, sin entrar en bucle. Mientras el negocio esté en modo pruebas, ignora a cualquier otro número.
4. Mira en el panel la conversación, la cita en la **Agenda** y la fila en el **Listado de citas**.

Para probar la IA **sin WhatsApp ni Google** (con un calendario simulado):

```bash
npm run probar:ia -- "Hola" "Quiero una reunión el jueves a las 10 por videollamada" "A nombre de Ana López" "Sí"
```

Cuando todo vaya bien, cambia a **En vivo** en la sección **WhatsApp** del panel.

## 6. Checklist para dar de alta un negocio nuevo

- [ ] En el panel: **Mi negocio → + Nuevo negocio**, con el nombre y a qué se dedica.
  - Alternativa por línea de comandos:
    ```bash
    npm run tenant:create -- --file negocio.json
    ```
    Usa `examples/negocio.ejemplo.json` como plantilla.
- [ ] En **Mi negocio**, rellena:
  - los servicios;
  - dónde atiendes (si es en persona, con la dirección);
  - el horario;
  - los días cerrados;
  - las reglas de reserva;
  - lo que el asistente puede contar.
- [ ] El negocio comparte su **calendario** y su **hoja** con el correo del asistente, que aparece en **Mi negocio → Google**.
- [ ] Pega el ID del calendario y el enlace de la hoja en **Mi negocio → Google**.
- [ ] Pon **tu WhatsApp para avisos** en **Mi negocio → Datos generales**.
- [ ] En **WhatsApp**, escanea el QR con el móvil **del negocio**.
- [ ] Prueba en **Modo pruebas** con un número permitido y, cuando todo vaya bien, pásalo a **En vivo**.
- [ ] Marca como hechas las tareas de «Para dejarlo todo listo» en el Resumen.

## 7. Ponerlo en producción

- **Número**: usa uno **dedicado al negocio**. En vivo, el asistente contesta a todos los chats de ese número.
- **Equipo**: debe estar **siempre encendido**, con `npm start` arrancando con Windows. El móvil del negocio tiene que conectarse a internet al menos cada ~14 días para que WhatsApp no desvincule la sesión.
- **Datos reales**: revisa los servicios, el horario, los festivos y la dirección.
- **Privacidad**: añade un enlace a tu política de privacidad en el mensaje de bienvenida.
- **Copias de seguridad**: guarda de vez en cuando `data/`, `sessions/` y `credentials/`, en un sitio privado.

## 8. Solución de problemas

| Problema                                          | Solución                                                                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **«Hay que volver a vincularlo»**                 | La sesión se cerró desde el móvil o caducó. El panel muestra un QR nuevo: escanéalo otra vez.                                                        |
| **El QR no aparece**                              | Comprueba que el negocio está **activo** en Mi negocio y que hay conexión a internet. Cada QR se renueva solo cada pocos segundos.                   |
| **«Asistente IA: parado»**                        | Ollama está apagado. Ábrelo desde el menú Inicio o ejecuta `ollama serve`.                                                                           |
| **Falta el modelo**                               | `ollama pull qwen3:8b` (o el que tengas en `OLLAMA_MODEL`).                                                                                          |
| **Respuestas lentas**                             | Comprueba con `ollama ps` que usa la GPU (`100% GPU`) o usa un modelo más pequeño. El primer mensaje tras arrancar tarda más porque carga el modelo. |
| **«Google Calendar no deja leer…»**               | El calendario no está compartido con la cuenta de servicio, o el ID está mal.                                                                        |
| **La hoja no se actualiza**                       | Comparte la hoja como **Editor** con la cuenta de servicio. Los errores aparecen en **Actividad**.                                                   |
| **El bot no contesta a un número**                | En modo pruebas solo responde a los números permitidos. En una conversación pasada a una persona, reactívalo en **Conversaciones**.                  |
| **«Key creation is not allowed» en Google Cloud** | El proyecto está dentro de una organización. Crea otro con **Sin organización**.                                                                     |
| **Puerto 3000 ocupado**                           | Cambia `PORT` en `.env`.                                                                                                                             |

## Comandos

| Comando                                                   | Para qué                                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                                             | Arranca el bot y el panel con recarga automática.                                                                 |
| `npm start`                                               | Arranca sin recarga automática (producción).                                                                      |
| `npm run seed`                                            | Crea el negocio de ejemplo.                                                                                       |
| `npm run tenant:create -- --file negocio.json`            | Da de alta o actualiza un negocio desde un JSON.                                                                  |
| `npm run gdpr:delete -- --tenant <id> --phone <telefono>` | Borra los datos de un cliente (RGPD).                                                                             |
| `npm run probar:ia -- "mensaje 1" "mensaje 2"`            | Conversa con la IA usando un calendario simulado.                                                                 |
| `npm test`                                                | Tests: cálculo de huecos, cambio de hora, modo pruebas, bucles, duplicados, reservas simultáneas, flujo completo… |
| `npm run lint`                                            | ESLint y Prettier.                                                                                                |
| `npm run build`                                           | Comprobación de tipos de TypeScript.                                                                              |

[Ollama]: https://ollama.com
[Baileys]: https://github.com/WhiskeySockets/Baileys
