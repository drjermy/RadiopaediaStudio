// Typed shapes for the `window.*` bridges exposed by src/main/preload.ts
// and the `window.viewerAPI` exposed by src/renderer/viewer.js.
//
// Keep in sync with src/main/preload.ts.

export {};

interface BackendBridge {
  getPort(): Promise<number | null>;
}

interface FsBridge {
  pathForFile(file: File): string;
  isDirectory(p: string): Promise<boolean>;
}

interface ShellBridge {
  reveal(p: string): Promise<void>;
  openExternal(url: string): Promise<void>;
}

interface DialogBridge {
  pickFolder(): Promise<string | null>;
}

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

interface CredentialsBridge {
  getRadiopaediaTokens(): Promise<RadiopaediaTokens | null>;
  setRadiopaediaTokens(tokens: RadiopaediaTokens): Promise<void>;
  clearRadiopaediaTokens(): Promise<void>;
  getRadiopaediaClientOverride(): Promise<RadiopaediaClientOverride | null>;
  setRadiopaediaClientOverride(override: RadiopaediaClientOverride): Promise<void>;
  clearRadiopaediaClientOverride(): Promise<void>;
}

type RadiopaediaAuthExchangeResult = 'ok' | 'error';

interface RadiopaediaBridge {
  getValidAccessToken(): Promise<string | null>;
  getApiBase(): Promise<string>;
  openAuthorizationPage(): Promise<'ok' | 'error'>;
  exchangeAuthorizationCode(code: string): Promise<RadiopaediaAuthExchangeResult>;
}

// viewer.js → window.viewerAPI (see src/renderer/viewer.js).
// `open` takes a folder path, a DOM container, and optional hints so the
// first render matches the series' native geometry / window.
interface ViewerOpenOpts {
  forceStack?: boolean;
  sliceThickness?: number | null;
  sliceSpacing?: number | null;
  orientation?: string | null;
  windowCenter?: number | null;
  windowWidth?: number | null;
}

interface ViewerAPI {
  open(folder: string, container: HTMLElement, opts?: ViewerOpenOpts): Promise<void>;
  close(): void;
  applyWindow(center: number, width: number): void;
  reset(): void;
  goToSlice(index: number): void;
  setTrimRange(range: { start: number; end: number } | null): void;
}

// Detail emitted with the `viewer:state` CustomEvent (see viewer.js).
export interface ViewerStateDetail {
  isVolume: boolean;
  orientation: string | null;
  slabThickness: number | null;
  slabSpacing: number | null;
  sourceThickness: number | null;
  sourceSpacing: number | null;
  trimApplicable: boolean;
  isAtNative: boolean;
  isDefaultView: boolean;
  center: number | null;
  width: number | null;
  isDefaultVOI: boolean;
}

declare global {
  interface Window {
    backend: BackendBridge;
    nodeBackend: BackendBridge;
    fsBridge: FsBridge;
    shellBridge: ShellBridge;
    dialogBridge: DialogBridge;
    credentials: CredentialsBridge;
    radiopaedia: RadiopaediaBridge;
    viewerAPI?: ViewerAPI;
  }

  // Typed DOM event map extension so `document.addEventListener('viewer:state', e => e.detail)`
  // gives the right detail type.
  interface DocumentEventMap {
    'viewer:state': CustomEvent<ViewerStateDetail>;
  }
}
