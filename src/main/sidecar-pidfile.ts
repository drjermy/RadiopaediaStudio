import { execFileSync } from 'child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';

// Reaps a sidecar that survived a previous run (crash, force-quit, OS reboot
// before `before-quit` could fire). Reads the recorded PID, confirms it is
// still alive AND that its command line still matches our sidecar — guards
// against PID reuse where the OS handed our old PID to an unrelated
// process. SIGTERM, brief wait, SIGKILL if still alive.
export async function reapStaleSidecar(
  pidfilePath: string,
  commandSubstring: string,
): Promise<void> {
  if (!existsSync(pidfilePath)) return;
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(pidfilePath, 'utf8').trim(), 10);
  } catch {
    safeUnlink(pidfilePath);
    return;
  }
  if (!Number.isFinite(pid) || pid <= 1) {
    safeUnlink(pidfilePath);
    return;
  }

  if (!isAlive(pid)) {
    safeUnlink(pidfilePath);
    return;
  }

  const command = readProcessCommand(pid);
  if (!command || !command.includes(commandSubstring)) {
    // Either the process is gone now or the PID was reassigned — leave it.
    safeUnlink(pidfilePath);
    return;
  }

  console.log(`[main] reaping stale sidecar pid=${pid} (${commandSubstring})`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    safeUnlink(pidfilePath);
    return;
  }

  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (isAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  safeUnlink(pidfilePath);
}

export function writeSidecarPid(pidfilePath: string, pid: number | undefined): void {
  if (!pid) return;
  try {
    writeFileSync(pidfilePath, String(pid), 'utf8');
  } catch (err) {
    console.warn(`[main] failed to write pidfile ${pidfilePath}:`, (err as Error)?.message);
  }
}

export function removeSidecarPidfile(pidfilePath: string): void {
  safeUnlink(pidfilePath);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessCommand(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    return trimmed.length ? trimmed : null;
  } catch {
    return null;
  }
}

function safeUnlink(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    // missing is fine
  }
}

