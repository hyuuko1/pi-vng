import { describe, expect, test, afterAll } from "bun:test";
import { saveState, loadState, statePath } from "../src/state";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("state persistence", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-vng-state-"));
  const file = join(dir, "state.json");

  test("round-trip save and load", () => {
    const state = {
      vms: [{ name: "vm1", cid: 3, status: "running" as const, startedAt: 123, extraArgs: [], kernel: "host" }],
      tasks: [],
      savedAt: 123,
    };
    saveState(file, state);
    const loaded = loadState(file);
    expect(loaded).toEqual(state);
  });

  test("returns null when file is missing", () => {
    expect(loadState(join(dir, "nope.json"))).toBeNull();
  });

  test("returns null on corrupted file", () => {
    const bad = join(dir, "bad.json");
    Bun.write(bad, "{not json");
    expect(loadState(bad)).toBeNull();
  });

  test("statePath points at ~/.cache/pi-vng/state.json", () => {
    expect(statePath()).toMatch(/\.cache\/pi-vng\/state\.json$/);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});
