import { describe, expect, test } from "bun:test";
import { VMManager } from "../src/manager";

describe("VMManager.cid allocation", () => {
  test("increments from 3", () => {
    const m = new VMManager();
    expect(m.nextCid()).toBe(3);
    expect(m.nextCid()).toBe(4);
    expect(m.nextCid()).toBe(5);
  });

  test("skips used cids", () => {
    const m = new VMManager();
    m.markCidUsed(3);
    m.markCidUsed(5);
    expect(m.nextCid()).toBe(4);
    expect(m.nextCid()).toBe(6);
  });

  test("rejects duplicate names", async () => {
    const m = new VMManager();
    m.restore([{ name: "vm1", cid: 3, status: "running", startedAt: 0, extraArgs: [], kernel: "host" }]);
    await expect(m.start("vm1", undefined, [])).rejects.toThrow(/already exists/i);
  });

  test("retries with a new cid on conflict: first 3 attempts fail", async () => {
    const m = new VMManager();
    let attempts = 0;
    m.startVm = async () => {
      attempts++;
      if (attempts <= 3) throw new Error("unable to set guest cid: Address already in use");
    };
    const vm = await m.start("vm1", undefined, []);
    expect(attempts).toBe(4);
    expect(vm.cid).toBe(6); // 3,4,5 externally taken, falls through to 6
  });

  test("stopped VM can be restarted with the same name", async () => {
    const m = new VMManager();
    m.startVm = async () => {};
    const vm1 = await m.start("vm1", undefined, []);
    expect(vm1.status).toBe("running");
    await m.stop("vm1");
    expect(m.get("vm1")!.status).toBe("stopped");
    const vm2 = await m.start("vm1", undefined, []);
    expect(vm2.status).toBe("running");
    expect(vm2.cid).not.toBe(vm1.cid); // gets a fresh cid
    expect(m.get("vm1")!.cid).toBe(vm2.cid);
  });

  test("records the kernel parameter", async () => {
    const m = new VMManager();
    m.startVm = async () => {};
    const vm = await m.start("vm1", "./arch/x86/boot/bzImage", []);
    expect(vm.kernel).toBe("./arch/x86/boot/bzImage");
    const vm2 = await m.start("vm2", undefined, []);
    expect(vm2.kernel).toBe("host");
  });
});
