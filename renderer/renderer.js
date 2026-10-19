const $ = (id) => document.getElementById(id);

const COLORS = [
  ['blue', 'Azul'], ['cyan', 'Cian'], ['violet', 'Violeta'], ['pink', 'Rosa'],
  ['orange', 'Naranja'], ['teal', 'Turquesa'], ['lime', 'Lima'], ['gray', 'Gris'],
];
const STATE_WORDS = {
  connecting: 'conectando', connected: 'conectado', reconnecting: 'reconectando',
  ended: 'sesión terminada', failed: 'con error',
};

let servers = [];        // servidores guardados (sin contraseñas)
let active = null;       // id del servidor a la vista; null = pantalla principal
const views = new Map(); // id → { term, fit, el, status }

const server = (id) => servers.find((s) => s.id === id);
const stateOf = (id) => views.get(id)?.status?.state || 'idle';
const isOpen = (id) => stateOf(id) !== 'idle';
// Con conexión pedida por el usuario (conectando, conectado, reconectando o shell terminado).
const isLive = (id) => ['connecting', 'connected', 'reconnecting', 'ended'].includes(stateOf(id));

// ---------- Terminales (una por servidor abierto) ----------

const TERM_OPTIONS = {
  cursorBlink: !matchMedia('(prefers-reduced-motion: reduce)').matches,
  fontFamily: '"Cascadia Mono", Consolas, monospace',
  fontSize: 14,
  scrollback: 10000,
  // Hipervínculos OSC 8 (los que emiten algunas apps): igual que los enlaces de texto.
  linkHandler: { activate: (e, uri) => openLink(e, uri), allowNonHttpProtocols: false },
  // Paleta ANSI a juego con la interfaz (index.html :root).
  theme: {
    background: '#151a21', foreground: '#cdd3dc',
    cursor: '#eef1f5', cursorAccent: '#151a21',
    selectionBackground: '#34465e',
    black: '#232a33', red: '#ef6b6b', green: '#6cc48a', yellow: '#e0b35a',
    blue: '#6f9be8', magenta: '#c08ae0', cyan: '#5fc3cc', white: '#b8c0cb',
    brightBlack: '#5c6673', brightRed: '#ff8a8a', brightGreen: '#8ad9a5', brightYellow: '#f0ca7a',
    brightBlue: '#92b4f4', brightMagenta: '#d4a8ef', brightCyan: '#84d8de', brightWhite: '#eef1f5',
  },
};

// Los enlaces se abren con Shift+clic, para que un clic normal no lleve al navegador por error.
function openLink(e, uri) {
  if (e.shiftKey) api.openLink(uri);
}

// Lo máximo que un programa del servidor puede copiar a tu portapapeles.
const OSC52_MAX = 1024 * 1024;
const TOO_BIG = Symbol('demasiado grande');

// OSC 52: así copian los programas del servidor (OpenCode, tmux, vim…). Llega como
// "<destino>;<base64>". Una petición de lectura ("?") se ignora: el servidor no lee el portapapeles.
function osc52(data) {
  const b64 = data.slice(data.indexOf(';') + 1);
  if (!b64 || b64 === '?') return null;
  if (b64.length * 3 / 4 > OSC52_MAX) return TOO_BIG;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

// Cuánto espera el clic derecho la copia OSC 52 de un programa que usa el mouse antes de pegar.
const APP_COPY_WAIT = 600;

// Se quita ESC de lo pegado: un texto copiado de una página (o de otro servidor) podría traer un
// "\x1b[201~" escondido que cierra el pegado protegido del shell y ejecuta lo que viene después.
async function paste(term) {
  const text = (await api.paste()).replace(/\x1b/g, '');
  if (text) term.paste(text);
}

function view(id) {
  let v = views.get(id);
  if (v) return v;
  const el = document.createElement('div');
  el.className = 'term';
  el.hidden = id !== active;
  $('terms').append(el);
  const term = new Terminal(TERM_OPTIONS);
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon(openLink));
  term.open(el);
  // appCopied: el programa acaba de copiar por OSC 52 (ver clic derecho). copies cuenta esas copias.
  v = { term, fit, el, status: null, appCopied: false, copies: 0, pasteTimer: null };
  views.set(id, v);

  term.onResize(({ cols, rows }) => api.resize(id, cols, rows));
  term.onData((data) => {
    // Los reportes del mouse (ESC [ M / ESC [ <) y de foco (ESC [ I / O) también pasan por aquí: no cuentan.
    if (!/^\x1b\[([M<]|[IO]$)/.test(data)) v.appCopied = false;
    api.write(id, data, false);
  });
  // Cada copia del servidor se avisa en la barra, para que nunca cambie tu portapapeles a escondidas.
  term.parser.registerOscHandler(52, (data) => {
    const text = osc52(data);
    const name = server(id)?.name || 'El servidor';
    if (text === TOO_BIG) {
      flash(`${name} intentó copiar más de 1 MB al portapapeles; no se copió.`, 'warn');
    } else if (text) {
      api.copy(text);
      v.appCopied = true;
      v.copies++;
      const n = [...text].length;
      flash(`${name} copió ${n.toLocaleString('es')} ${n === 1 ? 'carácter' : 'caracteres'} al portapapeles.`);
    }
    return true;
  });
  term.onBinary((data) => api.write(id, data, true));

  // Ctrl+C copia si hay texto seleccionado (si no, manda ^C). Ctrl+V y Ctrl+Shift+V pegan.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (switchKey(e)) return false;
    if (!e.ctrlKey || e.altKey) return true;
    const key = e.key.toLowerCase();
    if (key === 'c' && (e.shiftKey || term.hasSelection())) {
      e.preventDefault();
      if (term.hasSelection()) api.copy(term.getSelection());
      term.clearSelection();
      return false;
    }
    if (key === 'v') {
      e.preventDefault();
      paste(term);
      return false;
    }
    return true;
  });

  // Clic derecho: copia la selección o, si no hay, pega (como PuTTY). Si el programa del
  // servidor seleccionó y ya copió por OSC 52, no pega: "seleccionar → clic derecho" es copiar.
  // Shift+arrastrar fuerza la selección de la terminal en programas que usan el mouse.
  // Si el programa usa el mouse, el clic derecho también le llega a él, y algunos (OpenCode)
  // copian su propia selección con ese clic: su OSC 52 tarda un viaje de red, así que se espera
  // un momento y solo se pega si no copió nada.
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    clearTimeout(v.pasteTimer);
    if (term.hasSelection()) {
      api.copy(term.getSelection());
      term.clearSelection();
    } else if (v.appCopied) {
      v.appCopied = false;
    } else if (term.modes.mouseTrackingMode !== 'none') {
      const copies = v.copies;
      v.pasteTimer = setTimeout(() => {
        if (v.copies === copies) paste(term);
        else v.appCopied = false;
      }, APP_COPY_WAIT);
    } else {
      paste(term);
    }
  });
  return v;
}

function dropView(id) {
  const v = views.get(id);
  if (!v) return;
  v.term.dispose();
  v.el.remove();
  views.delete(id);
}

function doFit() {
  const v = active && views.get(active);
  if (v && !v.el.hidden) try { v.fit.fit(); } catch {}
}
new ResizeObserver(doFit).observe($('terms'));

api.onData((id, data) => views.get(id)?.term.write(data));

// ---------- Cambiar de servidor ----------

// Elegir un servidor solo lo muestra: se conecta únicamente con clic derecho → Conectar.
function select(id) {
  active = id;
  $('home').hidden = !!id;
  $('terms').hidden = !id;
  $('band').hidden = !id;
  for (const [vid, v] of views) v.el.hidden = vid !== id;
  if (id) {
    $('band').dataset.color = server(id).color;
    const v = view(id);
    doFit();
    v.term.focus();
  }
  renderLists();
  renderBar();
}

// Si la contraseña guardada no se puede leer, se pide de nuevo.
async function openSession(id) {
  // Al desconectar, main olvida la sesión y su tamaño; la terminal solo lo avisa cuando cambia.
  const v = views.get(id);
  if (v) api.resize(id, v.term.cols, v.term.rows);
  const res = await api.open(id);
  if (!res.ok && id === active && $('setup').hidden) {
    openForm(id, res.error, 'auth');
    // El usuario pidió conectar: al escribir la contraseña debe quedar conectado.
    stayConnected = true;
  }
}

function connect(id) {
  select(id);
  openSession(id);
}

function disconnect(id) {
  api.close(id);
}

async function removeServer(id) {
  const res = await api.deleteServer(id);
  if (!res.ok) return flash(res.error, 'warn');
  dropView(id);
  if (active === id) active = null;
  await refresh();
  select(active);
}

// Lo que se eligió en el menú del clic derecho (main.js 'server:menu').
api.onServerAction((id, action) => {
  if (!server(id)) return;
  if (action === 'connect') connect(id);
  else if (action === 'disconnect') disconnect(id);
  else if (action === 'edit') openForm(id);
  else if (action === 'delete') removeServer(id);
});

// Ctrl+1…9 salta al servidor N; Ctrl+Tab / Ctrl+Shift+Tab recorren los abiertos.
function switchKey(e) {
  if (!e.ctrlKey || e.altKey || e.metaKey) return false;
  let target;
  if (e.key === 'Tab') {
    const open = servers.filter((s) => isOpen(s.id));
    if (!open.length) return false;
    const i = open.findIndex((s) => s.id === active);
    const step = e.shiftKey ? -1 : 1;
    target = open[i === -1 ? (step > 0 ? 0 : open.length - 1) : (i + step + open.length) % open.length];
  } else if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
    target = servers[Number(e.key) - 1];
  }
  if (!target) return false;
  e.preventDefault();
  select(target.id);
  return true;
}

document.addEventListener('keydown', (e) => {
  // Dentro de una terminal ya lo maneja attachCustomKeyEventHandler.
  if ($('setup').hidden && !e.target.closest('.xterm')) switchKey(e);
});

// ---------- Listas de servidores ----------

function item(s) {
  const li = document.createElement('li');
  li.className = 'item';
  li.dataset.color = s.color;
  const state = stateOf(s.id);

  const pick = document.createElement('button');
  pick.className = 'pick';
  pick.setAttribute('aria-label', `${s.name}, ${STATE_WORDS[state] || 'desconectado'}`);
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = s.name;
  const dot = document.createElement('span');
  dot.className = 'state';
  dot.dataset.state = state;
  const addr = document.createElement('span');
  addr.className = 'addr';
  addr.textContent = `${s.username}@${s.host}${s.port === 22 ? '' : ':' + s.port}`;
  pick.append(name, dot, addr);
  pick.addEventListener('click', () => select(s.id));

  const edit = document.createElement('button');
  edit.className = 'edit';
  edit.title = edit.ariaLabel = `Editar ${s.name}`;
  edit.textContent = '✎';
  edit.addEventListener('click', () => openForm(s.id));

  li.append(pick, edit);
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.serverMenu(s.id, isLive(s.id));
  });
  return li;
}

function renderLists() {
  $('list').replaceChildren(...servers.map((s) => {
    const li = item(s);
    if (s.id === active) {
      li.classList.add('current');
      li.querySelector('.pick').setAttribute('aria-current', 'true');
    }
    return li;
  }));
  $('home-list').replaceChildren(...servers.map(item));

  const empty = !servers.length;
  const error = $('home-hint').dataset.error;
  $('home-title').textContent = error ? 'No se pudo abrir tu lista' : empty ? 'Agrega tu primer servidor' : 'Tus servidores';
  $('home-hint').textContent = error || (empty
    ? 'Necesitas la dirección del servidor, tu usuario y tu contraseña SSH.'
    : 'Para conectar uno, haz clic derecho sobre él y elige Conectar. Los que ya están conectados siguen así en segundo plano.');
  $('home-add').hidden = !empty || !!error;
}

async function refresh() {
  const res = await api.listServers();
  servers = res.servers;
  if (res.error) $('home-hint').dataset.error = res.error;
  else delete $('home-hint').dataset.error;
  if (active && server(active)) $('band').dataset.color = server(active).color;
  renderLists();
  renderBar();
}

// ---------- Barra de estado ----------

// Aviso breve a la derecha de la barra (p. ej. "copió 120 caracteres"); se borra solo.
let flashTimer = null;
function flash(text, kind = '') {
  clearTimeout(flashTimer);
  $('flash').textContent = text;
  $('flash').dataset.kind = kind;
  flashTimer = setTimeout(() => { $('flash').textContent = ''; }, 4000);
}

function setBar(state, text, countdown = 0, elapsed = 0) {
  $('bar').dataset.state = state;
  $('status').textContent = text;
  // Al reconectar, la línea se llena hasta el siguiente intento.
  const line = $('line');
  line.style.animation = 'none';
  if (countdown) {
    void line.offsetWidth;
    line.style.animation = `countdown ${countdown}s linear ${-elapsed}s forwards`;
  }
}

function renderBar() {
  const s = active && server(active);
  $('settings').hidden = !s;
  if (!s) {
    $('notice').textContent = '';
    const n = servers.filter((x) => ['connected', 'ended'].includes(stateOf(x.id))).length;
    if (!servers.length) return setBar('idle', 'Sin servidores');
    return setBar('idle', n ? `${n} de ${servers.length} conectados` : 'Ningún servidor conectado');
  }
  const st = views.get(active)?.status;
  $('notice').textContent = st?.notice || '';
  $('offline').hidden = isLive(active);
  $('offline-name').textContent = s.name;
  switch (st?.state) {
    case 'connecting':
      return setBar('connecting', `Conectando a ${s.name}…`);
    case 'connected':
      return setBar('connected', `Conectado — ${s.name}${st.tmux ? ' · tmux' : ''}`);
    case 'reconnecting':
      return st.delay
        ? setBar('reconnecting', `Sin conexión: ${st.message} Reintentando en ${st.delay}s (intento ${st.attempt})`,
          st.delay, (Date.now() - st.at) / 1000)
        : setBar('reconnecting', `Reconectando… (intento ${st.attempt})`);
    case 'ended':
      return setBar('ended', 'La sesión terminó — presiona Enter para abrir una nueva');
    case 'failed':
      return setBar('failed', st.message);
    default:
      return setBar('idle', `${s.name}: desconectado`);
  }
}

api.onStatus((s) => {
  if (s.state === 'idle' && !views.has(s.id)) return;
  const v = view(s.id);
  const prev = v.status?.state;
  v.status = { ...s, at: Date.now() };

  if (s.state === 'connected' && prev === 'reconnecting') v.term.write('\x1b[32m[Reconectado]\x1b[0m\r\n');
  if (s.state === 'reconnecting' && (prev === 'connected' || prev === 'ended')) {
    v.term.write('\r\n\x1b[33m[Conexión perdida — reconectando…]\x1b[0m\r\n');
  }
  if (s.state === 'ended') v.term.write('\r\n\x1b[90m[Sesión terminada — presiona Enter para abrir una nueva]\x1b[0m\r\n');

  renderLists();
  renderBar();
  // Un fallo sin reintento (contraseña, huella) en el servidor a la vista abre su formulario.
  if (s.state === 'failed' && s.kind !== 'test' && s.id === active && $('setup').hidden) {
    openForm(s.id, s.message, s.kind);
  }
});

// ---------- Formulario ----------

const form = $('form');
const field = (name) => form.elements.namedItem(name);
let editing = null;      // id del servidor que se edita; null = nuevo
let acceptNewKey = false;
let tested = false;      // si probamos datos nuevos de un servidor ya guardado
// Guardar prueba la conexión. Si el servidor estaba desconectado, después de la prueba se
// vuelve a desconectar: solo se queda conectado si el usuario ya lo había pedido (o es nuevo).
let stayConnected = false;

$('swatches').append(...COLORS.map(([key, label]) => {
  const l = document.createElement('label');
  l.dataset.color = key;
  l.title = label;
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'color';
  input.value = key;
  input.ariaLabel = label;
  l.append(input, document.createElement('span'));
  return l;
}));

function nextColor() {
  const used = new Set(servers.map((s) => s.color));
  return (COLORS.find(([key]) => !used.has(key)) || COLORS[servers.length % COLORS.length])[0];
}

function openForm(id = null, error = '', kind = '') {
  const s = id && server(id);
  // Si falló sin estar a la vista (p. ej. huella cambiada al reconectar), se muestra ese fallo al editar.
  const last = s && views.get(id)?.status;
  if (!error && last?.state === 'failed' && last.kind !== 'test') {
    error = last.message;
    kind = last.kind;
  }
  editing = s ? id : null;
  tested = false;
  // "failed" solo llega tras un Conectar del usuario (o desde este mismo formulario).
  stayConnected = !s || isLive(id) || stateOf(id) === 'failed';
  form.reset();
  field('name').value = s ? s.name : '';
  field('color').value = s ? s.color : nextColor();
  field('host').value = s ? s.host : '';
  field('port').value = s ? s.port : 22;
  field('username').value = s ? s.username : '';
  field('useTmux').checked = s ? s.useTmux : true;
  field('password').placeholder = s ? '(sin cambios)' : '';
  field('password').required = !s;
  $('setup-title').textContent = s ? `Editar ${s.name}` : 'Nuevo servidor';
  $('remove').hidden = !s;
  $('disconnect').hidden = !s || !isOpen(id);
  resetRemove();
  setBusy(false);
  $('error').textContent = error;
  acceptNewKey = kind === 'fingerprint';
  // Mientras el formulario está abierto, lo demás no recibe foco ni clics.
  for (const el of ['side', 'home', 'terms', 'bar']) $(el).inert = true;
  $('setup').hidden = false;
  $('settings').setAttribute('aria-expanded', 'true');
  (s && error ? field('password') : field('name')).focus();
}

function closeForm() {
  resetRemove();
  $('setup').hidden = true;
  for (const el of ['side', 'home', 'terms', 'bar']) $(el).inert = false;
  $('settings').setAttribute('aria-expanded', 'false');
  if (active) views.get(active)?.term.focus();
}

function setBusy(busy) {
  for (const b of ['connect', 'cancel', 'remove', 'disconnect']) $(b).disabled = busy;
  $('connect').textContent = busy ? 'Conectando…' : editing ? 'Guardar' : 'Conectar';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  setBusy(true);
  $('error').textContent = '';
  const id = editing;
  const res = await api.saveServer({
    id,
    name: field('name').value,
    color: field('color').value,
    host: field('host').value,
    port: field('port').value,
    username: field('username').value,
    password: field('password').value,
    useTmux: field('useTmux').checked,
    acceptNewKey,
  }).catch((err) => ({ ok: false, error: `Error inesperado: ${err.message}` })); // nunca dejar el formulario trabado
  setBusy(false);
  if (res.ok) {
    if (id && !stayConnected) disconnect(res.id);
    // Una prueba fallida cortó la sesión y luego se guardó sin cambios de conexión: se reconecta.
    else if (id && stateOf(id) === 'failed') openSession(id);
    await refresh();
    closeForm();
    select(res.id);
  } else {
    if (!id) dropView(res.id);
    tested = !!id;
    $('error').textContent = res.error;
    acceptNewKey = res.kind === 'fingerprint';
  }
});

function cancelForm() {
  const id = editing;
  closeForm();
  // Si la prueba de datos nuevos cortó la sesión que había, se vuelve a la guardada;
  // si no estaba conectado, queda desconectado.
  if (id && tested && stateOf(id) === 'failed') {
    if (stayConnected) openSession(id);
    else disconnect(id);
  }
}

let removeTimer = null;

function resetRemove() {
  clearTimeout(removeTimer);
  $('remove').classList.remove('confirm');
  $('remove').textContent = 'Eliminar';
}

// Eliminar pide un segundo clic para confirmar.
$('remove').addEventListener('click', async () => {
  const b = $('remove');
  if (!b.classList.contains('confirm')) {
    b.classList.add('confirm');
    b.textContent = 'Sí, eliminar';
    removeTimer = setTimeout(resetRemove, 4000);
    return;
  }
  const id = editing;
  closeForm();
  removeServer(id);
});

$('disconnect').addEventListener('click', () => {
  const id = editing;
  closeForm();
  disconnect(id);
});

$('cancel').addEventListener('click', cancelForm);
$('setup').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('cancel').disabled) cancelForm();
});
$('add').addEventListener('click', () => openForm());
$('home-add').addEventListener('click', () => openForm());
$('settings').addEventListener('click', () => openForm(active));

// ---------- Red ----------

window.addEventListener('online', () => api.wake());

// ---------- Inicio ----------

// Al abrir no se conecta nada: un servidor solo se conecta con clic derecho → Conectar.
refresh();
