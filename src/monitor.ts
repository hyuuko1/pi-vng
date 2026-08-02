import type { VMManager } from "./manager";

const DEFAULT_INTERVAL_MS = 2_000;

export class Monitor {
  onVmDied: ((name: string, cid: number) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reported = new Set<string>();

  constructor(private mgr: VMManager) {}

  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.checkOnce(), intervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Single liveness check (testable) */
  async checkOnce(): Promise<void> {
    for (const vm of this.mgr.list()) {
      if (vm.status !== "running") continue;
      const pid = await this.mgr.findQemuPid(vm.name);
      if (pid === undefined && !this.reported.has(vm.name)) {
        this.reported.add(vm.name);
        vm.status = "stopped";
        this.onVmDied?.(vm.name, vm.cid);
      }
    }
  }
}
