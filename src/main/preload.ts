import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('backend', {
  getPort: (): Promise<number | null> => ipcRenderer.invoke('backend:port'),
});

contextBridge.exposeInMainWorld('nodeBackend', {
  getPort: (): Promise<number | null> => ipcRenderer.invoke('nodeBackend:port'),
});

contextBridge.exposeInMainWorld('fsBridge', {
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  isDirectory: (p: string): Promise<boolean> => ipcRenderer.invoke('fs:isDirectory', p),
});

contextBridge.exposeInMainWorld('shellBridge', {
  reveal: (p: string): Promise<void> => ipcRenderer.invoke('shell:reveal', p),
});

contextBridge.exposeInMainWorld('dialogBridge', {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder'),
});
