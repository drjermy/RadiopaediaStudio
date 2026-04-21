import { ChildProcess, spawn } from 'child_process';
import { existsSync } from 'fs';
import { createServer } from 'net';
import * as path from 'path';

export interface NodeBackendHandle {
  port: number;
  process: ChildProcess;
}

export interface NodeBackendRoots {
  projectRoot: string;
  resourcesPath: string;
  isPackaged: boolean;
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
  throw new Error(`node sidecar did not become healthy within ${timeoutMs}ms`);
}

function resolveServerDir(roots: NodeBackendRoots): string {
  if (roots.isPackaged) {
    // When packaged: bundled alongside Python as an extra resource.
    const packed = path.join(roots.resourcesPath, 'backend-js');
    if (!existsSync(path.join(packed, 'server.mjs'))) {
      throw new Error(`bundled node sidecar not found at ${packed}`);
    }
    return packed;
  }
  const dir = path.join(roots.projectRoot, 'backend-js');
  if (!existsSync(path.join(dir, 'node_modules'))) {
    throw new Error(
      `node sidecar deps not installed. Run: cd backend-js && npm install`,
    );
  }
  return dir;
}

export async function startNodeSidecar(roots: NodeBackendRoots): Promise<NodeBackendHandle> {
  const port = await pickFreePort();
  const cwd = resolveServerDir(roots);

  // Use the same Node binary running Electron — available as process.execPath
  // in main, but we pass the system 'node' here for dev mode portability.
  // electron itself *can* run mjs via `--experimental-node-api` etc., but
  // spawning system node is simpler and already present in dev.
  const nodeBin = process.execPath.endsWith('Electron') ? 'node' : process.execPath;

  const child = spawn(nodeBin, ['server.mjs', '--port', String(port)], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Electron sets ELECTRON_RUN_AS_NODE=1 implicitly for the Node binary it
    // spawns; unset so we don't confuse a system node.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });

  child.stdout?.on('data', (d) => process.stdout.write(`[node] ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[node] ${d}`));
  child.on('exit', (code) => {
    console.log(`[node] exited with code ${code}`);
  });

  await waitForHealth(port);
  return { port, process: child };
}

export function stopNodeSidecar(handle: NodeBackendHandle): void {
  if (!handle.process.killed) {
    handle.process.kill('SIGTERM');
  }
}
