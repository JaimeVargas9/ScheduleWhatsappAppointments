const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
const state = {
  tenant: null,
  overview: null,
  timers: [],
  calendar: null,
  chat: null,
  route: 0,
  saved: null,
  draft: null,
  dirty: false,
  skipNextRoute: false,
};

const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}" /></svg>`;
const clone = (o) => JSON.parse(JSON.stringify(o));

async function api(path, opts = {}) {
  const res = await fetch(new URL(path, location.origin), {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('Tu sesión ha caducado');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Algo ha fallado. Inténtalo de nuevo.');
  return data;
}

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = 'toast'), 3500);
}

function remember(id) {
  try {
    localStorage.setItem('tenant', id);
  } catch {
    /* sin almacenamiento local */
  }
}

function remembered() {
  try {
    return localStorage.getItem('tenant');
  } catch {
    return null;
  }
}

const current = () => state.overview?.tenants.find((t) => t.id === state.tenant);
const tz = () => current()?.zona_horaria || 'Europe/Madrid';
const fmt = (iso, opts) =>
  new Intl.DateTimeFormat('es-ES', { timeZone: tz(), ...opts }).format(new Date(iso));
const hhmm = (iso) => fmt(iso, { hour: '2-digit', minute: '2-digit' });
const dayLong = (iso) => fmt(iso, { weekday: 'long', day: 'numeric', month: 'long' });
const dayShort = (iso) => fmt(iso, { weekday: 'short', day: 'numeric', month: 'short' });
const when = (iso) => fmt(iso, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const phone = (p) => (/^\d+$/.test(p) ? `+${p}` : p);
const initials = (name, p) =>
  (name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || String(p).slice(-2);
const slug = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'negocio';
const uid = (prefix) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const WA = {
  conectado: ['ok', 'Conectado'],
  esperando_qr: ['warn', 'Pendiente de vincular'],
  conectando: ['warn', 'Conectando…'],
  desconectado: ['bad', 'Desconectado'],
  sesion_cerrada: ['bad', 'Hay que volver a vincularlo'],
};

/* ---------------- Navegación ---------------- */

function every(ms, fn) {
  const token = state.route;
  state.timers.push(
    setInterval(() => {
      if (token !== state.route || document.hidden) return;
      Promise.resolve(fn()).catch(() => undefined);
    }, ms),
  );
}

function clearTimers() {
  state.timers.forEach(clearInterval);
  state.timers = [];
}

async function loadOverview() {
  state.overview = await api('/api/overview');
  const ids = state.overview.tenants.map((t) => t.id);
  if (!ids.includes(state.tenant)) state.tenant = ids.includes(remembered()) ? remembered() : ids[0] || null;
  $('#tenant').innerHTML = state.overview.tenants
    .map(
      (t) =>
        `<option value="${esc(t.id)}" ${t.id === state.tenant ? 'selected' : ''}>${esc(t.nombre)}</option>`,
    )
    .join('');
  renderShell();
}

function renderShell() {
  const o = state.overview;
  const t = current();
  const [waCls, waTxt] = WA[t?.whatsapp.status || 'desconectado'];
  const googleOk = o.google.configured && t?.google.calendar && t?.google.sheet;
  $('#business-dot').className = `dot ${t ? waCls : ''}`;
  $('#health').innerHTML = `
    <div><span class="dot ${waCls}"></span>WhatsApp: ${esc(waTxt.toLowerCase())}</div>
    <div><span class="dot ${o.ollama.ok ? 'ok' : 'bad'}"></span>Asistente IA: ${o.ollama.ok ? 'funcionando' : 'parado'}</div>
    <div><span class="dot ${googleOk ? 'ok' : 'warn'}"></span>Google: ${googleOk ? 'conectado' : 'sin completar'}</div>`;
  const badge = $('#handoff-badge');
  badge.hidden = !t?.stats.derivadas;
  badge.textContent = t?.stats.derivadas || '';
}

$('#tenant').addEventListener('change', (e) => {
  if (
    state.dirty &&
    !confirm('Tienes cambios sin guardar en «Mi negocio». ¿Cambiar de negocio sin guardarlos?')
  ) {
    e.target.value = state.tenant;
    return;
  }
  state.dirty = false;
  state.tenant = e.target.value;
  remember(state.tenant);
  route();
});

const ROUTES = {
  inicio: home,
  agenda: agenda,
  citas: sheet,
  conversaciones: chats,
  negocio: business,
  whatsapp: whatsapp,
  actividad: activity,
};

async function route() {
  if (state.skipNextRoute) {
    state.skipNextRoute = false;
    return;
  }
  const name = (location.hash.replace('#/', '') || 'inicio').split('?')[0];
  if (state.dirty && name !== 'negocio') {
    if (!confirm('Tienes cambios sin guardar en «Mi negocio». ¿Salir sin guardarlos?')) {
      state.skipNextRoute = true;
      location.hash = '#/negocio';
      return;
    }
    state.dirty = false;
  }
  const token = ++state.route;
  const alive = () => token === state.route;
  clearTimers();
  closeDrawer();
  state.calendar?.destroy();
  state.calendar = null;
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  try {
    await loadOverview();
    if (!alive()) return;
    if (!state.tenant && name !== 'negocio') {
      setView(`
        <div class="page-head"><div><h1>Bienvenido a Agendo</h1><p class="sub">Todavía no hay ningún negocio.</p></div></div>
        <div class="card card-pad"><div class="empty">${icon('store')}<b>Crea tu primer negocio para empezar</b>
        <button class="btn" data-new-business>${icon('plus')}Crear negocio</button></div></div>`);
      return;
    }
    await (ROUTES[name] || home)(alive);
  } catch (e) {
    if (alive()) setView(`<div class="notice bad">${icon('x')}<div>${esc(e.message)}</div></div>`);
  }
}

function setView(html) {
  view.innerHTML = `<div class="fade">${html}</div>`;
}

window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', (e) => {
  if (state.dirty) e.preventDefault();
});
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-new-business]')) openNewBusiness();
});

/* ---------------- Resumen ---------------- */

function greeting() {
  const h = Number(
    new Intl.DateTimeFormat('es-ES', { timeZone: tz(), hour: 'numeric', hourCycle: 'h23' }).format(
      new Date(),
    ),
  );
  return h < 13 ? 'Buenos días' : h < 21 ? 'Buenas tardes' : 'Buenas noches';
}

async function home(alive) {
  const t = current();
  const o = state.overview;
  const [waCls, waTxt] = WA[t.whatsapp.status];
  const googleOk = o.google.configured && t.google.calendar && t.google.sheet;
  const today = new Intl.DateTimeFormat('es-ES', { timeZone: t.zona_horaria, dateStyle: 'full' })
    .format(new Date())
    .replace(/^./, (c) => c.toUpperCase());

  setView(`
    <div class="page-head">
      <div><p class="greeting">${esc(today)}</p><h1>${greeting()}, ${esc(t.nombre)}</h1></div>
      <a class="btn btn-secondary" href="#/agenda">${icon('calendar')}Ver agenda</a>
    </div>

    ${
      !t.activo
        ? `<div class="mode-card"><div><b>Negocio desactivado.</b> El asistente no atiende WhatsApp.</div><a class="btn btn-secondary btn-sm" href="#/negocio">Activar</a></div>`
        : t.modo === 'test'
          ? `<div class="mode-card"><div><b>Modo pruebas.</b> El asistente solo contesta a tus números de prueba, no a los clientes.</div><a class="btn btn-secondary btn-sm" href="#/whatsapp">Cambiar</a></div>`
          : `<div class="mode-card live"><div><b>En vivo.</b> El asistente atiende a todos los clientes que escriben.</div><a class="btn btn-secondary btn-sm" href="#/whatsapp">Ajustes</a></div>`
    }

    <div class="grid status-row">
      <a class="card status" href="#/whatsapp">
        <span class="status-icon ${waCls}">${icon('phone')}</span>
        <div><h3>WhatsApp</h3><p>${esc(waTxt)}${t.whatsapp.phone ? ` · ${esc(phone(t.whatsapp.phone))}` : ''}</p></div>
      </a>
      <div class="card status">
        <span class="status-icon ${o.ollama.ok ? 'ok' : 'bad'}">${icon('sparkle')}</span>
        <div><h3>Asistente IA</h3><p>${o.ollama.ok ? 'Funcionando en este ordenador' : esc(o.ollama.message)}</p></div>
      </div>
      <a class="card status" href="#/negocio" data-section="google">
        <span class="status-icon ${googleOk ? 'ok' : 'warn'}">${icon('google')}</span>
        <div><h3>Google Calendar y Sheets</h3><p>${
          !o.google.configured
            ? 'Falta conectar la cuenta de Google'
            : googleOk
              ? 'Las citas se guardan en tu calendario y tu hoja'
              : `Falta ${!t.google.calendar ? 'el calendario' : 'la hoja'}`
        }</p></div>
      </a>
    </div>

    <div class="grid kpis">
      <div class="card kpi"><span>Citas hoy</span><b>${t.stats.citasHoy}</b></div>
      <div class="card kpi"><span>Próximos 7 días</span><b>${t.stats.citasSemana}</b></div>
      <a class="card kpi" href="#/conversaciones"><span>Conversaciones</span><b>${t.stats.conversaciones}</b></a>
      <a class="card kpi ${t.stats.derivadas ? 'alert' : ''}" href="#/conversaciones"><span>Esperan a una persona</span><b>${t.stats.derivadas}</b></a>
    </div>

    <div class="grid cols-2">
      <section class="card">
        <div class="card-head"><h2>Hoy</h2><span class="badge">${t.hoy.length} ${t.hoy.length === 1 ? 'cita' : 'citas'}</span></div>
        <div class="card-body">${
          t.hoy.length
            ? `<ul class="timeline">${t.hoy.map((a) => timelineItem(a)).join('')}</ul>`
            : `<div class="empty">${icon('calendar')}Hoy no tienes citas.</div>`
        }</div>
        <div class="card-head" style="border-top:1px solid var(--line)"><h2>Próximas citas</h2></div>
        <div class="card-body">${
          t.proximas.length
            ? `<ul class="timeline">${t.proximas.map((a) => timelineItem(a, true)).join('')}</ul>`
            : `<div class="empty">${icon('clock')}No hay citas en los próximos 7 días.</div>`
        }</div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Para dejarlo todo listo</h2></div>
        <div class="card-body">${
          t.pendientes.length
            ? `<ul class="tasks">${t.pendientes
                .map(
                  (p, i) =>
                    `<li><button class="check-btn" data-done="${i}" title="Marcar como hecho" aria-label="Marcar como hecho">${icon('check')}</button><span>${esc(p)}</span></li>`,
                )
                .join('')}</ul>`
            : `<div class="empty">${icon('check')}<b>Todo listo</b>No tienes tareas pendientes.</div>`
        }</div>
      </section>
    </div>`);

  view.querySelectorAll('[data-done]').forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        try {
          const cfg = await api(`/api/tenants/${state.tenant}`);
          cfg.pendientes.splice(Number(b.dataset.done), 1);
          await api(`/api/tenants/${state.tenant}`, { method: 'PUT', body: JSON.stringify(cfg) });
          toast('Tarea completada');
          route();
        } catch (e) {
          toast(e.message, true);
          b.disabled = false;
        }
      }),
  );
  const google = view.querySelector('[data-section="google"]');
  if (google) google.onclick = () => (state.openSection = 'google');

  every(10000, async () => {
    await loadOverview();
    if (alive()) renderShell();
  });
}

function timelineItem(a, withDay = false) {
  const status =
    a.status === 'reprogramada'
      ? '<span class="badge warn">Cambiada</span>'
      : '<span class="badge ok">Confirmada</span>';
  return `<li>
    <time>${hhmm(a.start)}${withDay ? `<small>${esc(dayShort(a.start))}</small>` : ''}</time>
    <div class="who"><b>${esc(a.clientName)}</b><span>${esc(a.serviceName)} · ${esc(a.locationName)}</span></div>
    ${status}
  </li>`;
}

/* ---------------- Agenda ---------------- */

async function agenda(alive) {
  setView(`
    <div class="page-head"><div><h1>Agenda</h1><p class="sub">Las citas que ha reservado el asistente y lo que ya tienes ocupado en Google Calendar.</p></div></div>
    <div id="cal-warning"></div>
    <div class="card cal-card"><div id="cal"></div>
      <div class="legend">
        <span><i style="background:var(--brand)"></i>Confirmada</span>
        <span><i style="background:#b26b00"></i>Cambiada de hora</span>
        <span><i style="border:1px dashed var(--line-strong)"></i>Cancelada</span>
        <span><i style="background:repeating-linear-gradient(-45deg,var(--surface-2) 0 3px,var(--line) 3px 6px)"></i>Ocupado en tu calendario</span>
      </div>
    </div>`);
  if (!window.FullCalendar) {
    $('#cal').innerHTML = `<div class="empty">No se pudo cargar el calendario.</div>`;
    return;
  }
  const cal = new FullCalendar.Calendar($('#cal'), {
    locale: 'es',
    // ponytail: shows the browser's zone (the owner's PC); a tenant in another zone would need @fullcalendar/luxon
    timeZone: 'local',
    initialView: window.innerWidth < 700 ? 'listWeek' : 'timeGridWeek',
    firstDay: 1,
    nowIndicator: true,
    slotMinTime: '08:00:00',
    slotMaxTime: '21:00:00',
    height: 'auto',
    expandRows: true,
    headerToolbar: { left: 'prev,next today', center: 'title', right: 'timeGridWeek,dayGridMonth,listWeek' },
    buttonText: { today: 'Hoy', week: 'Semana', month: 'Mes', list: 'Lista' },
    noEventsContent: 'No hay citas en estas fechas',
    events: async (info, ok, fail) => {
      try {
        const r = await api(
          `/api/tenants/${state.tenant}/events?start=${encodeURIComponent(info.startStr)}&end=${encodeURIComponent(info.endStr)}`,
        );
        const box = $('#cal-warning');
        if (alive() && box)
          box.innerHTML = r.warning
            ? `<div class="notice warn">${icon('google')}<div>${esc(r.warning)}</div></div>`
            : '';
        ok(r.events);
      } catch (e) {
        fail(e);
      }
    },
    eventClick: ({ event }) => {
      if (event.extendedProps.kind === 'cita') openAppointment(event.extendedProps);
    },
  });
  state.calendar = cal;
  cal.render();
  every(30000, () => state.calendar === cal && cal.refetchEvents());
}

function openAppointment(a) {
  const statusBadge = { confirmada: 'ok', reprogramada: 'warn', cancelada: 'bad' }[a.status];
  const statusText = { confirmada: 'Confirmada', reprogramada: 'Cambiada de hora', cancelada: 'Cancelada' }[
    a.status
  ];
  openDrawer(`
    <div class="drawer-head">
      <div><span class="badge ${statusBadge}">${statusText}</span><h1 style="margin-top:10px">${esc(a.clientName)}</h1><p class="sub">${esc(a.serviceName)}</p></div>
      <button class="icon-btn" data-close aria-label="Cerrar">${icon('x')}</button>
    </div>
    <dl class="details">
      <dt>Día</dt><dd style="text-transform:capitalize">${esc(dayLong(a.start))}</dd>
      <dt>Hora</dt><dd>${hhmm(a.start)} – ${hhmm(a.end)}</dd>
      <dt>Dónde</dt><dd>${esc(a.locationName)}${a.address ? `<br><span class="muted">${esc(a.address)}</span>` : ''}</dd>
      ${a.professionalName ? `<dt>Profesional</dt><dd>${esc(a.professionalName)}</dd>` : ''}
      <dt>Teléfono</dt><dd><a href="https://wa.me/${esc(a.phone)}" target="_blank" rel="noopener">${esc(phone(a.phone))}</a></dd>
      ${a.notes ? `<dt>Notas</dt><dd>${esc(a.notes)}</dd>` : ''}
      <dt>Reservada</dt><dd>${esc(when(a.createdAt))}</dd>
      <dt>Código</dt><dd class="mono">${esc(a.id)}</dd>
    </dl>
    ${
      a.status !== 'cancelada'
        ? `<button class="btn btn-danger btn-block" data-cancel>${icon('x')}Cancelar esta cita</button>
           <p class="sub" style="font-size:13px">Se marcará como cancelada en tu calendario y en la hoja. Avisa tú al cliente.</p>`
        : ''
    }`);
  const btn = $('#drawer [data-cancel]');
  if (btn)
    btn.onclick = async () => {
      if (!confirm(`¿Cancelar la cita de ${a.clientName}?`)) return;
      btn.disabled = true;
      try {
        await api(`/api/tenants/${state.tenant}/appointments/${a.id}/cancel`, { method: 'POST' });
        toast('Cita cancelada');
        closeDrawer();
        state.calendar?.refetchEvents();
      } catch (e) {
        toast(e.message, true);
        btn.disabled = false;
      }
    };
}

function openDrawer(html) {
  $('#drawer').innerHTML = html;
  $('#drawer').hidden = false;
  $('#drawer-backdrop').hidden = false;
  $('#drawer [data-close]')?.addEventListener('click', closeDrawer);
}

function closeDrawer() {
  $('#drawer').hidden = true;
  $('#drawer').innerHTML = '';
  $('#drawer-backdrop').hidden = true;
}

$('#drawer-backdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer());

/* ---------------- Listado de citas ---------------- */

async function sheet(alive) {
  setView(`<div class="page-head"><div><h1>Listado de citas</h1><p class="sub">Todas las citas, tal como están en tu hoja de Google.</p></div><div id="sheet-actions"></div></div>
    <div id="sheet-body"><div class="card card-pad"><div class="empty">Cargando…</div></div></div>`);
  const r = await api(`/api/tenants/${state.tenant}/sheet`);
  if (!alive()) return;
  const [header = [], ...rows] = r.rows;
  const col = (name) => header.indexOf(name);
  const estadoCol = col('Estado');
  const shownCols = ['Cliente', 'Teléfono', 'Servicio', 'Ubicación', 'Inicio', 'Estado', 'Notas', 'ID cita']
    .map(col)
    .filter((i) => i >= 0);
  $('#sheet-actions').innerHTML = r.url
    ? `<a class="btn btn-secondary" href="${esc(r.url)}" target="_blank" rel="noopener">${icon('external')}Abrir en Google Sheets</a>`
    : '';
  const estados = [...new Set(rows.map((x) => x[estadoCol]).filter(Boolean))];
  $('#sheet-body').innerHTML = `
    ${r.warning ? `<div class="notice warn">${icon('google')}<div>${esc(r.warning)}</div></div>` : ''}
    <div class="toolbar">
      <input type="search" id="q" placeholder="Buscar por nombre, teléfono o servicio" aria-label="Buscar" />
      <select id="estado" aria-label="Estado"><option value="">Todos los estados</option>${estados.map((e) => `<option>${esc(e)}</option>`).join('')}</select>
      <span class="muted" id="count"></span>
    </div>
    <div class="card table-wrap"><table class="table">
      <thead><tr>${shownCols.map((i) => `<th>${esc(header[i] === 'ID cita' ? 'Código' : header[i])}</th>`).join('')}</tr></thead>
      <tbody id="rows"></tbody>
    </table></div>`;
  const badge = (v) => {
    const cls = v === 'Cancelada' ? 'bad' : v === 'Reprogramada' ? 'warn' : 'ok';
    return `<span class="badge ${cls}">${esc(v === 'Reprogramada' ? 'Cambiada' : v)}</span>`;
  };
  const draw = () => {
    const q = $('#q').value.toLowerCase();
    const st = $('#estado').value;
    const shown = rows.filter(
      (row) => (!st || row[estadoCol] === st) && (!q || row.join(' ').toLowerCase().includes(q)),
    );
    $('#rows').innerHTML =
      shown
        .slice()
        .reverse()
        .map(
          (row) =>
            `<tr>${shownCols
              .map((i) => {
                const v = row[i] ?? '';
                if (i === estadoCol) return `<td>${badge(v)}</td>`;
                if (header[i] === 'Cliente') return `<td class="strong">${esc(v)}</td>`;
                if (header[i] === 'Notas') return `<td class="wrap muted">${esc(v)}</td>`;
                if (header[i] === 'ID cita') return `<td class="mono muted">${esc(v)}</td>`;
                return `<td>${esc(v)}</td>`;
              })
              .join('')}</tr>`,
        )
        .join('') ||
      `<tr><td colspan="${shownCols.length}"><div class="empty">${icon('table')}${rows.length ? 'Ninguna cita coincide con la búsqueda.' : 'Todavía no hay citas.'}</div></td></tr>`;
    $('#count').textContent = `${shown.length} de ${rows.length}`;
  };
  $('#q').oninput = draw;
  $('#estado').onchange = draw;
  draw();
}

/* ---------------- Conversaciones ---------------- */

const TOOL_LABEL = {
  listar_servicios: 'Revisó los servicios',
  consultar_disponibilidad: 'Consultó la agenda',
  crear_cita: 'Reservó la cita',
  ver_citas_cliente: 'Revisó las citas del cliente',
  cancelar_cita: 'Canceló la cita',
  reprogramar_cita: 'Cambió la cita de hora',
  derivar_a_humano: 'Pasó la conversación a una persona',
};

function toolSummary(name, content) {
  let r;
  try {
    r = JSON.parse(content);
  } catch {
    return '';
  }
  if (r.error) return `tuvo que corregir un dato: ${r.error}`;
  if (name === 'consultar_disponibilidad') {
    if (r.libre === true) return `libre: ${r.texto}`;
    if (r.libre === false) return `ocupado, ofreció ${r.alternativas?.length || 0} alternativas`;
    if (r.huecos)
      return r.huecos.length ? `encontró ${r.total_libres} huecos libres` : 'no había huecos en esas fechas';
  }
  if (name === 'crear_cita')
    return r.creada ? `${r.cita.cuando} · código ${r.cita.id}` : 'el hueco ya no estaba libre';
  if (name === 'reprogramar_cita') return r.reprogramada ? r.cita.cuando : 'el nuevo hueco no estaba libre';
  if (name === 'ver_citas_cliente') return `${r.citas?.length || 0} citas`;
  return '';
}

async function chats(alive) {
  setView(`<div class="page-head"><div><h1>Conversaciones</h1><p class="sub">Lo que han hablado tus clientes con el asistente.</p></div></div>
    <div class="card chats"><div class="chat-list" id="chat-list"></div><div class="chat-pane" id="chat-pane">
      <div class="empty" style="margin:auto">${icon('chat')}Elige una conversación para verla</div></div></div>`);
  const drawList = async () => {
    const list = await api(`/api/tenants/${state.tenant}/conversations`);
    const box = $('#chat-list');
    if (!alive() || !box) return;
    box.innerHTML =
      list
        .map(
          (c) => `<button class="chat-item ${state.chat === c.id ? 'active' : ''}" data-id="${c.id}">
            <span class="avatar">${esc(initials(c.clientName, c.phone))}</span>
            <span class="meta"><b><span>${esc(c.clientName || phone(c.phone))}</span>${c.handoff ? '<span class="badge bad">Te espera</span>' : ''}</b>
            <small>${esc(c.lastMessage || '')}</small></span></button>`,
        )
        .join('') || `<div class="empty">${icon('chat')}Todavía no ha escrito nadie.</div>`;
    box
      .querySelectorAll('.chat-item')
      .forEach((b) => (b.onclick = () => openChat(Number(b.dataset.id), alive, drawList)));
  };
  await drawList();
  if (state.chat && alive()) await openChat(state.chat, alive, drawList, true);
  every(5000, async () => {
    await drawList();
    if (state.chat) await openChat(state.chat, alive, drawList, true);
  });
}

async function openChat(id, alive, refreshList, keepScroll = false) {
  state.chat = id;
  document
    .querySelectorAll('.chat-item')
    .forEach((b) => b.classList.toggle('active', Number(b.dataset.id) === id));
  const { conversation: c, messages } = await api(`/api/conversations/${id}/messages`);
  const pane = $('#chat-pane');
  if (!alive() || !pane) return;
  const body = $('.chat-body', pane);
  const atBottom = !body || body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  let lastDay = '';
  const items = messages
    .map((m) => {
      const day = dayLong(m.createdAt);
      const sep = day !== lastDay ? `<div class="day-sep">${esc(day)}</div>` : '';
      lastDay = day;
      return sep + bubble(m);
    })
    .join('');
  pane.innerHTML = `
    <div class="chat-head">
      <div class="who"><span class="avatar">${esc(initials(c.clientName, c.phone))}</span>
        <div><b>${esc(c.clientName || phone(c.phone))}</b><br><small class="muted">${esc(phone(c.phone))}</small></div></div>
      ${
        c.handoff
          ? `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span class="badge bad" title="${esc(c.handoffReason)}">El asistente está en pausa</span>
             <button class="btn btn-sm" data-reactivate>Volver a activar el asistente</button></div>`
          : '<span class="badge ok">Atiende el asistente</span>'
      }
    </div>
    ${c.handoff && c.handoffReason ? `<div class="notice warn" style="margin:12px 20px 0">${icon('user')}<div><b>Motivo:</b> ${esc(c.handoffReason)}. Contesta tú desde el móvil y, cuando termines, vuelve a activar el asistente.</div></div>` : ''}
    <div class="chat-body">${items}</div>`;
  const newBody = $('.chat-body', pane);
  if (!keepScroll || atBottom) newBody.scrollTop = newBody.scrollHeight;
  const btn = pane.querySelector('[data-reactivate]');
  if (btn)
    btn.onclick = async () => {
      await api(`/api/conversations/${id}/reactivate`, { method: 'POST' });
      toast('El asistente vuelve a atender esta conversación');
      await refreshList();
      await openChat(id, alive, refreshList);
    };
}

function bubble(m) {
  if (m.role === 'assistant' && m.toolCalls?.length) return '';
  if (m.role === 'tool') {
    let pretty = m.content;
    try {
      pretty = JSON.stringify(JSON.parse(m.content), null, 2);
    } catch {
      /* texto plano */
    }
    const summary = toolSummary(m.toolName, m.content);
    return `<details class="step"><summary>${icon('sparkle')}${esc(TOOL_LABEL[m.toolName] || m.toolName)}${summary ? `: ${esc(summary)}` : ''}</summary><pre>${esc(pretty)}</pre></details>`;
  }
  const html = esc(m.content)
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
    .replace(/_([^_\n]+)_/g, '<i>$1</i>');
  return `<div class="bubble ${m.role}">${html}<time>${hhmm(m.createdAt)}</time></div>`;
}

/* ---------------- WhatsApp ---------------- */

async function whatsapp(alive) {
  const cfg = await api(`/api/tenants/${state.tenant}`);
  if (!alive()) return;
  setView(`
    <div class="page-head"><div><h1>WhatsApp</h1><p class="sub">Conecta el WhatsApp del negocio y decide a quién contesta el asistente.</p></div></div>
    <div class="grid wa-grid">
      <section class="card card-pad" id="wa-card"><div class="empty">Cargando…</div></section>
      <section class="card">
        <div class="card-head"><div><h2>¿A quién contesta el asistente?</h2></div></div>
        <form class="card-body" id="mode-form" style="display:grid;gap:18px">
          <div class="segmented">
            <label><input type="radio" name="modo" value="test" ${cfg.modo === 'test' ? 'checked' : ''} /><b>Modo pruebas</b><span>Solo contesta a los números de abajo. Úsalo mientras lo pruebas.</span></label>
            <label><input type="radio" name="modo" value="live" ${cfg.modo === 'live' ? 'checked' : ''} /><b>En vivo</b><span>Contesta a todos los clientes que escriban.</span></label>
          </div>
          <label class="field"><span>Números de prueba</span>
            <textarea name="numeros" rows="3" placeholder="34600111222">${esc(cfg.numeros_prueba.join('\n'))}</textarea>
            <small>Uno por línea, con el prefijo del país y sin el +. Si pones el número que has vinculado, podrás probarlo escribiéndote a ti mismo en «Mensajes para ti».</small>
          </label>
          <div><button class="btn" type="submit">${icon('check')}Guardar</button></div>
        </form>
      </section>
    </div>`);

  $('#mode-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    if (
      f.get('modo') === 'live' &&
      cfg.modo !== 'live' &&
      !confirm(
        'En vivo, el asistente contestará a todas las personas que escriban a este WhatsApp. ¿Activarlo?',
      )
    )
      return;
    try {
      const fresh = await api(`/api/tenants/${state.tenant}`);
      fresh.modo = f.get('modo');
      fresh.numeros_prueba = String(f.get('numeros'))
        .split(/[\s,;]+/)
        .filter(Boolean);
      Object.assign(
        cfg,
        await api(`/api/tenants/${state.tenant}`, { method: 'PUT', body: JSON.stringify(fresh) }),
      );
      toast(cfg.modo === 'live' ? 'Asistente en vivo' : 'Modo pruebas guardado');
      await loadOverview();
    } catch (err) {
      toast(friendlyError(err.message), true);
    }
  };

  const draw = async () => {
    const s = await api(`/api/tenants/${state.tenant}/whatsapp`);
    const box = $('#wa-card');
    if (!alive() || !box) return;
    const [cls, txt] = WA[s.status];
    if (!current()?.activo) {
      box.innerHTML = `<h2>Conexión</h2>
        <div class="qr state">${icon('store')}Este negocio está desactivado</div>
        <p class="sub" style="text-align:center">Actívalo en «Mi negocio» para poder conectar su WhatsApp.</p>
        <a class="btn btn-block" href="#/negocio" style="margin-top:14px">Ir a Mi negocio</a>`;
      return;
    }
    const qr =
      s.status === 'conectado'
        ? `<div class="qr state ok">${icon('check')}WhatsApp vinculado<br><span class="mono">${esc(phone(s.phone || ''))}</span></div>`
        : s.qr
          ? `<div class="qr"><img src="${s.qr}" alt="Código QR para vincular WhatsApp" /></div>`
          : `<div class="qr state">${icon('clock')}Preparando el código…</div>`;
    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px"><h2>Conexión</h2><span class="badge ${cls}"><span class="dot ${cls}"></span>${esc(txt)}</span></div>
      ${s.needsRescan ? `<div class="notice bad" style="margin-top:14px">${icon('phone')}<div>La conexión se cerró desde el móvil o caducó. Escanea el código otra vez.</div></div>` : ''}
      ${qr}
      ${
        s.status === 'conectado'
          ? `<p class="sub" style="text-align:center">El asistente ya puede atender este WhatsApp. Puedes seguir usando el móvil con normalidad.</p>
             <button class="btn btn-secondary btn-block" id="relink" style="margin-top:14px">Desvincular y conectar otro número</button>`
          : `<ol class="steps">
              <li><span>Abre WhatsApp en el móvil del negocio.</span></li>
              <li><span>Pulsa en Ajustes (o los tres puntos) y entra en <b>Dispositivos vinculados</b>.</span></li>
              <li><span>Pulsa <b>Vincular un dispositivo</b> y apunta la cámara a este código.</span></li>
            </ol>
            <p class="sub" style="font-size:13px;margin-top:14px">El código cambia solo cada pocos segundos. Si caduca, espera a que salga uno nuevo.</p>`
      }`;
    const relink = $('#relink');
    if (relink)
      relink.onclick = async () => {
        if (
          !confirm(
            '¿Desvincular este WhatsApp? El asistente dejará de contestar hasta que vuelvas a escanear el código.',
          )
        )
          return;
        await api(`/api/tenants/${state.tenant}/whatsapp/relink`, { method: 'POST' });
        toast('Desvinculado. Escanea el nuevo código.');
        draw();
      };
  };
  await draw();
  every(3000, draw);
}

/* ---------------- Mi negocio ---------------- */

const DIAS = [
  ['lunes', 'Lunes'],
  ['martes', 'Martes'],
  ['miercoles', 'Miércoles'],
  ['jueves', 'Jueves'],
  ['viernes', 'Viernes'],
  ['sabado', 'Sábado'],
  ['domingo', 'Domingo'],
];
const TIPOS = [
  ['presencial', 'En persona'],
  ['videollamada', 'Videollamada'],
  ['telefono', 'Llamada telefónica'],
];
const SECTIONS = [
  ['general', 'Datos generales'],
  ['servicios', 'Servicios'],
  ['ubicaciones', 'Dónde atiendes'],
  ['horario', 'Horario'],
  ['cierres', 'Días cerrados'],
  ['reglas', 'Reglas de reserva'],
  ['asistente', 'Qué sabe el asistente'],
  ['profesionales', 'Equipo'],
  ['google', 'Google'],
];
const TONOS = [
  'profesional y cercano; tutea salvo que el cliente trate de usted',
  'formal y educado; trata siempre de usted',
  'alegre y desenfadado, con algún emoji',
];
const FIELD_LABEL = {
  nombre: 'Nombre del negocio',
  descripcion: 'A qué se dedica',
  tono: 'Forma de hablar',
  servicios: 'Servicios',
  ubicaciones: 'Dónde atiendes',
  profesionales: 'Equipo',
  horario: 'Horario',
  festivos: 'Días cerrados',
  cierres: 'Vacaciones',
  reglas: 'Reglas de reserva',
  google: 'Google',
  responsable: 'Tu WhatsApp para avisos',
  numeros_prueba: 'Números de prueba',
};

function friendlyError(msg) {
  return msg
    .replace(/^Configuración de negocio inválida:\s*/i, '')
    .split('\n')
    .map((l) => l.replace(/^\s*-\s*/, ''))
    .filter(Boolean)
    .map((l) => {
      const [path, ...rest] = l.split(': ');
      const parts = path.split('.');
      const label = FIELD_LABEL[parts[0]];
      if (!label) return l;
      const n = /^\d+$/.test(parts[1] || '') ? ` ${Number(parts[1]) + 1}` : '';
      return `${label}${n}: ${rest.join(': ')}`;
    })
    .join(' · ');
}

const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}

function markDirty() {
  if (!state.dirty) {
    state.dirty = true;
    renderSavebar();
  }
}

function renderSavebar() {
  $('.savebar')?.remove();
  if (!state.dirty) return;
  view.insertAdjacentHTML(
    'beforeend',
    `<div class="savebar"><span>Tienes cambios sin guardar</span>
      <button class="btn btn-secondary btn-sm" data-discard>Descartar</button>
      <button class="btn btn-sm" data-save>${icon('check')}Guardar cambios</button></div>`,
  );
}

const input = (path, value, attrs = '') => `<input data-path="${path}" value="${esc(value)}" ${attrs} />`;
const textarea = (path, value, attrs = '') =>
  `<textarea data-path="${path}" ${attrs}>${esc(value)}</textarea>`;
const toggle = (path, checked, label) =>
  `<label class="toggle"><input type="checkbox" data-path="${path}" data-type="bool" ${checked ? 'checked' : ''} />${label}</label>`;
const removeBtn = (action, index, label) =>
  `<button type="button" class="icon-btn" data-action="${action}" data-index="${index}" aria-label="${label}" title="${label}">${icon('trash')}</button>`;

const SECTION_RENDER = {
  general(d) {
    return `<div class="form-grid">
      <label class="field"><span>Nombre del negocio</span>${input('nombre', d.nombre, 'required')}</label>
      <label class="field"><span>Tu WhatsApp para avisos</span>${input('responsable.telefono', d.responsable.telefono, 'inputmode="numeric" placeholder="34600111222"')}
        <small>Te avisamos aquí cuando un cliente necesite hablar con una persona.</small></label>
      <label class="field full"><span>¿A qué se dedica tu negocio?</span>${textarea('descripcion', d.descripcion, 'rows="2"')}
        <small>Una frase. Por ejemplo: «peluquería de barrio especializada en color y cortes de caballero».</small></label>
      <label class="field full"><span>Mensaje de bienvenida</span>${textarea('bienvenida', d.bienvenida, 'rows="3"')}
        <small>Por ley, el cliente debe saber que habla con un asistente virtual. Si el mensaje no lo dice, el asistente lo añadirá solo.</small></label>
      <div class="field full"><span>Forma de hablar</span>${textarea('tono', d.tono, 'rows="2"')}
        <div class="chips">${TONOS.map((t, i) => `<button type="button" class="chip" data-action="tone" data-index="${i}">${esc(t.split(';')[0])}</button>`).join('')}</div></div>
      <div class="full">${toggle('activo', d.activo, 'Negocio activo (si lo desactivas, el asistente deja de atender su WhatsApp)')}</div>
    </div>`;
  },

  servicios(d) {
    const durations = [15, 20, 30, 45, 60, 75, 90, 120, 150, 180, 240];
    return (
      d.servicios
        .map(
          (s, i) => `<div class="item">
        <div class="item-head"><h3>${esc(s.nombre || 'Servicio nuevo')}</h3>
          <div style="display:flex;gap:10px;align-items:center">${toggle(`servicios.${i}.activo`, s.activo, 'Disponible')}${removeBtn('remove-service', i, 'Eliminar servicio')}</div></div>
        <div class="form-grid">
          <label class="field"><span>Nombre</span>${input(`servicios.${i}.nombre`, s.nombre)}</label>
          <div class="form-grid" style="gap:12px">
            <label class="field"><span>Duración</span><select data-path="servicios.${i}.duracion_min" data-type="number">
              ${[...new Set([...durations, s.duracion_min])]
                .sort((a, b) => a - b)
                .map(
                  (m) =>
                    `<option value="${m}" ${m === s.duracion_min ? 'selected' : ''}>${m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`}</option>`,
                )
                .join('')}
            </select></label>
            <label class="field"><span>Precio</span>${input(`servicios.${i}.precio`, s.precio || '', 'placeholder="Opcional"')}</label>
          </div>
          <label class="field full"><span>Descripción</span>${input(`servicios.${i}.descripcion`, s.descripcion, 'placeholder="Qué incluye, para quién es…"')}</label>
          <label class="field full"><span>Condición</span>${input(`servicios.${i}.restriccion`, s.restriccion || '', 'placeholder="Opcional. Por ejemplo: solo para clientes que ya han venido antes"')}</label>
          <div class="field full"><span>Se puede hacer…</span><div class="chips">
            ${d.ubicaciones.map((u) => `<label class="chip"><input type="checkbox" data-member="servicios.${i}.ubicaciones" value="${esc(u.id)}" ${s.ubicaciones.includes(u.id) ? 'checked' : ''} />${esc(u.nombre)}${u.activa ? '' : ' (desactivada)'}</label>`).join('')}
          </div></div>
        </div></div>`,
        )
        .join('') +
      `<div class="add-row"><button type="button" class="btn btn-secondary" data-action="add-service">${icon('plus')}Añadir servicio</button></div>`
    );
  },

  ubicaciones(d) {
    return (
      d.ubicaciones
        .map(
          (u, i) => `<div class="item">
        <div class="item-head"><h3>${esc(u.nombre || 'Nueva forma de atender')}</h3>
          <div style="display:flex;gap:10px;align-items:center">${toggle(`ubicaciones.${i}.activa`, u.activa, 'Disponible')}${removeBtn('remove-location', i, 'Eliminar')}</div></div>
        <div class="form-grid">
          <label class="field"><span>Nombre que verá el cliente</span>${input(`ubicaciones.${i}.nombre`, u.nombre)}</label>
          <label class="field"><span>Tipo</span><select data-path="ubicaciones.${i}.tipo" data-rerender>
            ${TIPOS.map(([v, l]) => `<option value="${v}" ${u.tipo === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          ${u.tipo === 'presencial' ? `<label class="field full"><span>Dirección</span>${input(`ubicaciones.${i}.direccion`, u.direccion, 'placeholder="Calle, número, ciudad"')}<small>Obligatoria para poder activarla.</small></label>` : ''}
          <label class="field full"><span>Indicaciones para el cliente</span>${input(`ubicaciones.${i}.detalles`, u.detalles, 'placeholder="Opcional. Por ejemplo: te enviamos el enlace antes de la reunión"')}</label>
        </div></div>`,
        )
        .join('') +
      `<div class="add-row"><button type="button" class="btn btn-secondary" data-action="add-location">${icon('plus')}Añadir forma de atender</button></div>`
    );
  },

  horario(d) {
    return `<div class="week">${DIAS.map(([key, label]) => {
      const tramos = d.horario[key] || [];
      return `<div class="day"><div>${toggle(`horario-open.${key}`, tramos.length > 0, label)}</div>
        <div class="slots">${
          tramos.length
            ? tramos
                .map(
                  (
                    t,
                    j,
                  ) => `<span class="slot"><input type="time" data-path="horario.${key}.${j}.0" value="${esc(t[0])}" aria-label="${label}, desde" /> –
                <input type="time" data-path="horario.${key}.${j}.1" value="${esc(t[1])}" aria-label="${label}, hasta" />
                <button type="button" class="icon-btn" data-action="remove-slot" data-day="${key}" data-index="${j}" aria-label="Quitar tramo">${icon('x')}</button></span>`,
                )
                .join('') +
              `<button type="button" class="btn btn-quiet btn-sm" data-action="add-slot" data-day="${key}">${icon('plus')}Añadir tramo</button>`
            : '<span class="closed">Cerrado</span>'
        }</div></div>`;
    }).join('')}</div>
    <div class="add-row"><button type="button" class="btn btn-secondary btn-sm" data-action="copy-monday">Copiar el horario del lunes al resto de días laborables</button></div>`;
  },

  cierres(d) {
    return `<h3 style="margin-bottom:10px">Días sueltos</h3>
      <div class="rows">${
        d.festivos
          .map(
            (f, i) => `<div class="row-line">
          <input class="input" type="date" data-path="festivos.${i}.fecha" value="${esc(f.fecha)}" aria-label="Fecha" />
          <input class="input field-text" data-path="festivos.${i}.motivo" value="${esc(f.motivo)}" placeholder="Motivo (por ejemplo, Navidad)" aria-label="Motivo" />
          ${removeBtn('remove-holiday', i, 'Quitar día')}</div>`,
          )
          .join('') || '<p class="muted" style="margin:0">No has añadido ningún día.</p>'
      }</div>
      <div class="add-row"><button type="button" class="btn btn-secondary btn-sm" data-action="add-holiday">${icon('plus')}Añadir día cerrado</button></div>
      <h3 style="margin:24px 0 10px">Vacaciones y periodos cerrados</h3>
      <div class="rows">${
        d.cierres
          .map(
            (c, i) => `<div class="row-line range">
          <input class="input" type="date" data-path="cierres.${i}.desde" value="${esc(c.desde)}" aria-label="Desde" />
          <input class="input" type="date" data-path="cierres.${i}.hasta" value="${esc(c.hasta)}" aria-label="Hasta" />
          <input class="input field-text" data-path="cierres.${i}.motivo" value="${esc(c.motivo)}" placeholder="Motivo" aria-label="Motivo" />
          ${removeBtn('remove-closure', i, 'Quitar periodo')}</div>`,
          )
          .join('') || '<p class="muted" style="margin:0">No has añadido ningún periodo.</p>'
      }</div>
      <div class="add-row"><button type="button" class="btn btn-secondary btn-sm" data-action="add-closure">${icon('plus')}Añadir vacaciones</button></div>`;
  },

  reglas(d) {
    const r = d.reglas;
    return `<div class="form-grid">
      <label class="field"><span>Antelación mínima</span>
        <select data-path="reglas.antelacion_minima_min" data-type="number">
          ${[0, 30, 60, 120, 180, 240, 720, 1440, 2880].map((m) => `<option value="${m}" ${m === r.antelacion_minima_min ? 'selected' : ''}>${m === 0 ? 'Sin antelación' : m < 60 ? `${m} minutos` : m < 1440 ? `${m / 60} ${m === 60 ? 'hora' : 'horas'}` : `${m / 1440} ${m === 1440 ? 'día' : 'días'}`}</option>`).join('')}
          ${[0, 30, 60, 120, 180, 240, 720, 1440, 2880].includes(r.antelacion_minima_min) ? '' : `<option value="${r.antelacion_minima_min}" selected>${r.antelacion_minima_min} minutos</option>`}
        </select><small>Lo mínimo que tiene que faltar para la cita.</small></label>
      <label class="field"><span>Hasta cuántos días vista</span>${input('reglas.max_dias_vista', r.max_dias_vista, 'type="number" min="1" max="365" data-type="number"')}
        <small>Cuánto puede reservar por adelantado un cliente.</small></label>
      <label class="field"><span>Descanso entre citas</span>
        <select data-path="reglas.margen_entre_citas_min" data-type="number">
          ${[...new Set([0, 5, 10, 15, 20, 30, 45, 60, r.margen_entre_citas_min])]
            .sort((a, b) => a - b)
            .map(
              (m) =>
                `<option value="${m}" ${m === r.margen_entre_citas_min ? 'selected' : ''}>${m === 0 ? 'Sin descanso' : `${m} minutos`}</option>`,
            )
            .join('')}
        </select><small>Tiempo libre que se deja entre una cita y la siguiente.</small></label>
    </div>`;
  },

  asistente(d) {
    return `<div class="form-grid">
      <label class="field full"><span>Cosas que el asistente puede contar a los clientes</span>
        <textarea data-path="info_extra" data-type="lines" rows="6" placeholder="Una por línea. Por ejemplo: Aparcamiento gratuito en la puerta.">${esc(d.info_extra.join('\n'))}</textarea>
        <small>Preguntas frecuentes, qué incluye cada servicio, cómo llegar… Una idea por línea. Lo que no esté aquí, el asistente dirá que no lo sabe.</small></label>
      <label class="field full"><span>Política de cancelación</span>${textarea('politica_cancelacion', d.politica_cancelacion, 'rows="2" placeholder="Por ejemplo: avisa con 24 horas para cancelar sin coste."')}</label>
    </div>`;
  },

  profesionales(d) {
    return (
      `<p class="muted" style="margin:0 0 14px">Solo si trabajáis varias personas con agendas separadas. Si atiendes tú solo, déjalo vacío.</p>` +
      d.profesionales
        .map(
          (p, i) => `<div class="item">
        <div class="item-head"><h3>${esc(p.nombre || 'Persona nueva')}</h3>${removeBtn('remove-pro', i, 'Quitar persona')}</div>
        <div class="form-grid">
          <label class="field"><span>Nombre</span>${input(`profesionales.${i}.nombre`, p.nombre)}</label>
          <label class="field"><span>Calendario propio (opcional)</span>${input(`profesionales.${i}.calendar_id`, p.calendar_id || '', 'placeholder="ID del calendario de Google"')}</label>
          <div class="field full"><span>Qué servicios hace</span><div class="chips">
            ${d.servicios.map((s) => `<label class="chip"><input type="checkbox" data-member="profesionales.${i}.servicios" value="${esc(s.id)}" ${p.servicios.includes(s.id) ? 'checked' : ''} />${esc(s.nombre)}</label>`).join('')}
          </div></div>
        </div></div>`,
        )
        .join('') +
      `<div class="add-row"><button type="button" class="btn btn-secondary" data-action="add-pro">${icon('plus')}Añadir persona</button></div>`
    );
  },

  google(d) {
    const email = state.overview.google.email;
    return `<div class="form-grid">
      <div class="field full"><span>Correo del asistente</span>${
        email
          ? `<div class="copy-line"><code>${esc(email)}</code><button type="button" class="btn btn-secondary btn-sm" data-action="copy-email">${icon('copy')}Copiar</button></div>
             <small>Comparte tu calendario (permiso «Hacer cambios en eventos») y tu hoja (permiso «Editor») con este correo.</small>`
          : `<div class="notice warn" style="margin:0">${icon('google')}<div>Falta conectar la cuenta de Google del asistente. Sigue el paso 2 de la guía (README).</div></div>`
      }</div>
      <label class="field full"><span>Calendario de Google</span>${input('google.calendar_id', d.google.calendar_id, 'placeholder="xxxx@group.calendar.google.com"')}
        <small>En Google Calendar: Configuración del calendario → Integrar el calendario → «ID del calendario».</small></label>
      <label class="field"><span>Hoja de Google</span>${input('google.spreadsheet_id', d.google.spreadsheet_id, 'placeholder="Pega aquí el enlace de la hoja"')}
        <small>Puedes pegar el enlace completo.</small></label>
      <label class="field"><span>Pestaña</span>${input('google.pestana', d.google.pestana)}<small>Si no existe, se crea sola.</small></label>
    </div>`;
  },
};

const SECTION_HELP = {
  general: 'Cómo se presenta el asistente y a quién avisar.',
  servicios: 'Lo que tus clientes pueden reservar.',
  ubicaciones: 'En persona, por teléfono, por videollamada…',
  horario: 'Las horas en las que se pueden dar citas.',
  cierres: 'Festivos, vacaciones o días que no abres.',
  reglas: 'Con cuánta antelación y hasta cuándo se reserva.',
  asistente: 'Información que puede usar para responder dudas.',
  profesionales: 'Opcional, para negocios con varias personas.',
  google: 'Dónde se guardan las citas.',
};

function renderSection(name) {
  const box = $(`#sec-${name} .card-body`);
  if (box) box.innerHTML = SECTION_RENDER[name](state.draft);
}

async function business(alive) {
  if (!state.tenant) {
    setView(`<div class="page-head"><div><h1>Mi negocio</h1></div></div>
      <div class="card card-pad"><div class="empty">${icon('store')}<button class="btn" data-new-business>${icon('plus')}Crear negocio</button></div></div>`);
    return;
  }
  if (!state.dirty || state.draft?.id !== state.tenant) {
    state.saved = await api(`/api/tenants/${state.tenant}`);
    if (!alive()) return;
    state.draft = clone(state.saved);
    state.dirty = false;
  }
  setView(`
    <div class="page-head"><div><h1>Mi negocio</h1><p class="sub">Lo que el asistente sabe de tu negocio y cómo se reservan las citas.</p></div>
      <button class="btn btn-secondary" data-new-business>${icon('plus')}Nuevo negocio</button></div>
    <div id="save-errors"></div>
    <div class="settings">
      <nav class="subnav" aria-label="Apartados">${SECTIONS.map(([id, label], i) => `<a href="#/negocio" data-jump="${id}" class="${i === 0 ? 'active' : ''}">${label}</a>`).join('')}</nav>
      <div class="grid" id="settings">${SECTIONS.map(
        ([id, label]) => `<section class="card section" id="sec-${id}">
          <div class="card-head"><div><h2>${label}</h2><p>${SECTION_HELP[id]}</p></div></div>
          <div class="card-body"></div></section>`,
      ).join('')}</div>
    </div>`);
  SECTIONS.forEach(([id]) => renderSection(id));
  renderSavebar();

  view.querySelectorAll('[data-jump]').forEach(
    (a) =>
      (a.onclick = (e) => {
        e.preventDefault();
        jumpTo(a.dataset.jump);
      }),
  );
  if (state.openSection) {
    jumpTo(state.openSection);
    state.openSection = null;
  }

  const root = $('#settings');
  const onInput = (e) => {
    const el = e.target;
    if (el.dataset.member) {
      const list = getPath(state.draft, el.dataset.member);
      const idx = list.indexOf(el.value);
      if (el.checked && idx < 0) list.push(el.value);
      if (!el.checked && idx >= 0) list.splice(idx, 1);
      markDirty();
      return;
    }
    const path = el.dataset.path;
    if (!path) return;
    if (path.startsWith('horario-open.')) {
      const day = path.split('.')[1];
      state.draft.horario[day] = el.checked ? [['09:00', '14:00']] : [];
      markDirty();
      renderSection('horario');
      return;
    }
    const type = el.dataset.type;
    const value =
      type === 'bool'
        ? el.checked
        : type === 'number'
          ? Number(el.value)
          : type === 'lines'
            ? el.value
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean)
            : el.value;
    setPath(state.draft, path, value);
    markDirty();
    if (el.dataset.rerender !== undefined) renderSection(path.split('.')[0]);
    if (path.endsWith('.nombre') && e.type === 'change') {
      const sec = path.split('.')[0];
      if (sec === 'ubicaciones') renderSection('servicios');
      if (sec === 'servicios') renderSection('profesionales');
      const h = el.closest('.item')?.querySelector('h3');
      if (h) h.textContent = el.value;
    }
  };
  root.addEventListener(
    'input',
    (e) => e.target.matches('input:not([type=checkbox]),textarea') && onInput(e),
  );
  root.addEventListener('change', onInput);
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn) runAction(btn);
  });
}

function jumpTo(id) {
  $(`#sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  view.querySelectorAll('[data-jump]').forEach((a) => a.classList.toggle('active', a.dataset.jump === id));
}

function runAction(btn) {
  const d = state.draft;
  const i = Number(btn.dataset.index);
  const day = btn.dataset.day;
  const actions = {
    tone: () => {
      d.tono = TONOS[i];
      return 'general';
    },
    'add-service': () => {
      d.servicios.push({
        id: uid('servicio'),
        nombre: 'Servicio nuevo',
        duracion_min: 30,
        descripcion: '',
        ubicaciones: d.ubicaciones.filter((u) => u.activa).map((u) => u.id),
        activo: true,
      });
      return 'servicios';
    },
    'remove-service': () => {
      if (d.servicios.length === 1) return toast('Tiene que haber al menos un servicio', true);
      if (!confirm(`¿Eliminar «${d.servicios[i].nombre}»?`)) return;
      const [gone] = d.servicios.splice(i, 1);
      d.profesionales.forEach((p) => (p.servicios = p.servicios.filter((s) => s !== gone.id)));
      return ['servicios', 'profesionales'];
    },
    'add-location': () => {
      d.ubicaciones.push({
        id: uid('lugar'),
        nombre: 'Llamada telefónica',
        tipo: 'telefono',
        direccion: '',
        detalles: '',
        activa: true,
      });
      return ['ubicaciones', 'servicios'];
    },
    'remove-location': () => {
      if (d.ubicaciones.length === 1) return toast('Tiene que haber al menos una forma de atender', true);
      if (!confirm(`¿Eliminar «${d.ubicaciones[i].nombre}»?`)) return;
      const [gone] = d.ubicaciones.splice(i, 1);
      d.servicios.forEach((s) => (s.ubicaciones = s.ubicaciones.filter((u) => u !== gone.id)));
      return ['ubicaciones', 'servicios'];
    },
    'add-slot': () => {
      const list = d.horario[day];
      const last = list[list.length - 1];
      list.push(last && last[1] < '16:00' ? ['16:00', '19:00'] : ['09:00', '14:00']);
      return 'horario';
    },
    'remove-slot': () => {
      d.horario[day].splice(i, 1);
      return 'horario';
    },
    'copy-monday': () => {
      ['martes', 'miercoles', 'jueves', 'viernes'].forEach((k) => (d.horario[k] = clone(d.horario.lunes)));
      return 'horario';
    },
    'add-holiday': () => {
      d.festivos.push({ fecha: new Date().toISOString().slice(0, 10), motivo: 'Festivo' });
      return 'cierres';
    },
    'remove-holiday': () => {
      d.festivos.splice(i, 1);
      return 'cierres';
    },
    'add-closure': () => {
      const today = new Date().toISOString().slice(0, 10);
      d.cierres.push({ desde: today, hasta: today, motivo: 'Vacaciones' });
      return 'cierres';
    },
    'remove-closure': () => {
      d.cierres.splice(i, 1);
      return 'cierres';
    },
    'add-pro': () => {
      d.profesionales.push({
        id: uid('persona'),
        nombre: 'Persona nueva',
        servicios: d.servicios.map((s) => s.id),
      });
      return 'profesionales';
    },
    'remove-pro': () => {
      d.profesionales.splice(i, 1);
      return 'profesionales';
    },
    'copy-email': () => {
      navigator.clipboard?.writeText(state.overview.google.email).then(() => toast('Correo copiado'));
    },
  };
  const touched = actions[btn.dataset.action]?.();
  if (!touched) return;
  [touched].flat().forEach(renderSection);
  markDirty();
}

view.addEventListener('click', async (e) => {
  if (e.target.closest('[data-discard]')) {
    state.draft = clone(state.saved);
    state.dirty = false;
    SECTIONS.forEach(([id]) => renderSection(id));
    renderSavebar();
    $('#save-errors').innerHTML = '';
    return;
  }
  const save = e.target.closest('[data-save]');
  if (!save) return;
  save.disabled = true;
  try {
    const saved = await api(`/api/tenants/${state.tenant}`, {
      method: 'PUT',
      body: JSON.stringify(state.draft),
    });
    state.saved = saved;
    state.draft = clone(saved);
    state.dirty = false;
    $('#save-errors').innerHTML = '';
    renderSavebar();
    SECTIONS.forEach(([id]) => renderSection(id));
    toast('Cambios guardados');
    await loadOverview();
  } catch (err) {
    save.disabled = false;
    const box = $('#save-errors');
    if (box)
      box.innerHTML = `<div class="notice bad errors">${icon('x')}<div><b>No se ha podido guardar. Revisa esto:</b><ul>${friendlyError(
        err.message,
      )
        .split(' · ')
        .map((l) => `<li>${esc(l)}</li>`)
        .join('')}</ul></div></div>`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

/* ---------------- Nuevo negocio ---------------- */

function openNewBusiness() {
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `<form class="modal-card" role="dialog" aria-modal="true" aria-labelledby="nb-title">
    <h1 id="nb-title" style="font-size:20px">Nuevo negocio</h1>
    <p class="sub">Después podrás completar servicios, horario y el resto en «Mi negocio».</p>
    <div style="display:grid;gap:16px;margin-top:18px">
      <label class="field"><span>Nombre del negocio</span><input name="nombre" required autofocus placeholder="Por ejemplo, Peluquería Lucía" /></label>
      <label class="field"><span>¿A qué se dedica?</span><input name="descripcion" required placeholder="Por ejemplo, peluquería de barrio" /></label>
    </div>
    <p class="errors muted" id="nb-error" style="color:var(--bad);margin:12px 0 0"></p>
    <div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>Cancelar</button><button class="btn" type="submit">${icon('plus')}Crear</button></div>
  </form>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => (e.target === wrap || e.target.closest('[data-cancel]')) && close());
  wrap.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const nombre = String(f.get('nombre')).trim();
    const cfg = {
      id: `${slug(nombre)}-${Math.random().toString(36).slice(2, 6)}`,
      nombre,
      descripcion: String(f.get('descripcion')).trim(),
      tono: TONOS[0],
      idioma: 'es-ES',
      bienvenida: `¡Hola! Soy el asistente virtual de ${nombre}, un asistente con inteligencia artificial. ¿En qué puedo ayudarte? Si prefieres hablar con una persona, dímelo.`,
      zona_horaria: 'Europe/Madrid',
      activo: true,
      modo: 'test',
      numeros_prueba: [],
      responsable: { nombre: '', telefono: '' },
      ubicaciones: [
        {
          id: 'local',
          nombre: 'En el local',
          tipo: 'presencial',
          direccion: '',
          detalles: '',
          activa: false,
        },
        {
          id: 'telefono',
          nombre: 'Llamada telefónica',
          tipo: 'telefono',
          direccion: '',
          detalles: '',
          activa: true,
        },
      ],
      servicios: [
        {
          id: 'cita',
          nombre: 'Cita',
          duracion_min: 30,
          descripcion: '',
          ubicaciones: ['local', 'telefono'],
          activo: true,
        },
      ],
      profesionales: [],
      horario: Object.fromEntries(
        DIAS.map(([k], i) => [
          k,
          i < 5
            ? [
                ['09:00', '14:00'],
                ['16:00', '19:00'],
              ]
            : [],
        ]),
      ),
      festivos: [],
      cierres: [],
      reglas: { antelacion_minima_min: 120, max_dias_vista: 30, margen_entre_citas_min: 15 },
      google: { calendar_id: '', spreadsheet_id: '', pestana: 'Citas' },
      info_extra: [],
      politica_cancelacion: '',
      pendientes: [
        'Revisar los servicios, el horario y las formas de atender',
        'Poner la dirección del local o dejar esa opción desactivada',
        'Conectar el calendario y la hoja de Google',
        'Vincular el WhatsApp del negocio',
      ],
    };
    try {
      const saved = await api('/api/tenants', { method: 'POST', body: JSON.stringify(cfg) });
      close();
      state.tenant = saved.id;
      state.dirty = false;
      remember(saved.id);
      toast('Negocio creado. Completa sus datos.');
      if (location.hash === '#/negocio') route();
      else location.hash = '#/negocio';
    } catch (err) {
      $('#nb-error').textContent = friendlyError(err.message);
    }
  };
}

/* ---------------- Actividad ---------------- */

const EVENTS = {
  cita_creada: ['ok', 'check', 'Cita reservada', (d) => `Código ${d.id}`],
  cita_cancelada: ['warn', 'x', 'Cita cancelada', (d) => `Código ${d.id}`],
  cita_reprogramada: ['warn', 'clock', 'Cita cambiada de hora', (d) => `Código ${d.id}`],
  whatsapp_conectado: ['ok', 'phone', 'WhatsApp conectado'],
  whatsapp_sesion_cerrada: [
    'bad',
    'phone',
    'La conexión de WhatsApp se cerró',
    () => 'Vuelve a escanear el código en la sección WhatsApp',
  ],
  ignorado_modo_test: ['', 'phone', 'Mensaje sin contestar (modo pruebas)', (d) => `De ${d.telefono}`],
  derivado_a_humano: [
    'warn',
    'user',
    'Un cliente quiere hablar con una persona',
    (d) => `${d.telefono || ''} · ${d.motivo || ''}`,
  ],
  sheets_error: ['bad', 'table', 'No se pudo apuntar la cita en la hoja', (d) => d.error],
  error_respuesta: ['bad', 'chat', 'El asistente no pudo responder', (d) => d.error],
  gdpr_borrado: ['', 'trash', 'Se borraron los datos de un cliente', (d) => `${d.telefono}`],
};

async function activity(alive) {
  const rows = await api(`/api/logs?tenant=${encodeURIComponent(state.tenant || '')}`);
  if (!alive()) return;
  setView(`<div class="page-head"><div><h1>Actividad</h1><p class="sub">Lo último que ha pasado con el asistente.</p></div></div>
    <div class="card"><ul class="feed">${
      rows
        .map((l) => {
          const [cls, ic, title, detail] = EVENTS[l.event] || [
            l.level === 'error' ? 'bad' : '',
            'activity',
            l.event.replace(/_/g, ' '),
          ];
          const extra = detail && l.data ? detail(l.data) : '';
          return `<li><span class="ico ${cls}">${icon(ic)}</span><div><b>${esc(title)}</b>${extra ? `<p>${esc(extra)}</p>` : ''}</div><time>${esc(when(l.createdAt))}</time></li>`;
        })
        .join('') ||
      `<li style="display:block"><div class="empty">${icon('activity')}Todavía no hay actividad.</div></li>`
    }</ul></div>`);
}

route();
