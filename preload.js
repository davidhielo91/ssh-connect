const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listServers: () => ipcRenderer.invoke('servers:list'),
  saveServer: (form) => ipcRenderer.invoke('server:save', form),
  deleteServer: (id) => ipcRenderer.invoke('server:delete', id),
  open: (id) => ipcRenderer.invoke('session:open', id),
  close: (id) => ipcRenderer.send('session:close', id),
  serverMenu: (id, live) => ipcRenderer.send('server:menu', id, live),
  onServerAction: (cb) => ipcRenderer.on('server:action', (e, id, action) => cb(id, action)),
  write: (id, data, binary) => ipcRenderer.send('ssh:write', id, data, binary),
  resize: (id, cols, rows) => ipcRenderer.send('ssh:resize', id, cols, rows),
  wake: () => ipcRenderer.send('session:wake'),
  copy: (text) => ipcRenderer.send('clip:write', text),
  paste: () => ipcRenderer.invoke('clip:read'),
  openLink: (url) => ipcRenderer.send('link:open', url),
  bell: (id) => ipcRenderer.send('notify:bell', id),
  onFocusServer: (cb) => ipcRenderer.on('server:focus', (e, id) => cb(id)),
  onLatency: (cb) => ipcRenderer.on('ssh:latency', (e, id, ms) => cb(id, ms)),
  onData: (cb) => ipcRenderer.on('ssh:data', (e, id, data) => cb(id, data)),
  onStatus: (cb) => ipcRenderer.on('ssh:status', (e, status) => cb(status)),
});
