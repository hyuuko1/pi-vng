import { spawn, execFile } from "node:child_process";
import { openSync, closeSync, writeSync, readFileSync } from "node:fs";

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

/** Whether stderr text indicates a vsock guest-cid conflict */
export function isCidConflictText(text: string): boolean {
  return /unable to set guest cid[^\n]*Address already in use/.test(text);
}

/** A detached vng process with captured stderr (teed to the log file) */
export interface VngProcess {
  child: import("node:child_process").ChildProcess;
  /** Cumulative stderr text collected so far */
  stderrText(): string;
  /** True once stderr shows a vsock cid conflict */
  hasCidConflict(): boolean;
}

/** Build `vng --ssh-client` exec args */
export function buildExecArgs(cid: number, command: string): string[] {
  return ["--ssh-client", String(cid), "--remote-cmd", command];
}

/** Spawn vng in the background (detached so it survives pi exit), teeing stdout/stderr
 *  into the log file while capturing stderr for cid-conflict detection */
export function spawnDetached(args: string[], logPath: string): VngProcess {
  const logFd = openSync(logPath, "a");
  const child = spawn(VNG_BIN, args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrText = "";
  child.stdout.on("data", (d) => {
    try { writeSync(logFd, d); } catch { /* ignore */ }
  });
  child.stderr.on("data", (d) => {
    stderrText += d;
    try { writeSync(logFd, d); } catch { /* ignore */ }
  });
  child.on("close", () => {
    try { closeSync(logFd); } catch { /* ignore */ }
  });
  child.unref();
  return {
    child,
    stderrText: () => stderrText,
    hasCidConflict: () => isCidConflictText(stderrText),
  };
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

/** Extract the vsock guest-cid from a qemu -device argument, e.g. "vhost-vsock-device,guest-cid=107" */
export function extractGuestCid(arg: string): number | undefined {
  const m = arg.match(/guest-cid=(\d+)/);
  return m ? Number(m[1]) : undefined;
}

/** Scan all running qemu processes for their vsock guest-cids
 *  (covers VMs started manually or by other sessions, so the next cid can skip them upfront) */
export async function scanOccupiedCids(): Promise<number[]> {
  const out = await execFileAsync("pgrep", ["-f", "qemu-system.*guest-cid="]);
  const cids: number[] = [];
  for (const line of out.trim().split("\n")) {
    const pid = Number(line);
    if (!pid || !isQemuProcess(pid)) continue;
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    for (const arg of cmdline) {
      const cid = extractGuestCid(arg);
      if (cid !== undefined) {
        cids.push(cid);
        break;
      }
    }
  }
  return cids;
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

/** Poll ssh-client until a command succeeds; used for VM readiness probing.
 *  If isConflict() turns true during polling, fail fast (returns false). */
export async function waitForReady(cid: number, timeoutMs: number, isConflict?: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isConflict?.()) return false; // cid conflict detected on the vng process stderr: fail fast
    const { code } = await execSync(cid, "true");
    if (code === 0) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
