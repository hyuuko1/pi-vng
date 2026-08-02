import { execSync as vngExec } from "./vng";
import type { TaskRecord } from "./state";

export const MAX_OUTPUT_CHARS = 100_000;
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface ExecOptions {
  async?: boolean;
  cwd?: string;
  timeoutMs?: number;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

let taskSeq = 0;

export class TaskManager {
  private tasks = new Map<string, TaskRecord & { output?: { stdout: string; stderr: string } }>();

  /** Actual command execution (injectable in tests) */
  execFn: (cid: number, command: string) => Promise<ExecResult> = vngExec;

  /** Completion callback (used by index.ts for reporting) */
  onTaskDone: ((task: TaskRecord, output: ExecResult) => void) | null = null;

  /** Submit a task; async=true or timeout moves it to the background, returning a running task */
  async submit(vm: { name: string; cid: number }, command: string, opts: ExecOptions = {}): Promise<TaskRecord> {
    const id = `t${++taskSeq}`;
    const fullCommand = opts.cwd ? `cd ${opts.cwd} && ${command}` : command;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const record: TaskRecord & { output?: { stdout: string; stderr: string } } = {
      id, vm: vm.name, command: fullCommand, status: "running",
      exitCode: null, startedAt: Date.now(),
    };
    this.tasks.set(id, record);

    // execFn runs exactly once; sync/async/background paths share the same promise
    const execPromise = this.execFn(vm.cid, fullCommand);

    const attachBackground = () => {
      execPromise.then(
        (result) => this.finish(record, result),
        (err) => {
          record.status = "failed";
          record.finishedAt = Date.now();
          this.onTaskDone?.(record, { code: null, stdout: "", stderr: String(err) });
        },
      );
    };

    if (opts.async) {
      record.background = true;
      attachBackground();
      return { ...record }; // running
    }

    // Sync mode: wait for the result or move to background on timeout (the original promise keeps running)
    const result = await Promise.race<ExecResult | null>([
      execPromise,
      new Promise<null>((res) => setTimeout(() => res(null), timeoutMs)),
    ]);
    if (result === null) {
      record.background = true; // moved to background
      attachBackground();
      return { ...record }; // running
    }
    return this.finish(record, result);
  }

  private finish(record: TaskRecord, result: ExecResult): TaskRecord {
    record.status = result.code === 0 ? "done" : "failed";
    record.exitCode = result.code;
    record.finishedAt = Date.now();
    const withOutput = this.tasks.get(record.id)!;
    withOutput.output = {
      stdout: result.stdout.slice(0, MAX_OUTPUT_CHARS),
      stderr: result.stderr.slice(0, MAX_OUTPUT_CHARS),
    };
    this.onTaskDone?.(record, { stdout: withOutput.output.stdout, stderr: withOutput.output.stderr, code: result.code });
    return { ...record };
  }

  get(id: string): TaskRecord | undefined {
    const t = this.tasks.get(id);
    return t ? { ...t } : undefined;
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()].map((t) => ({ ...t }));
  }

  getOutput(id: string): { stdout: string; stderr: string } | undefined {
    return this.tasks.get(id)?.output;
  }

  /** Mark pending tasks of a dead VM as failed */
  markVmDead(vmName: string): void {
    for (const t of this.tasks.values()) {
      if (t.vm === vmName && t.status === "running") {
        t.status = "failed";
        t.finishedAt = Date.now();
      }
    }
  }

  restore(tasks: TaskRecord[]): void {
    for (const t of tasks) this.tasks.set(t.id, t);
  }
}
