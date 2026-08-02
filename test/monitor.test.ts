import { describe, expect, test } from "bun:test";
import { Monitor } from "../src/monitor";
import { VMManager } from "../src/manager";

describe("Monitor", () => {
  test("detects a dead VM and fires the callback once", async () => {
    const mgr = new VMManager();
    mgr.restore([{ name: "vm1", cid: 3, status: "running", startedAt: 0, extraArgs: [], kernel: "host" }]);
    const mon = new Monitor(mgr);
    let died = 0;
    let deadName = "";
    mon.onVmDied = (name) => { died++; deadName = name; };

    // report the process as alive first, then as gone -> death callback fires
    (mgr as any).findQemuPid = async () => 1234;
    await mon.checkOnce();
    expect(died).toBe(0);

    (mgr as any).findQemuPid = async () => undefined;
    await mon.checkOnce();
    expect(died).toBe(1);
    expect(deadName).toBe("vm1");

    // a second check does not re-report
    await mon.checkOnce();
    expect(died).toBe(1);
  });

  test("starting VMs do not trigger death reports", async () => {
    const mgr = new VMManager();
    mgr.restore([{ name: "vm2", cid: 4, status: "starting", startedAt: 0, extraArgs: [], kernel: "host" }]);
    const mon = new Monitor(mgr);
    let died = 0;
    mon.onVmDied = () => { died++; };
    (mgr as any).findQemuPid = async () => undefined;
    await mon.checkOnce();
    expect(died).toBe(0);
  });

  test("stopped VMs do not trigger", async () => {
    const mgr = new VMManager();
    mgr.restore([{ name: "vm3", cid: 5, status: "stopped", startedAt: 0, extraArgs: [], kernel: "host" }]);
    const mon = new Monitor(mgr);
    let died = 0;
    mon.onVmDied = () => { died++; };
    (mgr as any).findQemuPid = async () => undefined;
    await mon.checkOnce();
    expect(died).toBe(0);
  });

  test("stopping VMs do not trigger death reports (intentional stop)", async () => {
    const mgr = new VMManager();
    mgr.restore([{ name: "vm4", cid: 6, status: "stopping", startedAt: 0, extraArgs: [], kernel: "host" }]);
    const mon = new Monitor(mgr);
    let died = 0;
    mon.onVmDied = () => { died++; };
    (mgr as any).findQemuPid = async () => undefined;
    await mon.checkOnce();
    expect(died).toBe(0);
  });

  test("a restarted VM is reported again after its second death", async () => {
    const mgr = new VMManager();
    mgr.restore([{ name: "vm5", cid: 7, status: "running", startedAt: 0, extraArgs: [], kernel: "host" }]);
    const mon = new Monitor(mgr);
    let died = 0;
    mon.onVmDied = () => { died++; };

    (mgr as any).findQemuPid = async () => undefined;
    await mon.checkOnce();
    expect(died).toBe(1); // first death reported

    (mgr as any).findQemuPid = async () => 1234; // restarted, alive again
    await mon.checkOnce();
    expect(died).toBe(1); // alive: no report, dedup reset

    (mgr as any).findQemuPid = async () => undefined;
    await mon.checkOnce();
    expect(died).toBe(2); // second death reported again
  });
});
