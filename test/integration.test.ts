import { describe, expect, test } from "bun:test";
import { execSync, findQemuPidByCid, killQemu, spawnDetached, waitForReady } from "../src/vng";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const enabled = !!process.env.RUN_VNG_INTEGRATION;

let cid = 3;
let dir = "";

function nextCid(): number {
  return (cid = 3 + Math.floor(Math.random() * 200));
}

describe.skipIf(!enabled)("vng integration", () => {
  test("start VM, wait ready, exec, stop", async () => {
    cid = nextCid();
    dir = mkdtempSync(join(tmpdir(), "pi-vng-test-"));
    spawnDetached(["-r", "--ssh", String(cid), "--name", `itest${cid}`, "--quiet"], join(dir, "vm.log"));
    try {
      const ready = await waitForReady(cid, 60_000);
      expect(ready).toBe(true);

      const { code, stdout } = await execSync(cid, "uname -r");
      expect(code).toBe(0);
      expect(stdout.trim()).not.toBe("");

      const pid = await findQemuPidByCid(cid);
      expect(pid).toBeDefined();
    } finally {
      await killQemu(cid);
      await new Promise((r) => setTimeout(r, 2000));
      const pid = await findQemuPidByCid(cid);
      expect(pid).toBeUndefined();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test("TaskManager real async task: submit, poll, finish", async () => {
    cid = nextCid();
    dir = mkdtempSync(join(tmpdir(), "pi-vng-test-"));
    spawnDetached(["-r", "--ssh", String(cid), "--name", `itest${cid}`, "--quiet"], join(dir, "vm.log"));
    try {
      const ready = await waitForReady(cid, 60_000);
      expect(ready).toBe(true);

      const { TaskManager } = await import("../src/tasks");
      const m = new TaskManager();
      const task = await m.submit({ name: "itest", cid }, "sleep 2 && echo finished", { async: true });
      expect(task.status).toBe("running");

      const deadline = Date.now() + 30_000;
      let t = m.get(task.id)!;
      while (t.status === "running" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        t = m.get(task.id)!;
      }
      expect(t.status).toBe("done");
      expect(t.exitCode).toBe(0);
      const output = m.getOutput(task.id)!;
      expect(output.stdout).toContain("finished");
    } finally {
      await killQemu(cid);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
