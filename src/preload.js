const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = ['rates', 'settings', 'conversion'];

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('get-state'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  refreshRates: () => ipcRenderer.invoke('refresh-rates'),
  setConversion: (conversion) => ipcRenderer.send('set-conversion', conversion),
  openMain: () => ipcRenderer.send('open-main'),
  widgetResize: (height) => ipcRenderer.send('widget-resize', height),
  widgetMenu: () => ipcRenderer.send('widget-menu'),
  on: (channel, callback) => {
    if (CHANNELS.includes(channel)) ipcRenderer.on(channel, (_e, data) => callback(data));
  },
});
