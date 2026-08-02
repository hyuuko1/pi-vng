import { describe, expect, test } from "bun:test";
import { buildStartArgs, buildExecArgs, isCidConflictText } from "../src/vng";

describe("buildStartArgs", () => {
  test("injects --ssh cid and --name", () => {
    const args = buildStartArgs(3, "testvm", undefined, []);
    expect(args).toEqual(["-r", "--ssh", "3", "--name", "testvm"]);
  });

  test("kernel path follows -r directly", () => {
    const args = buildStartArgs(3, "testvm", "./arch/x86/boot/bzImage", []);
    expect(args).toEqual(["-r", "./arch/x86/boot/bzImage", "--ssh", "3", "--name", "testvm"]);
  });

  test("passes through extra args", () => {
    const args = buildStartArgs(5, "vm2", undefined, ["--memory", "1G", "--cpus", "2"]);
    expect(args).toEqual(["-r", "--ssh", "5", "--name", "vm2", "--memory", "1G", "--cpus", "2"]);
  });

  test("drops user-passed --ssh/--name (plugin-managed)", () => {
    const args = buildStartArgs(3, "testvm", undefined, ["--ssh", "99", "--name", "hacked"]);
    expect(args).toEqual(["-r", "--ssh", "3", "--name", "testvm"]);
  });
});

describe("buildExecArgs", () => {
  test("builds ssh-client remote-cmd", () => {
    expect(buildExecArgs(3, "uname -a")).toEqual([
      "--ssh-client", "3", "--remote-cmd", "uname -a",
    ]);
  });
});

describe("isCidConflictText", () => {
  test("detects the vsock cid conflict message", () => {
    expect(isCidConflictText("qemu-system-x86_64: -device vhost-vsock-device: unable to set guest cid: Address already in use")).toBe(true);
  });

  test("rejects unrelated errors", () => {
    expect(isCidConflictText("qemu-system-x86_64: failed to open /dev/kvm")).toBe(false);
    expect(isCidConflictText("")).toBe(false);
  });
});
