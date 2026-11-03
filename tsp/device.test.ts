import { describe, expect, test } from "bun:test";
import type { Out } from "../Agent.ts";
import type { Job } from "../Machine.ts";
import * as View from "../View.ts";
import { DeviceJobs, deviceQuery, localDevice, type DeviceRuntime } from "./device.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const shell = (id: string) => ({ $: "job", id, job: { name: "shell", cwd: "main", input: { command: "echo owned" } } }) as const;

describe("native UniiChat device identity", () => {
  test("uses Term.ts's encoded device, computer and work parameters", () => {
    const device = localDevice({ UNII_WORK: "/a dir/x&y", UNII_COMPUTER: "1" }, "linux", "host name", "");
    expect(device).toEqual({ name: "host name", work: "/a dir/x&y", computer: true });
    expect(deviceQuery(device)).toBe("&device=host%20name&computer=1&work=%2Fa%20dir%2Fx%26y");
    expect(localDevice({}, "darwin", "host", "bonjour")).toEqual({
      name: "bonjour", work: "~/.unii/work", computer: false,
    });
    expect(localDevice({ UNII_COMPUTER: "true" }, "linux", "host", "").computer).toBe(false);
  });
});

describe("native device jobs", () => {
  test("executes once, keeps output pending across reconnect, and honors server ACK", async () => {
    const view = View.view_new();
    const calls: string[] = [];
    let ends = 0;
    const runtime: DeviceRuntime = {
      run: async (job, work) => { calls.push(job.name + ":" + work); return { text: "owned", fail: false }; },
      end: () => { ends++; },
    };
    const sent: View.Client[] = [];
    const jobs = new DeviceJobs(view, (msg) => {
      sent.push(msg);
      View.link_send(view, msg);
    }, { name: "local", work: "/tmp/owned", computer: false }, runtime);
    jobs.hear(shell("a"));
    jobs.hear(shell("a"));
    await tick();
    expect(calls).toEqual(["shell:/tmp/owned"]);
    expect(sent).toEqual([{ $: "out", job: "a", out: { text: "owned", fail: false } }]);
    // A reconnect replays the same server job; pending, unacknowledged
    // output is resent by View.link_open, not executed a second time.
    jobs.hear(shell("a"));
    expect(calls).toHaveLength(1);
    const id = view.out[0]?.msg.id;
    expect(id).toBeDefined();
    View.view_hear(view, { $: "ack", id: id!, ok: true } as View.Server);
    expect(view.out).toEqual([]);
    jobs.close();
    jobs.close();
    expect(ends).toBe(1);
  });

  test("rejects screen access unless UNII_COMPUTER=1, with no runner call", async () => {
    let ran = 0;
    const sent: View.Client[] = [];
    const runtime: DeviceRuntime = { run: async () => { ran++; return { text: "", fail: false }; }, end: () => {} };
    const jobs = new DeviceJobs(View.view_new(), (msg) => sent.push(msg),
      { name: "host", work: "/owned", computer: false }, runtime);
    jobs.hear({ $: "job", id: "screen", job: { name: "computer", input: { action: "screenshot" }, cwd: "main" } });
    await tick();
    expect(ran).toBe(0);
    expect(sent).toEqual([{ $: "out", job: "screen",
      out: { text: "This terminal does no computer use.", fail: true } }]);
    jobs.close();
  });

  test("server's jobs list cancels removed work; close aborts and drops late output", async () => {
    const active: { job: Job; signal: AbortSignal; resolve: (out: Out) => void }[] = [];
    let ends = 0;
    const runtime: DeviceRuntime = {
      run: (job, _work, signal) => new Promise((resolve) => active.push({ job, signal, resolve })),
      end: () => { ends++; },
    };
    const sent: View.Client[] = [];
    const jobs = new DeviceJobs(View.view_new(), (msg) => sent.push(msg),
      { name: "host", work: "/owned", computer: false }, runtime);
    jobs.hear(shell("first"));
    jobs.hear(shell("second"));
    expect(active).toHaveLength(2);
    jobs.hear({ $: "jobs", ids: ["second"] });
    expect(active[0]?.signal.aborted).toBe(true);
    expect(active[1]?.signal.aborted).toBe(false);
    active[0]!.resolve({ text: "stopped", fail: true });
    await tick();
    expect(sent).toEqual([{ $: "out", job: "first", out: { text: "stopped", fail: true } }]);
    jobs.close();
    expect(active[1]?.signal.aborted).toBe(true);
    active[1]!.resolve({ text: "late", fail: false });
    await tick();
    expect(sent).toHaveLength(1);
    expect(ends).toBe(1);
  });

  test("bounds output before the wire frame and reports malformed jobs", async () => {
    const sent: View.Client[] = [];
    const jobs = new DeviceJobs(View.view_new(), (msg) => sent.push(msg),
      { name: "host", work: "/owned", computer: true },
      { run: async () => ({ text: "x".repeat(View.FRAME), fail: false }), end: () => {} });
    jobs.hear(shell("large"));
    jobs.hear({ $: "job", id: "invalid", job: { name: "shell" } });
    await tick();
    const large = sent.find((s) => s.$ === "out" && s.job === "large");
    expect(large?.$).toBe("out");
    if (large?.$ === "out") {
      expect(large.out).toMatchObject({ fail: true });
      expect((large.out as { text: string }).text).toContain(String(View.FRAME - 1024));
    }
    const invalid = sent.find((s) => s.$ === "out" && s.job === "invalid");
    expect(invalid?.$ === "out" && (invalid.out as { fail: boolean }).fail).toBe(true);
    jobs.close();
  });
});
