import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { statSync } from 'fs';
import * as path from 'path';
import { BackendHandle, startBackend, stopBackend } from './python-manager';
import { NodeBackendHandle, startNodeSidecar, stopNodeSidecar } from './node-manager';
import {
  getRadiopaediaTokens,
  setRadiopaediaTokens,
  clearRadiopaediaTokens,
  getRadiopaediaClientOverride,
  setRadiopaediaClientOverride,
  clearRadiopaediaClientOverride,
  type RadiopaediaTokens,
  type RadiopaediaClientOverride,
} from './credentials';
import { getValidAccessToken } from './radiopaedia-auth';
import { RADIOPAEDIA_API_BASE } from './radiopaedia-config';
import {
  openAuthorizationPage,
  exchangeAuthorizationCode,
  type AuthExchangeResult,
} from './radiopaedia-oauth-oob';

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
    title: 'Radiopaedia Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged,
    },
  });
  if (app.isPackaged) {
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow?.webContents.closeDevTools();
    });
  }
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
  ipcMain.handle('shell:openExternal', async (_evt, url: string): Promise<void> => {
    // Whitelist http(s) so a malicious renderer-side bug can't ask main to
    // launch arbitrary file:// or shell URLs.
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`shell:openExternal rejected non-http URL: ${url}`);
    }
    await shell.openExternal(url);
  });
  ipcMain.handle(
    'credentials:get-radiopaedia-tokens',
    (): RadiopaediaTokens | null => getRadiopaediaTokens(),
  );
  ipcMain.handle(
    'credentials:set-radiopaedia-tokens',
    (_evt, tokens: RadiopaediaTokens): void => setRadiopaediaTokens(tokens),
  );
  ipcMain.handle('credentials:clear-radiopaedia-tokens', (): void => {
    clearRadiopaediaTokens();
  });
  ipcMain.handle(
    'credentials:get-radiopaedia-client-override',
    (): RadiopaediaClientOverride | null => getRadiopaediaClientOverride(),
  );
  ipcMain.handle(
    'credentials:set-radiopaedia-client-override',
    (_evt, override: RadiopaediaClientOverride): void =>
      setRadiopaediaClientOverride(override),
  );
  ipcMain.handle('credentials:clear-radiopaedia-client-override', (): void => {
    clearRadiopaediaClientOverride();
  });
  ipcMain.handle(
    'radiopaedia:get-valid-access-token',
    (): Promise<string | null> => getValidAccessToken(),
  );
  ipcMain.handle(
    'radiopaedia:get-api-base',
    // Renderer needs the configured base (prod / staging / dev) to assemble
    // request URLs and to derive the case-detail URL we surface back to the
    // user. Wired through main rather than baked into the bundle so a
    // staging build can override at run time without recompiling.
    (): string => RADIOPAEDIA_API_BASE,
  );
  ipcMain.handle(
    'radiopaedia:open-authorization-page',
    async (): Promise<'ok' | 'error'> => {
      try {
        await openAuthorizationPage();
        return 'ok';
      } catch (err) {
        console.warn('[main] openAuthorizationPage failed:', (err as Error)?.message);
        return 'error';
      }
    },
  );
  ipcMain.handle(
    'radiopaedia:exchange-authorization-code',
    (_evt, code: string): Promise<AuthExchangeResult> =>
      exchangeAuthorizationCode(code),
  );
  ipcMain.handle('dialog:pickFolder', async (): Promise<string | null> => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open Folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
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
