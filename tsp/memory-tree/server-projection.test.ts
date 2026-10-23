// Real Chat.eye/Chat.show projections in a disposable Bun subprocess.
// A runtime import of Server.ts in this test would drag the legacy backend
// into the strict native module compiler profile. Keep the real assertions.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryTree } from "./model.ts";
import type { Part, Server } from "../../View.ts";

type Projections = {
  eye: Part[];
  during: Server;
  after: Server;
  compacted: Server;
  idle: Server;
  reload: Server;
};

const OUTPUT = "UNII_MEMORY_PROJECTIONS:";
let pending: Promise<Projections> | undefined;

async function projectWithRealServer(): Promise<Projections> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unii-memory-projection-"));
  const data = path.join(dir, "data");
  const home = path.join(dir, "home");
  fs.mkdirSync(data);
  fs.mkdirSync(home);
  try {
    const proc = Bun.spawn([process.execPath, import.meta.dir + "/server-projection.child.mjs"], {
      env: { ...process.env, UNII_DIR: data, UNII_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      Bun.readableStreamToText(proc.stdout),
      Bun.readableStreamToText(proc.stderr),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error("real Server.ts projection exited " + exitCode + ":\n" + stderr + "\n" + stdout);
    }
    const line = stdout.split("\n").find(text => text.startsWith(OUTPUT));
    if (line === undefined) {
      throw new Error("real Server.ts projection did not report a snapshot:\n" + stderr + "\n" + stdout);
    }
    return JSON.parse(line.slice(OUTPUT.length)) as Projections;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function realProjections(): Promise<Projections> {
  return pending ??= projectWithRealServer();
}

test("server projection keeps the real model eye through an overlapping import", async () => {
  const { eye, during, after } = await realProjections();
  expect(eye).toEqual([[0, 4], [4, 4]]);
  expect(during).toEqual({
    $: "view", parts: [[0, 16]], turn: 8,
    context: { turn: 8, parts: [[0, 4], [4, 4]] },
  });
  const tree = new MemoryTree(() => {});
  tree.hear(during);
  expect(tree.context()).toEqual([[0, 4], [4, 4]]);

  // Chat.digest advances the display eye, but does not run the model again.
  expect(after).toEqual({
    $: "view", parts: [[0, 16]], turn: 16,
    context: { turn: 8, parts: [[0, 4], [4, 4]] },
  });
  tree.hear(after);
  expect(tree.turn).toBe(8);
  expect(tree.context()).toEqual([[0, 4], [4, 4]]);
});

test("compaction, reconnect and idle/reload have non-fabricated context", async () => {
  const { compacted, idle, reload } = await realProjections();
  const tree = new MemoryTree(() => {});
  tree.hear(compacted);
  expect(tree.context()).toEqual([[0, 16]]);
  tree.reconnect();
  expect(tree.context()).toEqual([]); // Disconnected snapshot is not current.
  tree.hear(compacted); // Rejoin receives the authoritative snapshot.
  expect(tree.context()).toEqual([[0, 16]]);

  tree.hear(idle);
  expect(tree.turn).toBeNull();
  expect(tree.context()).toEqual([]);
  expect(reload).toMatchObject({ $: "view", context: null });
});
