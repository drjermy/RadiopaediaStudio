import { app, BrowserWindow, ipcMain } from 'electron';
import { statSync } from 'fs';
import * as path from 'path';
import { BackendHandle, startBackend, stopBackend } from './python-manager';

let backend: BackendHandle | null = null;
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
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(async () => {
  try {
    backend = await startBackend({
      projectRoot,
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
    });
    console.log(`[main] backend ready on port ${backend.port}`);
  } catch (e) {
    console.error('[main] failed to start backend:', e);
    app.quit();
    return;
  }

  ipcMain.handle('backend:port', () => backend?.port ?? null);
  ipcMain.handle('fs:isDirectory', (_evt, p: string) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
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
});
