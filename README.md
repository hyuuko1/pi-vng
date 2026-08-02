# pi-vng

A [pi](https://github.com/earendil-works/pi) extension that runs [virtme-ng](https://github.com/arighi/virtme-ng) virtual machines in the background and executes commands inside them — designed for long-running development/test loops (kernel testing, test suites, etc.).

## Features

- **Named VMs** — manage VMs by name instead of raw cid numbers
- **Automatic cid management** — vsock guest cids are allocated from 3 upward; on `Address already in use` conflicts (e.g. VMs started manually outside the plugin) the plugin retries with a new cid
- **Async execution with auto-reporting** — long-running commands execute in the background; on completion you get a notification and a message is injected for the LLM
- **Crash monitoring** — unexpected VM exits are detected and reported automatically; pending tasks are marked as failed
- **Lifecycle management** — all plugin-started VMs are cleaned up when pi exits; `/reload`, `/new`, `/resume` keep VMs running (state is persisted to `~/.cache/pi-vng/state.json`)

## Installation

### Local development

Add the project's absolute path to the `packages` array in `~/.pi/agent/settings.json`:

```json
{
  "packages": ["/path/to/pi-vng"]
}
```

### From GitHub

```bash
pi install git:github.com/hyuuko1/pi-vng
```

## Tools

| Tool | Description |
|---|---|
| `vng_start(name, kernel?, args)` | Start a VM in the background and wait until ready. `kernel` is a kernel path or upstream version (omitted to use the host kernel). `args` are arbitrary vng arguments passed through verbatim (`--memory`, `--cpus`, ...). cid conflicts are retried automatically; a stopped VM can be restarted under the same name. |
| `vng_exec(name, command, async?, cwd?)` | Run a command inside a VM. Waits synchronously by default (moves to the background after a 60s timeout and returns a task ID); `async: true` returns a task ID immediately. |
| `vng_task_result(task_id)` | Query the status, exit code and output of an async task. |
| `vng_stop(name)` | Shut down a VM. |
| `vng_list()` | List all VMs and running tasks. |

## Usage examples

Boot a custom kernel and exercise kernel features inside the VM:

```
vng_start {name: "test", kernel: "./arch/x86/boot/bzImage", args: ["--memory", "1G", "--cpus", "2"]}
vng_exec  {name: "test", command: "insmod mymodule.ko && dmesg | tail -20"}  # load a module, check kernel logs
vng_exec  {name: "test", command: "bash /path/to/kselftest.sh", async: true} # long test suite, async
vng_stop  {name: "test"}
```

## How it works

- VMs are started with `vng -r --ssh <cid> --name <name>` and commands run via `vng --ssh-client <cid> --remote-cmd "<command>"`, so the VM stays alive between calls and its filesystem persists.
- Short commands return their output directly through the tool; long commands run in the background and report completion automatically.
- On pi exit (`quit`) all plugin-started VMs are shut down; other session replacements keep them running.

## Development

```bash
bun install
bun test                                                  # unit tests
RUN_VNG_INTEGRATION=1 bun test test/integration.test.ts   # integration tests (requires /dev/kvm)
```
