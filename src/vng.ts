import { spawn, execFile } from "node:child_process";
import { openSync, readFileSync } from "node:fs";

export const VNG_BIN = "vng";

/** Build `vng -r` start args; the kernel path (if any) must follow -r directly,
 *  otherwise vng treats a trailing bare argument as a command to exec in the guest.
 *  --ssh/--name are managed by the plugin; user-passed ones are dropped (including their values) */
export function buildStartArgs(cid: number, name: string, kernel: string | undefined, extra: string[]): string[] {
  const filtered: string[] = [];
  for (let i = 0; i < extra.length; i++) {
    const a = extra[i];
    if (a === "--ssh" || a === "--name") {
      i++; // skip the option value
      continue;
    }
    filtered.push(a);
  }
  const runArgs = kernel ? ["-r", kernel] : ["-r"];
  return [...runArgs, "--ssh", String(cid), "--name", name, ...filtered];
}

/** Build `vng --ssh-client` exec args */
export function buildExecArgs(cid: number, command: string): string[] {
  return ["--ssh-client", String(cid), "--remote-cmd", command];
}

/** Spawn vng in the background with stdio redirected to a log file (detached so it survives pi exit) */
export function spawnDetached(args: string[], logPath: string): void {
  const logFd = openSync(logPath, "a");
  spawn(VNG_BIN, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  }).unref();
}

/** Run a command to completion, collecting stdout/stderr and the exit code */
export function execSync(cid: number, command: string): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(VNG_BIN, buildExecArgs(cid, command), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Locate the qemu PID by matching `guest-cid=<cid>` in its command line.
 * Candidates are verified against /proc/<pid>/comm so that unrelated
 * processes whose command line happens to contain the pattern are never killed.
 */
export async function findQemuPidByCid(cid: number): Promise<number | undefined> {
  const out = await execFileAsync("pgrep", ["-f", `qemu-system.*guest-cid=${cid}`]);
  for (const line of out.trim().split("\n")) {
    const pid = Number(line);
    if (!pid) continue;
    if (isQemuProcess(pid)) return pid;
  }
  return undefined;
}

function isQemuProcess(pid: number): boolean {
  try {
    const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    return comm.startsWith("qemu-system");
  } catch {
    return false;
  }
}

function execFileAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, (err, stdout) => {
      // pgrep exits 1 when there is no match; that is expected
      resolve(err ? "" : stdout);
    });
  });
}

/** Kill qemu; the virtme-run/vng process chain exits on its own afterwards (verified) */
export async function killQemu(cid: number): Promise<void> {
  const pid = await findQemuPidByCid(cid);
  if (pid !== undefined) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

/** Poll ssh-client until a command succeeds; used for VM readiness probing */
export async function waitForReady(cid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { code } = await execSync(cid, "true");
    if (code === 0) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
