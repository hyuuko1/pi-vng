import { describe, expect, test } from "bun:test";
import { TaskManager } from "../src/tasks";

describe("TaskManager", () => {
  test("sync task returns the result", async () => {
    const m = new TaskManager();
    m.execFn = async () => ({ code: 0, stdout: "ok\n", stderr: "" });
    const task = await m.submit({ name: "vm1", cid: 3 }, "echo ok", {});
    expect(task.status).toBe("done");
    expect(task.exitCode).toBe(0);
  });

  test("timeout moves to background: task is running after timeoutMs", async () => {
    const m = new TaskManager();
    let resolveExec: (v: { code: number | null; stdout: string; stderr: string }) => void;
    m.execFn = () => new Promise((res) => { resolveExec = res; });
    const task = await m.submit({ name: "vm1", cid: 3 }, "sleep 100", { timeoutMs: 100 });
    expect(task.status).toBe("running");
    resolveExec!({ code: 0, stdout: "late\n", stderr: "" });
    await new Promise((r) => setTimeout(r, 50));
    const t2 = m.get(task.id)!;
    expect(t2.status).toBe("done");
    expect(t2.exitCode).toBe(0);
  });

  test("failed task records the exit code", async () => {
    const m = new TaskManager();
    m.execFn = async () => ({ code: 42, stdout: "", stderr: "boom" });
    const task = await m.submit({ name: "vm1", cid: 3 }, "exit 42", {});
    expect(task.status).toBe("failed");
    expect(task.exitCode).toBe(42);
  });

  test("markVmDead marks pending tasks as failed", async () => {
    const m = new TaskManager();
    let resolveExec: (v: { code: number | null; stdout: string; stderr: string }) => void;
    m.execFn = () => new Promise((res) => { resolveExec = res; });
    const task = await m.submit({ name: "vm1", cid: 3 }, "sleep 100", { timeoutMs: 100 });
    m.markVmDead("vm1");
    const t2 = m.get(task.id)!;
    expect(t2.status).toBe("failed");
  });

  test("cwd wraps the command", async () => {
    const m = new TaskManager();
    let cmd = "";
    m.execFn = async (_cid, command) => { cmd = command; return { code: 0, stdout: "", stderr: "" }; };
    await m.submit({ name: "vm1", cid: 3 }, "make", { cwd: "/src/linux" });
    expect(cmd).toBe("cd /src/linux && make");
  });

  test("async=true returns running immediately, then done", async () => {
    const m = new TaskManager();
    let resolveExec: (v: { code: number | null; stdout: string; stderr: string }) => void;
    m.execFn = () => new Promise((res) => { resolveExec = res; });
    const task = await m.submit({ name: "vm1", cid: 3 }, "make", { async: true });
    expect(task.status).toBe("running");
    expect(task.background).toBe(true);
    resolveExec!({ code: 0, stdout: "built\n", stderr: "" });
    await new Promise((r) => setTimeout(r, 50));
    expect(m.get(task.id)!.status).toBe("done");
  });

  test("sync task has background undefined (no message injection)", async () => {
    const m = new TaskManager();
    m.execFn = async () => ({ code: 0, stdout: "ok\n", stderr: "" });
    const task = await m.submit({ name: "vm1", cid: 3 }, "echo ok", {});
    expect(task.background).toBeUndefined();
  });

  test("timed-out background task has background=true", async () => {
    const m = new TaskManager();
    let resolveExec: (v: { code: number | null; stdout: string; stderr: string }) => void;
    m.execFn = () => new Promise((res) => { resolveExec = res; });
    const task = await m.submit({ name: "vm1", cid: 3 }, "sleep 100", { timeoutMs: 100 });
    expect(task.status).toBe("running");
    expect(task.background).toBe(true);
  });
});
