// Sandboxed preload: the only bridge is one function that asks the main process
// to open a sign-in URL. The main process validates it; this file grants nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tendrilDesktop', Object.freeze({
  openExternal(url) {
    if (typeof url === 'string' && url.length < 2048) ipcRenderer.send('tendril:open-external', url);
  },
}));
