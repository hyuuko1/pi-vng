import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { VmRecord } from "./manager";

export interface TaskRecord {
  id: string;
  vm: string;
  command: string;
  status: "running" | "done" | "failed";
  exitCode: number | null;
  startedAt: number;
  finishedAt?: number;
  /** Background task (async=true or timed-out into background): a completion message is injected. Sync results are already returned by the tool, so no injection. */
  background?: boolean;
}

export interface PersistedState {
  vms: VmRecord[];
  tasks: TaskRecord[];
  savedAt: number;
}

export function statePath(): string {
  return join(homedir(), ".cache", "pi-vng", "state.json");
}

export function saveState(file: string, state: PersistedState): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
}

export function loadState(file: string): PersistedState | null {
  try {
    const raw = readFileSync(file, "utf8");
    return JSON.parse(raw) as PersistedState;
  } catch {
    return null;
  }
}
