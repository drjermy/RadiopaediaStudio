import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('backend', {
  getPort: (): Promise<number | null> => ipcRenderer.invoke('backend:port'),
});

contextBridge.exposeInMainWorld('fsBridge', {
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
});
