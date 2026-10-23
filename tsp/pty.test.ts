// True PTY acceptance: OS master/slave via script, Unii's actual tryTern
// entry, and the pinned @stencil-hq/tern InputParser + KeyDecoder. Unlike a
// synthetic edit/send, these tests feed bytes to a raw terminal.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { KINDS } from "@stencil-hq/tern";

type Wire = Record<string, unknown>;
type Frame = { sf: string; s: number; ops: unknown[] };
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CHILD = fileURLToPath(new URL("./pty-child.ts", import.meta.url));
const START = "\x1b_tsp;f;";
const END = "\x1b\\";
const enc = new TextEncoder();

const bytes = (s: string): Uint8Array => enc.encode(s);

async function withPty(check: (ctx: {
  send(data: Uint8Array): Promise<void>;
  until(ready: () => boolean, label: string): Promise<void>;
  readonly uploads: string[];
  readonly received: Wire[];
  readonly frames: Frame[];
}) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "unii-tsp-pty-"));
  const uploads: string[] = [];
  const received: Wire[] = [];
  const frames: Frame[] = [];
  const sockets = new Set<{ send(message: string): void }>();
  const server = Bun.serve<{ peer: string }>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, instance) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (instance.upgrade(req, { data: { peer: "pty" } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/api/act" && req.method === "POST") {
        uploads.push(await req.text());
        return Response.json({ ok: true });
      }
      if (url.pathname === "/api/me") return Response.json({ ok: true });
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.send(JSON.stringify({ $: "know",
          nodes: { "0+4": { text: "root", to: "2026-10-22" },
            "0+2": { text: "prior", to: "2026-10-21" },
            "2+2": { text: "latest", to: "2026-10-22" } },
          whole: { "0": { kind: "user", text: "source message" } } }));
        ws.send(JSON.stringify({ $: "view", parts: [[0, 4]], turn: 4,
          context: { turn: 4, parts: [[0, 2], [2, 2]] } }));
        ws.send(JSON.stringify({ $: "state", busy: false, wait: "", agents: [],
          pick: null, vendors: [], models: [], bills: false,
          credits: null, importing: null }));
      },
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as Wire;
        received.push(msg);
        if (msg.$ === "root") {
          ws.send(JSON.stringify({ $: "root", parts: [[0, 4]] }));
        } else if (msg.$ === "zoom" && JSON.stringify(msg.part) === "[0,4]") {
          ws.send(JSON.stringify({ $: "zoom", id: 0, n: 4, parts: [[0, 2], [2, 2]] }));
        }
        if (msg.id !== undefined) {
          ws.send(JSON.stringify({ $: "ack", id: msg.id }));
        }
      },
      close(ws) { sockets.delete(ws); },
    },
  });
  // The utility provides a real pseudoterminal, rather than a mocked
  // EventEmitter. macOS's BSD script and Linux's util-linux script accept
  // different argv; both launch the same production native entry.
  const quoted = "'" + CHILD.replaceAll("'", "'\\''") + "'";
  const command = "bun " + quoted;
  const argv = process.platform === "darwin"
    ? ["script", "-q", "/dev/null", "bun", CHILD]
    : ["script", "-qfec", command, "/dev/null"];
  const env: Record<string, string | undefined> = {
    ...process.env, HOME: home, UNII_HOME: home, UNII_DIR: home,
    UNII_WORK: join(home, "work"), UNII_COMPUTER: "0", UNII_NO_TELEMETRY: "1",
    UNII_PTY_URL: "http://127.0.0.1:" + server.port,
    TERN_TSP_RECORD: "",
  };
  for (const variable of ["TMUX", "TMUX_PANE", "STY", "ZELLIJ", "TERN_TSP"]) {
    delete env[variable];
  }
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let pump: Promise<void> | undefined;
  try {
    proc = Bun.spawn(argv, {
      cwd: ROOT, env, stdin: "pipe", stdout: "pipe", stderr: "inherit",
    });
    const owned = proc;
    const input = owned.stdin;
    const stdout = owned.stdout;
    if (!input || typeof input === "number" ||
        !stdout || typeof stdout === "number") {
      throw new Error("script did not provide owned PTY pipes");
    }
    const send = async (data: Uint8Array): Promise<void> => {
      input.write(data);
      await input.flush();
    };
    const decoder = new TextDecoder();
    let output = "";
    let scan = 0;
    let ackWrites = Promise.resolve();
    pump = (async () => {
      for await (const chunk of stdout) {
        output += decoder.decode(chunk, { stream: true });
        // ACK only frames the OS PTY actually produced. No fabricated
        // application ACKs or session-credits to bypass Tern flow control.
        for (;;) {
          const at = output.indexOf(START, scan);
          if (at < 0) break;
          const end = output.indexOf(END, at + START.length);
          if (end < 0) break;
          const frame = JSON.parse(output.slice(at + START.length, end)) as Frame;
          frames.push(frame);
          ackWrites = ackWrites.then(() => send(bytes(
            "\x1b_tsp;e;" + JSON.stringify({ ev: "ack", sf: frame.sf, s: frame.s }) + END
          ))).catch(() => {});
          scan = end + END.length;
        }
      }
    })();
    const until = async (ready: () => boolean, label: string): Promise<void> => {
      const deadline = Date.now() + 5000;
      while (!ready()) {
        if (Date.now() >= deadline || owned.exitCode !== null) {
          throw new Error("PTY " + label + " not reached; exit=" + owned.exitCode +
            " tail=" + output.slice(-700));
        }
        await Bun.sleep(10);
      }
    };
    await until(() => output.includes("\x1b_tsp;q;"), "hello query");
    await send(bytes("\x1b_tsp;r;" + JSON.stringify({
      r: "hello", v: 1, term: "owned-pty", ver: "0",
      kinds: [...KINDS], features: ["edit", "undo", "send"],
      credits: 32, apc: 1048576, cols: 120, cell: { w: 8, h: 16 },
      dark: true, reduceMotion: false, hour12: false,
    }) + END));
    await until(() => frames.length > 0, "first native frame");
    await check({ send, until, uploads, received, frames });
    await ackWrites;
  } finally {
    if (proc) {
      try {
        if (proc.stdin && typeof proc.stdin !== "number") {
          proc.stdin.write(bytes("\x04")); // Ctrl+D uses the app's native shutdown.
          await proc.stdin.flush();
        }
      } catch {}
      await Promise.race([proc.exited, Bun.sleep(1500)]);
      if (proc.exitCode === null) proc.kill("SIGTERM");
      await Promise.race([proc.exited, Bun.sleep(1500)]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
      await Promise.race([proc.exited, Bun.sleep(1500)]);
    }
    // A broken script utility must not keep the entire test runner blocked
    // on its stdout stream after process termination.
    await Promise.race([pump?.catch(() => {}), Bun.sleep(1500)]);
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}

test("PTY ordinary typed bytes and Enter submit exactly once", async () => {
  await withPty(async ({ send, until, uploads }) => {
    await send(bytes("ordinary typed text"));
    await send(bytes("\r"));
    await until(() => uploads.length === 1, "ASCII upload");
    await Bun.sleep(80);
    expect(uploads).toEqual(["ordinary typed text"]);
  });
});

test("PTY multibyte Unicode fragmented between UTF-8 bytes is preserved", async () => {
  await withPty(async ({ send, until, uploads }) => {
    const prompt = "naïve café 🧠 👩‍💻 漢字";
    for (const byte of bytes(prompt)) {
      await send(Uint8Array.of(byte)); // splits inside UTF-8 code points
      await Bun.sleep(1);
    }
    await send(bytes("\r"));
    await until(() => uploads.length === 1, "Unicode upload");
    await Bun.sleep(80);
    expect(uploads).toEqual([prompt]);
  });
});

test("PTY bracketed paste with newline + Unicode cannot prematurely submit", async () => {
  await withPty(async ({ send, until, uploads }) => {
    const prompt = "pasted first line\nsecond 🍵 line";
    await send(bytes("\x1b[2"));
    await send(bytes("00~"));
    await send(bytes(prompt));
    await send(bytes("\x1b[201~"));
    await Bun.sleep(75);
    expect(uploads).toEqual([]);
    await send(bytes("\r"));
    await until(() => uploads.length === 1, "paste upload");
    await Bun.sleep(80);
    expect(uploads).toEqual([prompt]);
  });
});

test("PTY local /memory and keyboard actions never reach a model as text", async () => {
  await withPty(async ({ send, until, uploads, received, frames }) => {
    await send(bytes("/memory\r"));
    await until(() => received.some(msg => msg.$ === "root"), "memory root request");
    await until(() => frames.some(f => JSON.stringify(f.ops).includes("memory-tree")), "picker frame");
    expect(uploads).toEqual([]);
    await send(bytes("\t"));
    await until(() => received.some(msg => msg.$ === "zoom"), "native level navigation");
    await send(bytes("\x1b")); // SDK flushes standalone Escape after 30ms.
    await Bun.sleep(65);
    await send(bytes("after memory\r"));
    await until(() => uploads.length === 1, "post-modal upload");
    await Bun.sleep(80);
    expect(uploads).toEqual(["after memory"]);
  });
});
