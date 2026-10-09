const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('JarvisDesktop', {
  getAccessToken: () => ipcRenderer.invoke('jarvis:token'),
  getConnectionInfo: () => ipcRenderer.invoke('jarvis:connection'),
  copyPhoneKey: () => ipcRenderer.invoke('jarvis:copy-phone-key'),
  showPhoneHelp: () => ipcRenderer.invoke('jarvis:phone-help'),
  downloadModel: () => ipcRenderer.invoke('jarvis:download-model'),
  installOllama: () => ipcRenderer.invoke('jarvis:install-ollama'),
});
ipcRenderer.on('jarvis:model-download', (_event, data) => {
  window.dispatchEvent(new CustomEvent('jarvis-model-download', { detail: data }));
});
