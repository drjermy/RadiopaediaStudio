import { ChildProcess, spawn } from 'child_process';
import { existsSync } from 'fs';
import { createServer } from 'net';
import * as path from 'path';

export interface BackendHandle {
  port: number;
  process: ChildProcess;
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error('no address'));
      }
    });
  });
}

async function waitForHealth(port: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`backend did not become healthy within ${timeoutMs}ms`);
}

export interface BackendRoots {
  projectRoot: string;
  resourcesPath: string;
  isPackaged: boolean;
}

function resolveBackend(roots: BackendRoots): { python: string; cwd: string } {
  const base = roots.isPackaged
    ? path.join(roots.resourcesPath, 'backend')
    : path.join(roots.projectRoot, 'backend');
  const python = path.join(base, '.venv', 'bin', 'python');
  if (!existsSync(python)) {
    throw new Error(
      `Python binary not found at ${python}. ` +
        (roots.isPackaged
          ? 'Packaged build requires a bundled backend (PyInstaller — TODO).'
          : 'Run: python3 -m venv backend/.venv && backend/.venv/bin/pip install -e backend'),
    );
  }
  return { python, cwd: base };
}

export async function startBackend(roots: BackendRoots): Promise<BackendHandle> {
  const port = await pickFreePort();
  const { python, cwd } = resolveBackend(roots);

  const child = spawn(python, ['-m', 'app.main', '--port', String(port)], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (d) => process.stdout.write(`[py] ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[py] ${d}`));
  child.on('exit', (code) => {
    console.log(`[py] exited with code ${code}`);
  });

  await waitForHealth(port);
  return { port, process: child };
}

export function stopBackend(handle: BackendHandle): void {
  if (!handle.process.killed) {
    handle.process.kill('SIGTERM');
  }
}
