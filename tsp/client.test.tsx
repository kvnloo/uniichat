// Integration contract: a real @stencil-hq/tern Session and a local Unii
// WebSocket/HTTP peer. No account, provider, GUI or user home is accessed.
import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { Session, type Surface } from "@stencil-hq/tern";
import type { Out } from "../Agent.ts";
import type { Job } from "../Machine.ts";
import { NativeChat } from "./client.tsx";
import type { DeviceRuntime } from "./device.ts";

const INPUT = "dock.composer.line.input";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function until(ready: () => boolean, ms = 3500): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error("Loopback peer did not reach expected state");
    }
    await Bun.sleep(10);
  }
}

type WireMessage = Record<string, unknown>;
type Frame = { sf: string; s: number; ops: unknown[] };

async function withNative(
  check: (ctx: {
    app: NativeChat;
    tern: Session;
    frames: Frame[];
    sockets: Set<unknown>;
    received: WireMessage[];
    uploads: string[];
    queries: URLSearchParams[];
    send(message: WireMessage): void;
    lose(code?: number): void;
    event(event: WireMessage): void;
  }) => Promise<void>,
  runtime: DeviceRuntime = { run: async () => ({ text: "owned", fail: false }), end: () => {} },
): Promise<void> {
  const input = new EventEmitter();
  const frames: Frame[] = [];
  const sockets = new Set<{
    send(text: string): void;
    close(code?: number): void;
  }>();
  const received: WireMessage[] = [];
  const uploads: string[] = [];
  const queries: URLSearchParams[] = [];
  const authorization: string[] = [];

  const tern = new Session(input, {
    write(bytes) {
      const data = Buffer.from(bytes).toString();
      for (const chunk of data.split("\x1b_tsp;").slice(1)) {
        if (chunk[0] !== "f") continue;
        const frame = JSON.parse(chunk.slice(2).split("\x1b\\")[0]!) as Frame;
        frames.push(frame);
        // This is a real ACK for a frame actually received, not a
        // synthetic credit or an application-level acknowledgement.
        queueMicrotask(() => input.emit("data",
          "\x1b_tsp;e;" + JSON.stringify({ ev: "ack", sf: frame.sf, s: frame.s }) + "\x1b\\"));
      }
    },
  }, { exitHooks: false, record: "" });

  const handshake = tern.handshake();
  input.emit("data", "\x1b_tsp;r;" + JSON.stringify({
    ...tern.caps, r: "hello", v: 1, term: "owned-loopback", ver: "0",
    features: ["edit", "undo", "send"], credits: 16, apc: 1048576,
  }) + "\x1b\\");
  expect(await handshake).toBe(true);

  const server = Bun.serve<{ peer: string }>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        queries.push(url.searchParams);
        authorization.push(req.headers.get("authorization") ?? "");
        if (server.upgrade(req, { data: { peer: "owned" } })) {
          return undefined;
        }
        return new Response("not a websocket", { status: 400 });
      }
      if (url.pathname === "/api/me") {
        return Response.json({ ok: true });
      }
      if (url.pathname === "/api/act") {
        uploads.push(await req.text());
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.send(JSON.stringify({ $: "view", parts: [], turn: 0 }));
        ws.send(JSON.stringify({
          $: "state", busy: false, wait: "", agents: [], pick: null,
          vendors: [], models: [], bills: false, credits: null, importing: null,
        }));
      },
      message(ws, bytes) {
        const msg = JSON.parse(String(bytes)) as WireMessage;
        received.push(msg);
        if (msg.$ !== "out") {
          ws.send(JSON.stringify({ $: "ack", id: msg.id, ok: true }));
        }
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });

  const app = new NativeChat(tern, "http://127.0.0.1:" + server.port,
    { authorization: "Bearer owned-loopback" },
    { device: { name: "owned host", work: "/tmp/owned unii", computer: false }, runtime });
  const running = app.run();

  const ctx = {
    app, tern, frames, sockets: sockets as Set<unknown>, received, uploads, queries,
    send(message: WireMessage) {
      for (const socket of sockets) socket.send(JSON.stringify(message));
    },
    lose(code = 1001) {
      for (const socket of sockets) socket.close(code);
    },
    event(event: WireMessage) {
      input.emit("data", "\x1b_tsp;e;" + JSON.stringify(event) + "\x1b\\");
    },
  };
  try {
    await until(() => app.view.up && frames.length > 0);
    await check(ctx);
  } finally {
    app.stop();
    await running;
    server.stop(true);
  }
}

function dispatch(surface: Surface, payload: WireMessage): void {
  const callback = surface.dispatch({ ...payload, sf: surface.id, raw: {} } as any);
  expect(callback).toBeDefined();
  void callback?.();
}

describe("NativeChat on pinned Tern SDK with owned Unii wire", () => {
  test("registers its device and handles editor edit, atomic submit, ACK, stream and stop", async () => {
    await withNative(async ({ app, tern, frames, queries, uploads, send, received }) => {
      const params = queries[0]!;
      expect(params.get("tab")).toBe(app.view.tab);
      expect(params.get("wire")).toBe("2");
      expect(params.get("device")).toBe("owned host");
      expect(params.get("work")).toBe("/tmp/owned unii");
      expect(params.get("computer")).toBe("0");

      const surface = tern.surfaces[0]!;
      dispatch(surface, { ev: "edit", id: INPUT, from: 0, to: 0,
        text: "first\nsecond", cursor: 12, len: 0 });
      expect(app.editor.text).toBe("first\nsecond");
      dispatch(surface, { ev: "send", id: INPUT, text: "first\nsecond" });
      await until(() => uploads.length === 1);
      expect(uploads).toEqual(["first\nsecond"]);
      expect(app.editor.text).toBe("");
      await until(() => app.view.out.length === 0);

      send({ $: "delta", kind: "unii", text: "Stream" });
      send({ $: "delta", kind: "unii", text: "ed" });
      await until(() => app.view.live[0]?.text === "Streamed");
      await tick();
      expect(JSON.stringify(frames)).toContain("Streamed");

      send({ $: "state", busy: true, wait: "", agents: [], pick: null,
        vendors: [], models: [], bills: false, credits: null, importing: null });
      await until(() => app.view.busy);
      app.editor.set("an unsent draft");
      app.changed();
      await tick();
      dispatch(tern.surfaces[0]!, { ev: "action", id: "dock.working.stop", act: "click" });
      await until(() => received.some((m) => m.$ === "stop" && m.name === "Unii's turn"));
      expect(app.editor.text).toBe("an unsent draft");
    });
  });

  test("executes one job, emits bounded canonical output, cancels by jobs, and survives socket reconnect", async () => {
    const running: { signal: AbortSignal; resolve: (out: Out) => void; job: Job }[] = [];
    let cleanup = 0;
    await withNative(async ({ app, received, send, lose, queries }) => {
      const job = { name: "shell", input: { command: "echo safe" }, cwd: "main" };
      send({ $: "job", id: "a", job });
      send({ $: "job", id: "a", job });
      await until(() => running.length === 1);
      expect(running[0]?.job).toEqual(job);
      expect(running[0]?.signal.aborted).toBe(false);
      running[0]!.resolve({ text: "safe", fail: false });
      await until(() => received.some((m) => m.$ === "out" && m.job === "a"));
      send({ $: "job", id: "a", job });
      expect(running).toHaveLength(1);
      expect(app.view.out.some((post) => post.msg.$ === "out" && post.msg.job === "a")).toBe(true);

      lose();
      await until(() => !app.view.up);
      await until(() => queries.length >= 2);
      await until(() => app.view.up);
      expect(queries[1]?.get("device")).toBe("owned host");
      await until(() => received.filter((m) => m.$ === "out" && m.job === "a").length >= 2);
      expect(running).toHaveLength(1);

      // The server sends its authoritative cancellation list after a new job.
      send({ $: "job", id: "b", job });
      await until(() => running.length === 2);
      send({ $: "jobs", ids: [] });
      await until(() => running[1]?.signal.aborted === true);
      expect(running[1]?.signal.aborted).toBe(true);
      running[1]!.resolve({ text: "stopped", fail: true });
      await until(() => received.some((m) => m.$ === "out" && m.job === "b"));
    }, {
      run: (job, _work, signal) => new Promise((resolve) => running.push({ signal, resolve, job })),
      end: () => { cleanup++; },
    });
    expect(cleanup).toBe(1);
  });

  test("recovers a removed native surface without replaying actions; final close prevents new jobs", async () => {
    let calls = 0;
    let cleanup = 0;
    await withNative(async ({ app, tern, event, send, lose, queries, sockets, frames, received, uploads }) => {
      const old = tern.surfaces[0]!;
      const id = old.id;
      const stale = old.dispatch({ ev: "send", sf: id, id: INPUT,
        text: "must not submit", raw: {} } as any);
      event({ ev: "visible", sf: id, visible: false });
      event({ ev: "gone", sf: id, ids: [id] });
      await tick();
      const count = frames.length;
      app.editor.set("draft");
      app.changed();
      await tick();
      expect(frames).toHaveLength(count);

      // Reattachment is host-driven; never fabricate a credit or poll.
      event({ ev: "visible", sf: id, visible: true });
      await until(() => tern.surfaces.some((s) => s.id !== id));
      const fresh = tern.surfaces.find((s) => s.id !== id)!;
      expect(fresh.closed).toBe(false);
      expect(app.editor.text).toBe("draft");
      void stale?.();
      await tick();
      expect(uploads).toEqual([]);
      send({ $: "job", id: "before-close",
        job: { name: "read", input: { path: "x" }, cwd: "main" } });
      await until(() => received.some((m) => m.$ === "out" && m.job === "before-close"));
      expect(calls).toBe(1);

      // A disconnected socket schedules one native-owned retry. Disposing
      // cancels it; it cannot reopen into the now-removed host.
      lose();
      await until(() => !app.view.up);
      const connections = queries.length;
      app.stop();
      await Bun.sleep(1100);
      expect(queries).toHaveLength(connections);
      expect(sockets.size).toBe(0);
      send({ $: "job", id: "after-close",
        job: { name: "shell", input: { command: "echo no" }, cwd: "main" } });
      await tick();
      expect(calls).toBe(1);
      expect(cleanup).toBe(1);
    }, {
      run: async () => { calls++; return { text: "ok", fail: false }; },
      end: () => { cleanup++; },
    });
  });
});
