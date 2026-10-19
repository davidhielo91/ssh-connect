const { app, BrowserWindow, ipcMain, safeStorage, powerMonitor, powerSaveBlocker, clipboard, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('ssh2');

// Segundos de espera entre reintentos; el último se repite para siempre.
const BACKOFF = [1, 2, 5, 10, 30];
const TMUX_SESSION = 'sshconnect';

let win = null;

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// ---------- Servidores guardados (contraseñas cifradas con DPAPI vía safeStorage) ----------

const userFile = (name) => path.join(app.getPath('userData'), name);
let store = null;

// Se escribe a un temporal y se renombra: si la app se corta a medias, servers.json queda intacto.
function writeStore() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const file = userFile('servers.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(store, null, 2));
  fs.renameSync(file + '.tmp', file);
}

function getStore() {
  if (store) return store;
  try {
    const data = JSON.parse(fs.readFileSync(userFile('servers.json'), 'utf8'));
    if (!Array.isArray(data?.servers)) throw new Error('servers.json sin lista de servidores');
    // Versiones anteriores guardaban qué servidores reconectar al abrir; ya no se usa.
    store = { servers: data.servers };
    return store;
  } catch (err) {
    // Un archivo ilegible se aparta en vez de pisarlo con una lista vacía.
    if (err.code !== 'ENOENT') {
      try { fs.renameSync(userFile('servers.json'), userFile('servers.json.corrupt')); } catch {}
    }
  }
  store = { servers: [] };
  // Las versiones anteriores guardaban un único servidor en config.json.
  try {
    const old = JSON.parse(fs.readFileSync(userFile('config.json'), 'utf8'));
    const id = crypto.randomUUID();
    store.servers.push({
      id, name: 'Mi servidor', color: 'blue',
      host: old.host, port: old.port, username: old.username, useTmux: old.useTmux,
      hostFingerprint: old.hostFingerprint, passwordEnc: old.passwordEnc,
    });
    writeStore();
    fs.renameSync(userFile('config.json'), userFile('config.json.bak'));
  } catch {}
  return store;
}

const findServer = (id) => getStore().servers.find((s) => s.id === id);

const publicServer = (s) => ({
  id: s.id, name: s.name, color: s.color, host: s.host, port: s.port, username: s.username, useTmux: s.useTmux,
});

// Devuelve la configuración con la contraseña descifrada (null si no se pudo leer), o null.
function getServer(id) {
  const s = findServer(id);
  if (!s) return null;
  let password = null;
  try {
    password = safeStorage.decryptString(Buffer.from(s.passwordEnc, 'base64'));
  } catch {}
  return { ...s, password };
}

function saveServer(cfg) {
  const entry = {
    id: cfg.id,
    name: cfg.name,
    color: cfg.color,
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    useTmux: cfg.useTmux,
    hostFingerprint: cfg.hostFingerprint,
    passwordEnc: safeStorage.encryptString(cfg.password).toString('base64'),
  };
  const list = getStore().servers;
  const i = list.findIndex((s) => s.id === cfg.id);
  if (i === -1) list.push(entry);
  else list[i] = entry;
  writeStore();
}

function friendlyError(err) {
  if (!err) return 'La conexión se cerró.';
  const code = err.code || '';
  if (err.level === 'client-authentication') return 'Usuario o contraseña incorrectos.';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'No se encontró el servidor (revisa la dirección o tu internet).';
  if (code === 'ECONNREFUSED') return 'El servidor rechazó la conexión (¿el puerto es correcto?).';
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'No hay red hacia el servidor.';
  if (code === 'ECONNRESET') return 'La conexión se reinició.';
  if (code === 'ETIMEDOUT' || /timed out/i.test(err.message)) return 'El servidor no respondió a tiempo.';
  if (/keepalive/i.test(err.message)) return 'El servidor dejó de responder.';
  // ssh2: "Unable to open shell", "Unable to exec", "Unable to request a pseudo-TTY"…
  if (/^unable to /i.test(err.message)) return 'El servidor aceptó la contraseña pero no dejó abrir una terminal.';
  return err.message;
}

// ---------- Sesión SSH con keepalive y reconexión automática (una por servidor) ----------

class Session {
  constructor(id) {
    this.id = id;
    this.cfg = null;
    this.client = null;
    this.stream = null;
    this.opening = false;  // openShell() pidió un canal que aún no llega
    this.gen = 0;         // cada intento de conexión tiene su número; los eventos viejos se ignoran
    this.downGen = -1;
    this.attempt = 0;
    this.timer = null;
    this.cols = 80;
    this.rows = 24;
    this.state = 'idle';
    this.test = false;     // true mientras probamos datos nuevos del formulario (sin reintentos)
    this.pending = null;   // resolve() de la promesa que espera el formulario
    this.saveOnOpen = false; // guardar la config cuando abra el shell (prueba o huella nueva)
    this.hasTmux = false;
    this.notice = '';
    this.blocker = null;
  }

  emit(state, extra = {}) {
    this.state = state;
    this.updateBlocker();
    send('ssh:status', {
      id: this.id,
      state,
      attempt: this.attempt,
      tmux: this.hasTmux,
      notice: this.notice,
      ...extra,
    });
  }

  // Evita que Windows suspenda la app mientras hay una sesión activa.
  updateBlocker() {
    const active = ['connecting', 'connected', 'reconnecting', 'ended'].includes(this.state);
    if (active && this.blocker === null) this.blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!active && this.blocker !== null) {
      powerSaveBlocker.stop(this.blocker);
      this.blocker = null;
    }
  }

  start(cfg, test) {
    this.cfg = cfg;
    this.test = test;
    this.attempt = 0;
    if (this.pending) this.pending({ ok: false, error: 'Cancelado.' });
    this.pending = null;
    return new Promise((resolve) => {
      if (test) this.pending = resolve;
      else resolve({ ok: true });
      this.connect();
    });
  }

  connect() {
    clearTimeout(this.timer);
    this.teardown();
    const gen = ++this.gen;
    const c = new Client();
    this.client = c;
    this.hostKeyMismatch = null;
    this.seenFingerprint = null;
    this.emit(this.attempt ? 'reconnecting' : 'connecting');

    c.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
      finish(prompts.map(() => this.cfg.password));
    });
    c.on('ready', () => this.onReady(gen));
    c.on('error', (err) => this.onDown(gen, err));
    c.on('close', () => this.onDown(gen));

    c.connect({
      host: this.cfg.host,
      port: this.cfg.port,
      username: this.cfg.username,
      password: this.cfg.password,
      tryKeyboard: true,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      hostVerifier: (key) => this.verifyHost(key),
    });
  }

  verifyHost(key) {
    const fp = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
    this.seenFingerprint = fp;
    if (!this.cfg.hostFingerprint || this.cfg.acceptNewKey || fp === this.cfg.hostFingerprint) return true;
    this.hostKeyMismatch = fp;
    return false;
  }

  async onReady(gen) {
    if (gen !== this.gen) return;
    this.hasTmux = this.cfg.useTmux ? await this.checkTmux(this.client) : false;
    if (gen !== this.gen) return;
    this.notice = this.cfg.useTmux && !this.hasTmux
      ? 'tmux no está instalado en el servidor: si se corta la conexión se perderá lo que estaba corriendo.'
      : '';

    const fingerprintChanged = this.cfg.hostFingerprint !== this.seenFingerprint;
    this.cfg.hostFingerprint = this.seenFingerprint;
    this.cfg.acceptNewKey = false;
    // Se guarda cuando el shell ya abrió: si el servidor acepta la contraseña pero no da shell,
    // la prueba del formulario falla y un servidor nuevo no queda guardado.
    this.saveOnOpen = this.test || fingerprintChanged;
    this.attempt = 0;
    this.openShell();
  }

  checkTmux(c) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 10000);
      c.exec('command -v tmux', (err, ch) => {
        if (err) {
          clearTimeout(timeout);
          return resolve(false);
        }
        let code = null;
        ch.on('exit', (exitCode) => { code = exitCode; });
        ch.on('close', () => {
          clearTimeout(timeout);
          resolve(code === 0);
        });
        ch.resume();
        ch.stderr.resume();
      });
    });
  }

  openShell() {
    const c = this.client;
    const gen = this.gen;
    const pty = { term: 'xterm-256color', cols: this.cols, rows: this.rows };

    this.opening = true;
    const onOpen = (err, stream) => {
      if (gen !== this.gen) return;
      this.opening = false;
      if (err) return this.onDown(gen, err);
      this.stream = stream;
      if (this.saveOnOpen) saveServer(this.cfg);
      this.saveOnOpen = false;
      this.test = false;
      let exited = false;
      stream.on('data', (d) => send('ssh:data', this.id, d));
      stream.stderr.on('data', (d) => send('ssh:data', this.id, d));
      stream.on('exit', () => { exited = true; });
      stream.on('close', () => {
        if (gen !== this.gen || this.stream !== stream) return;
        this.stream = null;
        // El shell terminó (exit o detach de tmux) pero la conexión sigue viva.
        if (exited) this.emit('ended');
      });
      this.emit('connected');
      if (this.pending) {
        this.pending({ ok: true });
        this.pending = null;
      }
    };

    // "-A" se une a la sesión si ya existe: así se recupera todo tras una reconexión.
    // set-clipboard/allow-passthrough dejan pasar el OSC 52 de los programas (copiar a Windows);
    // -q calla el error en tmux viejos que no conocen la opción.
    // -u fuerza UTF-8 aunque el servidor no defina LANG (si no, tmux cambia acentos por "_").
    // window-size latest: con dos clientes en la misma sesión, manda el último que se usó,
    // en vez de encogerse al más chico.
    const tmuxCmd = `tmux -u new-session -A -s ${TMUX_SESSION}`
      + ' \\; set -gq set-clipboard on \\; set -gq allow-passthrough on \\; set -gq window-size latest';
    if (this.hasTmux) c.exec(tmuxCmd, { pty }, onOpen);
    else c.shell(pty, onOpen);
  }

  onDown(gen, err) {
    if (gen !== this.gen || this.downGen === gen) return;
    this.downGen = gen;
    this.teardown();

    if (this.hostKeyMismatch) {
      return this.fail('fingerprint',
        `¡La huella del servidor cambió! (${this.hostKeyMismatch}). Puede ser un ataque. ` +
        'Si reinstalaste el servidor y confías en el cambio, presiona Conectar para aceptar la nueva huella.');
    }
    if (err && err.level === 'client-authentication') return this.fail('auth', friendlyError(err));
    if (this.test) return this.fail('test', friendlyError(err));

    const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
    this.attempt++;
    this.emit('reconnecting', { delay, message: friendlyError(err) });
    this.timer = setTimeout(() => this.connect(), delay * 1000);
  }

  fail(kind, message) {
    clearTimeout(this.timer);
    this.test = false;
    this.emit('failed', { kind, message });
    if (this.pending) {
      this.pending({ ok: false, kind, error: message });
      this.pending = null;
    }
  }

  // Desconexión pedida por el usuario: no se reintenta.
  stop() {
    clearTimeout(this.timer);
    this.gen++;
    this.teardown();
    this.test = false;
    if (this.pending) this.pending({ ok: false, error: 'Cancelado.' });
    this.pending = null;
    this.emit('idle');
  }

  teardown() {
    this.stream = null;
    this.opening = false;
    if (!this.client) return;
    const c = this.client;
    this.client = null;
    c.removeAllListeners();
    c.on('error', () => {});
    try { c.destroy(); } catch {}
  }

  // Al despertar la PC o volver la red: reintenta ya, o comprueba que la conexión siga viva.
  wake() {
    if (this.state === 'reconnecting') {
      this.connect();
    } else if ((this.state === 'connected' || this.state === 'ended') && this.client) {
      const gen = this.gen;
      const timeout = setTimeout(() => this.onDown(gen, new Error('La conexión no respondió.')), 8000);
      this.client.exec('true', (err, ch) => {
        clearTimeout(timeout);
        if (ch) ch.resume();
      });
    }
  }

  write(data, binary) {
    if (this.stream) {
      this.stream.write(binary ? Buffer.from(data, 'latin1') : data);
    } else if (this.state === 'ended' && !this.opening && data.includes('\r') && this.client) {
      // Varios Enter seguidos abrirían varios shells mientras el primero aún no llega.
      this.openShell();
    }
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    if (this.stream) this.stream.setWindow(rows, cols, 0, 0);
  }
}

const sessions = new Map();
const LIVE = ['connecting', 'connected', 'reconnecting', 'ended'];

function sessionFor(id) {
  let s = sessions.get(id);
  if (!s) {
    s = new Session(id);
    sessions.set(id, s);
  }
  return s;
}

function dropSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.stop();
  sessions.delete(id);
}

function wakeAll() {
  for (const s of sessions.values()) s.wake();
}

// ---------- IPC ----------

ipcMain.handle('servers:list', () => ({ servers: getStore().servers.map(publicServer) }));

// Prueba los datos del formulario (sin reintentos) y los guarda tras el primer "ready".
ipcMain.handle('server:save', async (e, form) => {
  const saved = form.id ? getServer(form.id) : null;
  if (form.id && !saved) return { ok: false, error: 'No se encontró el servidor guardado.' };
  const id = saved ? saved.id : crypto.randomUUID();
  const host = String(form.host).trim();
  const port = Number(form.port) || 22;
  const cfg = {
    id,
    name: String(form.name).trim() || host,
    color: String(form.color || 'blue'),
    host,
    port,
    username: String(form.username).trim(),
    password: form.password || (saved && saved.password) || '',
    useTmux: !!form.useTmux,
    hostFingerprint: saved && saved.host === host && saved.port === port ? saved.hostFingerprint : null,
    acceptNewKey: !!form.acceptNewKey,
  };

  // Si solo cambian el nombre o el color, no hace falta reconectar.
  const sameConnection = saved && saved.password !== null && !form.password && !form.acceptNewKey && saved.host === host &&
    saved.port === port && saved.username === cfg.username && saved.useTmux === cfg.useTmux;
  if (sameConnection) {
    saveServer(cfg);
    const s = sessions.get(id);
    if (s && s.cfg) Object.assign(s.cfg, { name: cfg.name, color: cfg.color });
    return { ok: true, id };
  }

  const res = await sessionFor(id).start(cfg, true);
  // Un servidor nuevo que no llegó a conectar no se guarda.
  if (!res.ok && !saved) dropSession(id);
  return { ...res, id };
});

ipcMain.handle('server:delete', (e, id) => {
  dropSession(id);
  const st = getStore();
  st.servers = st.servers.filter((s) => s.id !== id);
  writeStore();
});

ipcMain.handle('session:open', (e, id) => {
  const s = sessionFor(id);
  if (LIVE.includes(s.state)) return { ok: true };
  const cfg = getServer(id);
  if (!cfg) return { ok: false, error: 'No se encontró el servidor guardado.' };
  if (cfg.password === null) {
    return { ok: false, kind: 'password', error: 'No se pudo leer la contraseña guardada. Escríbela de nuevo.' };
  }
  return s.start(cfg, false);
});

ipcMain.on('session:close', (e, id) => dropSession(id));

// Clic derecho sobre un servidor: es la única forma de conectarlo. La acción elegida vuelve al
// renderer por 'server:action'; si se cierra el menú sin elegir, no pasa nada.
ipcMain.on('server:menu', (e, id, live) => {
  const s = findServer(id);
  if (!s) return;
  const pick = (action) => () => send('server:action', id, action);
  Menu.buildFromTemplate([
    live ? { label: 'Desconectar', click: pick('disconnect') } : { label: 'Conectar', click: pick('connect') },
    { label: 'Editar…', click: pick('edit') },
    { type: 'separator' },
    {
      label: 'Eliminar…',
      click: async () => {
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          title: 'Eliminar servidor',
          message: `¿Eliminar "${s.name}"?`,
          detail: 'Se borra de la lista junto con su contraseña guardada.',
          buttons: ['Eliminar', 'Cancelar'],
          defaultId: 1,
          cancelId: 1,
        });
        if (response === 0) send('server:action', id, 'delete');
      },
    },
  ]).popup({ window: win });
});

ipcMain.on('ssh:write', (e, id, data, binary) => sessions.get(id)?.write(data, binary));
ipcMain.on('ssh:resize', (e, id, cols, rows) => sessionFor(id).resize(cols, rows));
ipcMain.on('session:wake', () => wakeAll());
ipcMain.on('clip:write', (e, text) => clipboard.writeText(text));
ipcMain.handle('clip:read', () => clipboard.readText());
// Solo enlaces web: nada de file:, javascript: u otros esquemas que mande el servidor.
ipcMain.on('link:open', (e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

// ---------- Ventana ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 650,
    minWidth: 600,
    minHeight: 300,
    title: 'SSH Connect',
    backgroundColor: '#151a21',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Soltar un archivo o enlace en la ventana no debe sacarla de la app (el preload seguiría expuesto).
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    createWindow();
    // Tras suspender, la red tarda un momento en volver.
    powerMonitor.on('resume', () => setTimeout(wakeAll, 2000));
  });

  app.on('window-all-closed', () => {
    for (const s of sessions.values()) s.teardown();
    app.quit();
  });
}
