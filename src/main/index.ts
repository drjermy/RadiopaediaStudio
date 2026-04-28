import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron';
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
  checkUploadStatus,
  runImageUpload,
  type ImageUploadSpec,
  type ProcessingStatus,
  type UploadEvent,
  type UploadedJob,
} from './upload-images';
import {
  openAuthorizationPage,
  exchangeAuthorizationCode,
  type AuthExchangeResult,
} from './radiopaedia-oauth-oob';

// app.setName drives app.getName() and a handful of secondary surfaces
// (About dialog title fallback, default dialog/keychain identifiers) so
// any code we own that asks "what's the app called?" gets the right
// answer. It does NOT change the macOS app menu (the first menu next to
// the Apple logo) or the Cmd-Tab task-switcher name in dev — those are
// bound to the running binary's CFBundleName, which is Electron.app's
// own Info.plist when running `electron .`. Packaged builds get the
// right name via `productName` in package.json (electron-builder writes
// it into the new .app's Info.plist).
app.setName('Radiopaedia Studio');

let backend: BackendHandle | null = null;
let nodeBackend: NodeBackendHandle | null = null;
let mainWindow: BrowserWindow | null = null;
// Tracks the in-flight image upload, if any. Only one runs at a time so a
// single AbortController is enough — kicking off a new upload before the
// previous finishes is a UX failure, not something we have to support.
let uploadAbort: AbortController | null = null;

const projectRoot = path.resolve(__dirname, '..', '..');
const rendererRoot = app.isPackaged
  ? path.join(__dirname, '..', '..', 'src', 'renderer')
  : path.join(projectRoot, 'src', 'renderer');

// In packaged builds the .icns embedded in the .app bundle drives the icon
// everywhere. In dev (`electron .`) the running binary is Electron's, so
// macOS shows the default Electron diamond — pass the same source PNG
// explicitly so dev runs match what users will see.
const appIconPath = path.join(projectRoot, 'build-resources', 'icon.png');

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 640,
    height: 480,
    title: 'Radiopaedia Studio',
    icon: appIconPath,
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
  // macOS Dock icon: in packaged builds the .app bundle's .icns drives
  // this; in dev the binary is Electron itself, so override at runtime.
  // No-op on Linux/Windows (app.dock is undefined there).
  if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
    const icon = nativeImage.createFromPath(appIconPath);
    if (!icon.isEmpty()) app.dock.setIcon(icon);
  }

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
  // Image-upload pipeline. Returns once the orchestrator settles —
  // success ('ok'), error ('error', with message), or abort ('aborted').
  // Per-step progress is streamed via the `upload:event` channel below.
  ipcMain.handle(
    'upload:start-images',
    async (_evt, spec: ImageUploadSpec): Promise<{ status: 'ok' | 'error' | 'aborted'; message?: string }> => {
      if (uploadAbort) {
        return { status: 'error', message: 'Another upload is already running.' };
      }
      if (!nodeBackend?.port) {
        return { status: 'error', message: 'Node sidecar (anonymiser) is not running — restart the app.' };
      }
      uploadAbort = new AbortController();
      const emit = (e: UploadEvent): void => {
        mainWindow?.webContents.send('upload:event', e);
      };
      try {
        await runImageUpload(spec, emit, uploadAbort.signal, {
          nodeBackendPort: nodeBackend.port,
        });
        return { status: 'ok' };
      } catch (err) {
        if (uploadAbort?.signal.aborted) return { status: 'aborted' };
        return { status: 'error', message: (err as Error)?.message ?? String(err) };
      } finally {
        uploadAbort = null;
      }
    },
  );
  ipcMain.handle('upload:abort', (): void => {
    uploadAbort?.abort();
  });
  // Sent-cases on-demand status check (issue #25). Single round-trip per
  // job, no looping — the panel decides cadence. Aborts via its own
  // controller so the panel can cancel mid-fetch when closed.
  let statusCheckAbort: AbortController | null = null;
  ipcMain.handle(
    'upload:check-status',
    async (_evt, jobs: UploadedJob[]): Promise<Array<{ jobId: string; status: ProcessingStatus }>> => {
      statusCheckAbort?.abort();
      statusCheckAbort = new AbortController();
      try {
        return await checkUploadStatus(jobs, statusCheckAbort.signal);
      } finally {
        statusCheckAbort = null;
      }
    },
  );
  ipcMain.handle('upload:cancel-status-check', (): void => {
    statusCheckAbort?.abort();
  });
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
