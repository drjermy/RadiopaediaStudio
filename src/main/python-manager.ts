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

interface BackendLauncher {
  command: string;
  args: string[];
  cwd: string;
}

function resolveBackend(roots: BackendRoots, port: number): BackendLauncher {
  if (roots.isPackaged) {
    const binary = path.join(
      roots.resourcesPath,
      'backend-bin',
      'radiopaedia-studio-backend',
    );
    if (!existsSync(binary)) {
      throw new Error(
        `Bundled backend binary not found at ${binary}. ` +
          'Build: npm run build:backend',
      );
    }
    return {
      command: binary,
      args: ['--port', String(port)],
      cwd: path.dirname(binary),
    };
  }

  const backendDir = path.join(roots.projectRoot, 'backend');
  const python = path.join(backendDir, '.venv', 'bin', 'python');
  if (!existsSync(python)) {
    throw new Error(
      `Python venv not found at ${python}. ` +
        "Run: python3 -m venv backend/.venv && backend/.venv/bin/pip install -e 'backend[dev]'",
    );
  }
  return {
    command: python,
    args: ['-m', 'app.main', '--port', String(port)],
    cwd: backendDir,
  };
}

export async function startBackend(roots: BackendRoots): Promise<BackendHandle> {
  const port = await pickFreePort();
  const { command, args, cwd } = resolveBackend(roots, port);

  const child = spawn(command, args, {
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
