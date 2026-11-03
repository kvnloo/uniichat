// The native Tern pane is a UniiChat device, just like Term.ts. The server
// selects jobs; View.ts owns wire delivery and acknowledgement.
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import type { Out } from "../Agent.ts";
import { Machine, type Job } from "../Machine.ts";
import * as View from "../View.ts";

export type LocalDevice = { name: string; work: string; computer: boolean };
export type DeviceRuntime = {
  run(job: Job, work: string, signal: AbortSignal): Promise<Out>;
  end(): void;
};

const MACHINE: DeviceRuntime = { run: Machine.run, end: Machine.end };

// Match Term.ts: macOS Bonjour LocalHostName first, then the system hostname.
// The screen permission is opt-in; absent UNII_COMPUTER=1 never grants it.
export function localDevice(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  host: string = hostname(),
  local: string = platform === "darwin" ? spawnSync("scutil", ["--get", "LocalHostName"]).stdout?.toString().trim() ?? "" : "",
): LocalDevice {
  return {
    name: local || host,
    computer: env.UNII_COMPUTER === "1",
    work: env.UNII_WORK || "~/.unii/work",
  };
}

export function deviceQuery(device: LocalDevice): string {
  return "&device=" + encodeURIComponent(device.name) +
    "&computer=" + (device.computer ? "1" : "0") +
    "&work=" + encodeURIComponent(device.work);
}

function jobValue(value: unknown): Job | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const job = value as Partial<Job>;
  return typeof job.name === "string" && typeof job.cwd === "string" &&
    typeof job.input === "object" && job.input !== null ? job as Job : null;
}

// Acknowledged or still pending output must not be executed again on reconnect.
// Only the server's jobs list cancels running work; a transient socket loss
// must not kill a tool whose result the server will recover.
export class DeviceJobs {
  readonly running = new Map<string, AbortController>();
  readonly device: LocalDevice;
  #closed = false;

  constructor(
    private readonly view: View.View,
    private readonly send: (msg: View.Client) => void,
    device: LocalDevice = localDevice(),
    private readonly runtime: DeviceRuntime = MACHINE,
  ) {
    this.device = device;
  }

  get query(): string {
    return deviceQuery(this.device);
  }

  hear(msg: Extract<View.Server, { $: "job" | "jobs" }>): void {
    if (this.#closed) {
      return;
    }
    if (msg.$ === "jobs") {
      const wanted = new Set(msg.ids);
      for (const [id, abort] of this.running) {
        if (!wanted.has(id)) {
          abort.abort();
        }
      }
      return;
    }
    const pending = this.view.out.some((post) => post.msg.$ === "out" && post.msg.job === msg.id);
    if (!this.running.has(msg.id) && !pending) {
      void this.#run(msg.id, jobValue(msg.job));
    }
  }

  async #run(id: string, job: Job | null): Promise<void> {
    const abort = new AbortController();
    this.running.set(id, abort);
    let out: Out;
    try {
      if (!job) {
        out = { text: "Invalid device job.", fail: true };
      } else if (job.name === "computer" && !this.device.computer) {
        out = { text: "This terminal does no computer use.", fail: true };
      } else {
        out = await this.runtime.run(job, this.device.work, abort.signal);
      }
    } catch (reason) {
      out = { text: String(reason instanceof Error ? reason.message : reason), fail: true };
    } finally {
      this.running.delete(id);
    }

    if (this.#closed) {
      return;
    }
    const size = Buffer.byteLength(JSON.stringify(out));
    const most = View.FRAME - 1024;
    const result = size > most
      ? { text: "The output, " + size + " bytes, is over the " + most + " a tool may send.", fail: true }
      : out;
    this.send({ $: "out", job: id, out: result });
  }

  // Called on explicit quit, native input EOF, surface failure and signals.
  // Machine.end also kills detached grandchildren with this process's UNII_RUN.
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const abort of this.running.values()) {
      abort.abort();
    }
    this.running.clear();
    this.runtime.end();
  }
}
