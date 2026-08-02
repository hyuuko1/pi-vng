import { spawnDetached, waitForReady, killQemu, findQemuPidByCid, buildStartArgs, isCidConflictText, scanOccupiedCids } from "./vng";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface VmRecord {
  name: string;
  cid: number;
  status: "starting" | "running" | "stopping" | "stopped";
  startedAt: number;
  extraArgs: string[];
  kernel: string; // "host" or a user-specified kernel path
}

export const CID_START = 3;
export const CID_MAX_ATTEMPTS = 20;
export const READY_TIMEOUT_MS = 60_000;
/** After readiness, wait this long before trusting it: a conflicting qemu dies within ~1s
 *  (measured ~760ms), so this lets the vng chain exit and reveals the conflict instead of
 *  mistaking a probe that connected to someone else's VM on the same cid for success. */
export const READY_GRACE_MS = 1_500;

export class VMManager {
  private vms = new Map<string, VmRecord>();
  private usedCids = new Set<number>();
  private lastCid = CID_START - 1; // allocation cursor, increments from 3

  /** Actual vng startup logic (injectable in tests) */
  startVm = async (cid: number, name: string, kernel: string | undefined, extraArgs: string[], logPath: string): Promise<void> => {
    const proc = spawnDetached(buildStartArgs(cid, name, kernel, extraArgs), logPath);
    // Fail fast once the vng process exits (qemu dies on a cid conflict, taking the chain down with it)
    const ready = await waitForReady(cid, READY_TIMEOUT_MS, () => proc.child.exitCode !== null);
    if (ready) {
      // Grace period: a conflicting qemu dies within ~1s. Without it, a readiness probe that
      // connected to another VM on the same cid would be mistaken for our VM being ready.
      await new Promise((r) => setTimeout(r, READY_GRACE_MS));
    }
    if (proc.child.exitCode !== null) {
      // vng exited before becoming ready: startup failed (typically a cid conflict)
      if (proc.hasCidConflict()) {
        throw new Error("unable to set guest cid: Address already in use");
      }
      const stderr = proc.stderrText().trim();
      throw new Error(`vng exited early (code ${proc.child.exitCode})${stderr ? `: ${stderr.slice(0, 500)}` : ""}`);
    }
    if (!ready) throw new Error(`VM ${name} failed to become ready within 60s`);
  };

  /** Allocate the next free cid (>= 3, incrementing from the last allocation, skipping used ones) */
  nextCid(): number {
    let cid = this.lastCid + 1;
    while (this.usedCids.has(cid)) cid++;
    this.lastCid = cid;
    return cid;
  }

  /** Mark a cid as taken (called after an external conflict is detected) */
  markCidUsed(cid: number): void {
    this.usedCids.add(cid);
  }

  /** Discover cids occupied by running qemu VMs (started manually or by other sessions) and mark them used */
  async discoverOccupiedCids(): Promise<number[]> {
    const cids = await scanOccupiedCids();
    for (const c of cids) this.markCidUsed(c);
    return cids;
  }

  /** Start a VM, retrying with a new cid on vsock conflicts. A stopped VM can be restarted under the same name. */
  async start(name: string, kernel: string | undefined, extraArgs: string[]): Promise<VmRecord> {
    const existing = this.vms.get(name);
    if (existing && existing.status !== "stopped") throw new Error(`VM "${name}" already exists`);
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < CID_MAX_ATTEMPTS; attempt++) {
      const cid = this.nextCid();
      const record: VmRecord = {
        name, cid, status: "starting", startedAt: Date.now(), extraArgs, kernel: kernel ?? "host",
      };
      const logPath = join(this.logDir(), `${name}-${cid}.log`);
      try {
        this.vms.set(name, record);
        this.usedCids.add(cid);
        await this.startVm(cid, name, kernel, extraArgs, logPath);
        record.status = "running";
        return record;
      } catch (err) {
        this.vms.delete(name);
        lastErr = err as Error;
        if (isCidConflict(err)) {
          this.markCidUsed(cid); // taken by an external VM (e.g. started manually); skip for this session
          continue;
        }
        this.usedCids.delete(cid);
        throw err;
      }
    }
    throw new Error(`VM "${name}" failed to start after ${CID_MAX_ATTEMPTS} cid conflicts\n${lastErr?.message ?? ""}`);
  }

  /** Stop a VM by killing qemu (the virtme-run/vng chain exits on its own) */
  async stop(name: string): Promise<void> {
    const vm = this.vms.get(name);
    if (!vm) throw new Error(`VM "${name}" does not exist`);
    vm.status = "stopping"; // monitor skips this state, so no spurious crash report
    await killQemu(vm.cid);
    vm.status = "stopped";
  }

  get(name: string): VmRecord | undefined {
    return this.vms.get(name);
  }

  list(): VmRecord[] {
    return [...this.vms.values()];
  }

  /** Restore records on session_start; liveness is re-checked by the monitor */
  restore(records: VmRecord[]): void {
    for (const r of records) {
      this.vms.set(r.name, r);
      this.usedCids.add(r.cid);
      this.lastCid = Math.max(this.lastCid, r.cid);
    }
  }

  findQemuPid(name: string): Promise<number | undefined> {
    const vm = this.vms.get(name);
    return vm ? findQemuPidByCid(vm.cid) : Promise.resolve(undefined);
  }

  private logDir(): string {
    const dir = join(homedir(), ".cache", "pi-vng");
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}

/** Whether the error is a vsock cid conflict */
export function isCidConflict(err: unknown): boolean {
  return err instanceof Error && isCidConflictText(err.message);
}
