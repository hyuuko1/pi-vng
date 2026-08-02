import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { rmSync } from "node:fs";
import { VMManager } from "./manager";
import { TaskManager } from "./tasks";
import { Monitor } from "./monitor";
import { loadState, saveState, statePath, type PersistedState } from "./state";

export type VngStartInput = Static<typeof vngStartSchema>;
export type VngExecInput = Static<typeof vngExecSchema>;
export type VngTaskResultInput = Static<typeof vngTaskResultSchema>;
export type VngStopInput = Static<typeof vngStopSchema>;

/** Current session ctx (set on session_start, cleared on session_shutdown); used for report injection */
let currentCtx: ExtensionContext | undefined;

const vngStartSchema = Type.Object({
  name: Type.String({ description: "VM name (unique identifier, used to reference the VM in later calls)" }),
  kernel: Type.Optional(Type.String({ description: "Kernel path (e.g. ./arch/x86/boot/bzImage) or upstream version (e.g. v6.6.17); empty/omitted uses the host kernel" })),
  args: Type.Array(Type.String({
    description: "Arbitrary vng arguments passed through verbatim, e.g. [\"--memory\", \"1G\", \"--cpus\", \"2\"]; --ssh/--name are managed automatically",
  }), { default: [] }),
});

const vngExecSchema = Type.Object({
  name: Type.String({ description: "VM name" }),
  command: Type.String({ description: "Command to run inside the VM (shell syntax)" }),
  async: Type.Optional(Type.Boolean({ description: "true returns a task ID immediately and runs in the background" })),
  cwd: Type.Optional(Type.String({ description: "Working directory inside the VM; defaults to the VM's start directory" })),
});

const vngTaskResultSchema = Type.Object({
  task_id: Type.String({ description: "Task ID returned by vng_exec" }),
});

const vngStopSchema = Type.Object({
  name: Type.String({ description: "VM name" }),
});

const vngListSchema = Type.Object({});

export default function (pi: ExtensionAPI) {
  const mgr = new VMManager();
  const tasks = new TaskManager();
  const monitor = new Monitor(mgr);

  // ---- Report injection ----
  // sendUserMessage is a pi-level API (no ctx needed); notify needs ctx.

  tasks.onTaskDone = (task, output) => {
    const summary = summarizeOutput(output.stdout || output.stderr);
    const text = `[pi-vng] VM "${task.vm}" task finished: ${task.command} (exit ${task.exitCode})\n${summary}`;
    currentCtx?.ui.notify(text, "info"); // always notify the user
    if (task.background) {
      // Only background tasks inject a message for the LLM (sync results were already returned by the tool)
      sendUserMessageSafe(pi, text);
    }
  };

  monitor.onVmDied = (name, cid) => {
    tasks.markVmDead(name);
    const text = `[pi-vng] VM "${name}" (cid=${cid}) exited unexpectedly, it may have crashed; its pending tasks were marked as failed.`;
    currentCtx?.ui.notify(text, "warning");
    // Steer delivery: interrupt the current turn so the LLM learns about the crash immediately
    if (currentCtx?.isIdle()) {
      pi.sendUserMessage(text);
    } else {
      pi.sendUserMessage(text, { deliverAs: "steer" });
    }
  };

  // ---- Tools ----
  pi.registerTool({
    name: "vng_start",
    label: "VNG Start VM",
    description:
      "Start a virtme-ng VM in the background and wait until it is ready. name is a unique identifier; kernel is a kernel path (e.g. \"./arch/x86/boot/bzImage\") or upstream version, omitted to use the host kernel; args are arbitrary vng arguments (e.g. [\"--memory\",\"1G\"]); --ssh/--name are managed automatically. cid conflicts are retried with a new cid. Returns VM info.",
    parameters: vngStartSchema,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const vm = await mgr.start(params.name, params.kernel, params.args ?? []);
        const text = `[pi-vng] VM "${vm.name}" is ready (cid=${vm.cid}, kernel=${vm.kernel})`;
        ctx.ui.notify(text, "info");
        return {
          content: [{ type: "text", text: text + "\n" + JSON.stringify(vm, null, 2) }],
          details: { vm },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Start failed: ${(err as Error).message}` }], isError: true, details: {} };
      }
    },
  });

  pi.registerTool({
    name: "vng_exec",
    label: "VNG Exec",
    description:
      "Run a command inside a VM. By default waits synchronously (moves to the background after a 60s timeout and returns a task ID); async=true returns a task ID immediately. Task completion is reported automatically.",
    parameters: vngExecSchema,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const vm = mgr.get(params.name);
      if (!vm) {
        return { content: [{ type: "text", text: `VM "${params.name}" does not exist, use vng_list to see available VMs` }], isError: true, details: {} };
      }
      const task = await tasks.submit(vm, params.command, {
        async: params.async ?? false,
        cwd: params.cwd,
      });
      if (task.status === "running") {
        return {
          content: [{ type: "text", text: `Task running in the background: task_id=${task.id} (VM "${params.name}", command: ${params.command}). Completion will be reported automatically; use vng_task_result to query it.` }],
          details: { task },
        };
      }
      const output = tasks.getOutput(task.id);
      const out = output ? summarizeOutput(output.stdout || output.stderr) : "";
      return {
        content: [{ type: "text", text: `Task finished (exit ${task.exitCode})\n${out}` }],
        details: { task, output },
      };
    },
  });

  pi.registerTool({
    name: "vng_task_result",
    label: "VNG Task Result",
    description: "Query the status, exit code and output of an async task.",
    parameters: vngTaskResultSchema,
    async execute(_id, params, _signal, _onUpdate) {
      const task = tasks.get(params.task_id);
      if (!task) return { content: [{ type: "text", text: `Task ${params.task_id} does not exist` }], isError: true, details: {} };
      const output = tasks.getOutput(params.task_id);
      return {
        content: [{ type: "text", text: `task ${task.id}: ${task.status} (exit ${task.exitCode})\n${output ? summarizeOutput(output.stdout || output.stderr) : ""}` }],
        details: { task, output },
      };
    },
  });

  pi.registerTool({
    name: "vng_stop",
    label: "VNG Stop VM",
    description: "Shut down a VM (kills qemu; the process chain exits on its own).",
    parameters: vngStopSchema,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        await mgr.stop(params.name);
        const text = `[pi-vng] VM "${params.name}" stopped`;
        ctx.ui.notify(text, "info");
        return { content: [{ type: "text", text }], details: {} };
      } catch (err) {
        return { content: [{ type: "text", text: `Stop failed: ${(err as Error).message}` }], isError: true, details: {} };
      }
    },
  });

  pi.registerTool({
    name: "vng_list",
    label: "VNG List VMs",
    description: "List all VMs (name, cid, status, kernel, start time) and running tasks.",
    parameters: vngListSchema,
    async execute() {
      const vms = mgr.list().map(({ name, cid, status, kernel, startedAt }) => ({ name, cid, status, kernel, startedAt }));
      const runningTasks = tasks.list().filter((t) => t.status === "running");
      const text = JSON.stringify({ vms, runningTasks }, null, 2);
      return { content: [{ type: "text", text }], details: { vms, runningTasks } };
    },
  });

  // ---- Lifecycle ----
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    const saved = loadState(statePath());
    if (saved) {
      mgr.restore(saved.vms.filter((v) => v.status !== "stopped" && v.status !== "stopping"));
      tasks.restore(saved.tasks.filter((t) => t.status === "running"));
      // Liveness is re-verified by the monitor's first checkOnce
    }
    monitor.start();
  });

  pi.on("session_shutdown", async (event) => {
    currentCtx = undefined;
    if (event.reason === "quit") {
      // Clean up all VMs started by this plugin
      for (const vm of mgr.list()) {
        if (vm.status === "running") {
          await mgr.stop(vm.name);
        }
      }
      try { rmSync(statePath(), { force: true }); } catch { /* ignore */ }
    } else {
      // reload/new/resume/fork: keep VMs running and persist state
      const state: PersistedState = {
        vms: mgr.list().map(({ name, cid, status, startedAt, extraArgs, kernel }) => ({ name, cid, status, startedAt, extraArgs, kernel })),
        tasks: tasks.list().map(({ id, vm, command, status, exitCode, startedAt, finishedAt }) => ({ id, vm, command, status, exitCode, startedAt, finishedAt })),
        savedAt: Date.now(),
      };
      saveState(statePath(), state);
    }
    monitor.stop();
  });
}

function summarizeOutput(out: string): string {
  const max = 2_000;
  return out.length > max ? out.slice(0, max) + `\n...(output truncated, ${out.length} chars total)` : out;
}

/** Inject a user message for the LLM: trigger immediately when idle, queue as followUp while busy */
function sendUserMessageSafe(pi: ExtensionAPI, text: string): void {
  if (currentCtx?.isIdle()) {
    pi.sendUserMessage(text);
  } else {
    pi.sendUserMessage(text, { deliverAs: "followUp" });
  }
}
