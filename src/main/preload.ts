import { contextBridge, ipcRenderer, webUtils } from 'electron';

// Keep the shapes in `src/renderer/globals.d.ts` in sync with this file.

interface RadiopaediaTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: 'Bearer';
}

interface RadiopaediaClientOverride {
  client_id: string;
  client_secret: string;
}

type AuthExchangeResult = 'ok' | 'error';

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

contextBridge.exposeInMainWorld('credentials', {
  getRadiopaediaTokens: (): Promise<RadiopaediaTokens | null> =>
    ipcRenderer.invoke('credentials:get-radiopaedia-tokens'),
  setRadiopaediaTokens: (tokens: RadiopaediaTokens): Promise<void> =>
    ipcRenderer.invoke('credentials:set-radiopaedia-tokens', tokens),
  clearRadiopaediaTokens: (): Promise<void> =>
    ipcRenderer.invoke('credentials:clear-radiopaedia-tokens'),
  getRadiopaediaClientOverride: (): Promise<RadiopaediaClientOverride | null> =>
    ipcRenderer.invoke('credentials:get-radiopaedia-client-override'),
  setRadiopaediaClientOverride: (
    override: RadiopaediaClientOverride,
  ): Promise<void> =>
    ipcRenderer.invoke('credentials:set-radiopaedia-client-override', override),
  clearRadiopaediaClientOverride: (): Promise<void> =>
    ipcRenderer.invoke('credentials:clear-radiopaedia-client-override'),
});

contextBridge.exposeInMainWorld('radiopaedia', {
  getValidAccessToken: (): Promise<string | null> =>
    ipcRenderer.invoke('radiopaedia:get-valid-access-token'),
  openAuthorizationPage: (): Promise<'ok' | 'error'> =>
    ipcRenderer.invoke('radiopaedia:open-authorization-page'),
  exchangeAuthorizationCode: (code: string): Promise<AuthExchangeResult> =>
    ipcRenderer.invoke('radiopaedia:exchange-authorization-code', code),
});
