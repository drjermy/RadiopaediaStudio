import { ChildProcess, spawn } from 'child_process';
import { existsSync } from 'fs';
import { createServer } from 'net';
import * as path from 'path';
import {
  reapStaleSidecar,
  removeSidecarPidfile,
  writeSidecarPid,
} from './sidecar-pidfile';

export interface NodeBackendHandle {
  port: number;
  process: ChildProcess;
  pidfilePath: string;
}

export interface NodeBackendRoots {
  projectRoot: string;
  resourcesPath: string;
  userDataPath: string;
  isPackaged: boolean;
}

// `ps -o command=` for the spawned sidecar shows Electron's helper binary
// followed by the absolute server.mjs path. Matching that path is more
// distinctive than matching `node`/`Electron Helper`, and is identical for
// dev and packaged runs from the same checkout.
const NODE_SIDECAR_MARKER = 'backend-js/server.mjs';
const PIDFILE_NAME = 'node-sidecar.pid';

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
  throw new Error(`node sidecar did not become healthy within ${timeoutMs}ms`);
}

function resolveServerDir(roots: NodeBackendRoots): string {
  const dir = roots.isPackaged
    ? path.join(roots.resourcesPath, 'backend-js')
    : path.join(roots.projectRoot, 'backend-js');
  if (!existsSync(path.join(dir, 'server.mjs'))) {
    throw new Error(`node sidecar not found at ${dir}`);
  }
  if (!existsSync(path.join(dir, 'node_modules'))) {
    throw new Error(
      `node sidecar deps missing at ${dir}. ` +
        (roots.isPackaged
          ? 'Packaged build did not bundle backend-js/node_modules'
          : 'Run: cd backend-js && npm install'),
    );
  }
  return dir;
}

export async function startNodeSidecar(roots: NodeBackendRoots): Promise<NodeBackendHandle> {
  const pidfilePath = path.join(roots.userDataPath, PIDFILE_NAME);
  await reapStaleSidecar(pidfilePath, NODE_SIDECAR_MARKER);

  const port = await pickFreePort();
  const cwd = resolveServerDir(roots);

  // Run as Node using the Electron binary's built-in Node runtime.
  // ELECTRON_RUN_AS_NODE=1 makes process.execPath behave like plain `node`,
  // so we don't need to ship a separate Node binary.
  const child = spawn(
    process.execPath,
    [path.join(cwd, 'server.mjs'), '--port', String(port)],
    {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    },
  );

  child.stdout?.on('data', (d) => process.stdout.write(`[node] ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[node] ${d}`));
  child.on('exit', (code) => {
    console.log(`[node] exited with code ${code}`);
  });

  writeSidecarPid(pidfilePath, child.pid);
  try {
    await waitForHealth(port);
  } catch (err) {
    if (!child.killed) child.kill('SIGTERM');
    removeSidecarPidfile(pidfilePath);
    throw err;
  }
  return { port, process: child, pidfilePath };
}

export function stopNodeSidecar(handle: NodeBackendHandle): void {
  if (!handle.process.killed) {
    handle.process.kill('SIGTERM');
  }
  removeSidecarPidfile(handle.pidfilePath);
}
