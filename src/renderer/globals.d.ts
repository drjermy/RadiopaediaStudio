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

interface UploadSeriesSpec {
  folder: string;
  perspective?: string;
  specifics?: string;
}
interface UploadStartSpec {
  caseId: number;
  studies: Array<{ studyId: number; series: UploadSeriesSpec[] }>;
}
type UploadStartResult = { status: 'ok' | 'error' | 'aborted'; message?: string };

type UploadPhase = 'hash' | 'presign' | 'upload' | 'prepare';
type UploadEventPayload =
  | { type: 'budget'; totalBytes: number; totalFiles: number }
  | { type: 'bytes-progress'; doneBytes: number; totalBytes: number }
  | { type: 'series-start'; studyIdx: number; seriesIdx: number; folder: string; sliceCount: number }
  | { type: 'series-progress'; studyIdx: number; seriesIdx: number; phase: UploadPhase; done: number; total: number }
  | { type: 'series-done'; studyIdx: number; seriesIdx: number }
  | { type: 'series-error'; studyIdx: number; seriesIdx: number; message: string }
  | { type: 'finalize-start' }
  | { type: 'finalize-done' }
  | { type: 'finalize-error'; message: string }
  | { type: 'all-done'; caseId: number }
  | { type: 'aborted' };

interface UploadBridge {
  startImages(spec: UploadStartSpec): Promise<UploadStartResult>;
  abort(): Promise<void>;
  onEvent(handler: (e: UploadEventPayload) => void): () => void;
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
    uploadBridge: UploadBridge;
    viewerAPI?: ViewerAPI;
  }

  // Typed DOM event map extension so `document.addEventListener('viewer:state', e => e.detail)`
  // gives the right detail type.
  interface DocumentEventMap {
    'viewer:state': CustomEvent<ViewerStateDetail>;
  }
}
