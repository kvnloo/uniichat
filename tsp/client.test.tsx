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

// Native frames contain deltas, not a repeated full snapshot of streamed text.
function renderedText(frames: readonly Frame[], id: string): string | undefined {
  let text: string | undefined;
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    if ("id" in value && value.id === id && "p" in value &&
        typeof value.p === "object" && value.p !== null &&
        "text" in value.p && typeof value.p.text === "string") text = value.p.text;
    if ("c" in value && Array.isArray(value.c)) value.c.forEach(visit);
  };
  for (const frame of frames) for (const op of frame.ops) {
    if (!Array.isArray(op)) continue;
    if (op[0] === "add") visit(op[4]);
    if (op[1] !== id) continue;
    if (op[0] === "del") text = undefined;
    if (op[0] === "text" && typeof op[3] === "string") {
      text = op[2] === "append" ? (text ?? "") + op[3] : op[3];
    }
    if (op[0] === "set" && typeof op[2] === "object" && op[2] !== null &&
        "text" in op[2] && typeof op[2].text === "string") text = op[2].text;
  }
  return text;
}

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
    keys(bytes: string | Uint8Array): void;
    setJoinView(message: WireMessage): void;
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
  let joinView: WireMessage = { $: "view", parts: [], turn: 0 };

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
        ws.send(JSON.stringify(joinView));
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
    keys(bytes: string | Uint8Array) {
      // Raw byte path through the pinned Session's InputParser/KeyDecoder.
      input.emit("data", bytes);
    },
    setJoinView(message: WireMessage) {
      joinView = message;
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
      await until(() => renderedText(frames, "main.tail.0.body") === "Streamed");
      expect(renderedText(frames, "main.tail.0.body")).toBe("Streamed");

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

describe("integrated native Memory on the real Tern session", () => {
  test("composer Memory action owns a single modal; ordered context, levels, source navigation and focus restore", async () => {
    await withNative(async ({ app, tern, frames, received, uploads, send, keys }) => {
      const surface = tern.surfaces[0]!;
      app.editor.set("unsent");
      app.changed();
      await tick();
      dispatch(surface, { ev: "action", id: "dock.composer.bar.memory", act: "click" });
      await until(() => received.some(m => m.$ === "root"));
      expect(tern.surfaces).toHaveLength(1);
      expect(app.editor.text).toBe("unsent");

      send({ $: "know",
        nodes: { "0+2": { text: "first compact", to: "2026-10-21" },
          "2+2": { text: "second compact", to: "2026-10-22" },
          "0+4": { text: "root compact", to: "2026-10-22" } },
        whole: { "0": { kind: "user", text: "source zero" },
          "1": { kind: "unii", text: "source one" } } });
      send({ $: "view", parts: [[0, 4]], turn: 4,
        context: { turn: 4, parts: [[0, 2], [2, 2]] } });
      send({ $: "root", parts: [[0, 4]] });
      await until(() => frames.some(f => JSON.stringify(f.ops).includes("2 exact memory blocks")));
      // The modal catches raw keys before the editor. Tab switches to levels,
      // whose lazy zoom goes over View.link_send and receives a real wire ACK.
      keys("\t");
      await until(() => received.some(m => m.$ === "zoom" &&
        JSON.stringify(m.part) === "[0,4]"));
      send({ $: "zoom", id: 0, n: 4, parts: [[0, 2], [2, 2]] });
      await until(() => received.some(m => m.$ === "zoom" &&
        JSON.stringify(m.part) === "[0,2]"));
      send({ $: "zoom", id: 0, n: 2, parts: [[0, 1], [1, 1]] });
      await until(() => frames.some(f => JSON.stringify(f.ops).includes("source zero")));
      // A picker action is dispatched through the real SDK callback, not
      // a private application switch statement.
      dispatch(surface, { ev: "action", id: "layer.memory-tree", act: "refresh" });
      await until(() => received.filter(m => m.$ === "root").length >= 2);
      keys("\x1b"); // The SDK flushes a lone Escape after its real 30ms timeout.
      await Bun.sleep(60);
      expect(app.editor.text).toBe("unsent");
      keys("more");
      await until(() => app.editor.text === "unsentmore");
      expect(uploads).toEqual([]);
      expect(tern.surfaces).toHaveLength(1);

      // The slash command is local, consumes itself, and opens the same
      // picker. No say upload or model-visible command is ever produced.
      const rootsBeforeCommand = received.filter(m => m.$ === "root").length;
      app.editor.set("/memory");
      app.changed();
      keys("\r");
      await until(() => received.filter(m => m.$ === "root").length > rootsBeforeCommand);
      expect(uploads).toEqual([]);
      expect(app.editor.text).toBe("");
      keys("\x1b");
      await Bun.sleep(60);
      app.editor.set("still drafted");
      app.changed();
      await tick();
      dispatch(surface, { ev: "action", id: "dock.composer.bar.memory", act: "click" });
      expect(app.editor.text).toBe("still drafted");
    });
  });

  test("new physical transport resets old tree before fresh authoritative join, not after", async () => {
    await withNative(async ({ app, tern, frames, send, lose, setJoinView, queries }) => {
      app.editor.set("kept across reconnect");
      send({ $: "view", parts: [[0, 4]], turn: 4,
        context: { turn: 4, parts: [[0, 4]] } });
      dispatch(tern.surfaces[0]!, { ev: "action", id: "dock.composer.bar.memory", act: "click" });
      await until(() => frames.some(f => JSON.stringify(f.ops).includes("1 exact memory blocks")));
      // The live server is authoritative after rejoin, including its frozen
      // context; this test fails if reconnect() runs after the join view.
      setJoinView({ $: "view", parts: [[0, 8]], turn: 6,
        context: { turn: 6, parts: [[0, 2], [2, 2]] } });
      lose();
      await until(() => queries.length >= 2 && app.view.up);
      await until(() => frames.some(f => JSON.stringify(f.ops).includes("2 exact memory blocks")));
      expect(app.editor.text).toBe("kept across reconnect");
      send({ $: "view", parts: [[0, 8]], turn: 8, context: null });
      await until(() => frames.some(f => JSON.stringify(f.ops).includes("historical context unknown")));
    });
  });

  test("final disposal releases modal and ignores later raw input and wire actions", async () => {
    await withNative(async ({ app, tern, frames, received, keys, send, uploads }) => {
      dispatch(tern.surfaces[0]!, { ev: "action", id: "dock.composer.bar.memory", act: "click" });
      await until(() => received.some(m => m.$ === "root"));
      app.stop();
      const count = received.length;
      keys("disallowed\r");
      send({ $: "know", nodes: { "0+2": { text: "late", to: "" } } });
      await tick();
      expect(received.length).toBe(count);
      expect(uploads).toHaveLength(0);
      expect(app.editor.text).toBe("");
    });
  });
});
