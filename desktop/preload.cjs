const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('JarvisDesktop', {
  getAccessToken: () => ipcRenderer.invoke('jarvis:token'),
  getConnectionInfo: () => ipcRenderer.invoke('jarvis:connection'),
  copyPhoneKey: () => ipcRenderer.invoke('jarvis:copy-phone-key'),
  showPhoneHelp: () => ipcRenderer.invoke('jarvis:phone-help'),
  downloadModel: () => ipcRenderer.invoke('jarvis:download-model'),
  getAiSetupStatus: () => ipcRenderer.invoke('jarvis:ai-setup-status'),
  onAiSetupStatus: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('jarvis:ai-setup-status', listener);
    return () => ipcRenderer.removeListener('jarvis:ai-setup-status', listener);
  },
  installOllama: () => ipcRenderer.invoke('jarvis:install-ollama'),
  getVoiceStatus: () => ipcRenderer.invoke('jarvis:voice-status'),
  setupVoice: () => ipcRenderer.invoke('jarvis:voice-setup'),
  transcribeVoice: (wav, language) => ipcRenderer.invoke('jarvis:voice-transcribe', wav, language),
  speakVoice: text => ipcRenderer.invoke('jarvis:voice-speak', text),
  installVoiceRuntime: () => ipcRenderer.invoke('jarvis:voice-runtime'),
  onVoiceStatus: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('jarvis:voice-status', listener);
    return () => ipcRenderer.removeListener('jarvis:voice-status', listener);
  },
});
