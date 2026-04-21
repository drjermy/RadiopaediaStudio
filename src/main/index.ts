import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { statSync } from 'fs';
import * as path from 'path';
import { BackendHandle, startBackend, stopBackend } from './python-manager';
import { NodeBackendHandle, startNodeSidecar, stopNodeSidecar } from './node-manager';

let backend: BackendHandle | null = null;
let nodeBackend: NodeBackendHandle | null = null;
let mainWindow: BrowserWindow | null = null;

const projectRoot = path.resolve(__dirname, '..', '..');
const rendererRoot = app.isPackaged
  ? path.join(__dirname, '..', '..', 'src', 'renderer')
  : path.join(projectRoot, 'src', 'renderer');

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 640,
    height: 480,
    title: 'PACS Anonymizer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await mainWindow.loadFile(path.join(rendererRoot, 'index.html'));
  if (process.env.DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(async () => {
  const roots = {
    projectRoot,
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
  };
  try {
    [backend, nodeBackend] = await Promise.all([
      startBackend(roots),
      startNodeSidecar(roots),
    ]);
    console.log(`[main] python ready on ${backend.port}, node ready on ${nodeBackend.port}`);
  } catch (e) {
    console.error('[main] failed to start backends:', e);
    app.quit();
    return;
  }

  ipcMain.handle('backend:port', () => backend?.port ?? null);
  ipcMain.handle('nodeBackend:port', () => nodeBackend?.port ?? null);
  ipcMain.handle('fs:isDirectory', (_evt, p: string) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
  ipcMain.handle('shell:reveal', (_evt, p: string) => {
    shell.showItemInFolder(p);
  });

  await createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  if (backend) {
    stopBackend(backend);
    backend = null;
  }
  if (nodeBackend) {
    stopNodeSidecar(nodeBackend);
    nodeBackend = null;
  }
});
