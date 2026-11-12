// Sandboxed preload. The bridge can ask the main process to open a sign-in URL
// (validated there) and to read or act on the update state. It grants nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tendrilDesktop', Object.freeze({
  openExternal(url) {
    if (typeof url === 'string' && url.length < 2048) ipcRenderer.send('tendril:open-external', url);
  },
  updates: Object.freeze({
    getState: () => ipcRenderer.invoke('tendril:update-get'),
    check: () => ipcRenderer.send('tendril:update-check'),
    download: () => ipcRenderer.send('tendril:update-download'),
    install: () => ipcRenderer.send('tendril:update-install'),
    setAuto: (auto) => ipcRenderer.send('tendril:update-auto', auto === true),
    onState(listener) {
      if (typeof listener !== 'function') return () => {};
      const wrapped = (_event, state) => listener(state);
      ipcRenderer.on('tendril:update-state', wrapped);
      return () => ipcRenderer.removeListener('tendril:update-state', wrapped);
    },
  }),
}));
