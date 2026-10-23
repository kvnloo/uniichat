// Real Chat.show/Chat.eye projections; no sockets, network, or user storage.
import { expect, test } from "bun:test";
import { Chat } from "../../Server.ts";
import { MemoryTree } from "./model.ts";
import type { Server, Part } from "../../View.ts";

// Mark nodes as taught to isolate the server's real display projection from
// Memory.message's disk lookup. Other tests cover summary/source retrieval.
function project(chat: Parameters<typeof Chat.show>[0]): Server {
  const delivered: Server[] = [];
  const seen = new Set(["0+4", "4+4", "0+8", "8+8", "0+16"]);
  const sock = {
    data: { seen },
    send(body: string) { delivered.push(JSON.parse(body) as Server); },
  } as unknown as Parameters<typeof Chat.show>[1];
  Chat.show(chat, sock);
  const view = delivered.find(msg => msg.$ === "view");
  if (view === undefined) throw new Error("Chat.show did not send a view");
  return view;
}

test("server projection keeps the real model eye through an overlapping import", () => {
  const mem = { count: 16, view: { parts: [{ l: 2, i: 0 }, { l: 2, i: 1 }] } };
  const eye = Chat.eye(mem as unknown as Parameters<typeof Chat.eye>[0], 8);
  expect(eye.parts).toEqual([[0, 4], [4, 4]]);
  const context = { turn: 8, parts: eye.parts.map(([id, n]): Part => [id, n]) };
  const chat = {
    mem, eye, context, busy: true, batch: { a: 8, b: 16 },
  } as unknown as Parameters<typeof Chat.show>[0];
  const during = project(chat);
  expect(during).toEqual({
    $: "view", parts: [[0, 16]], turn: 8,
    context: { turn: 8, parts: [[0, 4], [4, 4]] },
  });
  const tree = new MemoryTree(() => {});
  tree.hear(during);
  expect(tree.context()).toEqual([[0, 4], [4, 4]]);

  // Chat.digest advances chat.eye, but does not run the model again.
  mem.view.parts = [{ l: 4, i: 0 }];
  (chat as { batch: unknown }).batch = null;
  (chat as { eye: typeof eye }).eye = Chat.eye(mem as unknown as Parameters<typeof Chat.eye>[0], 16);
  const after = project(chat);
  expect(after).toEqual({
    $: "view", parts: [[0, 16]], turn: 16,
    context: { turn: 8, parts: [[0, 4], [4, 4]] },
  });
  tree.hear(after);
  expect(tree.turn).toBe(8);
  expect(tree.context()).toEqual([[0, 4], [4, 4]]);
});

test("compaction, reconnect and idle/reload have non-fabricated context", () => {
  const mem = { count: 16, view: { parts: [{ l: 4, i: 0 }] } };
  const eye = Chat.eye(mem as unknown as Parameters<typeof Chat.eye>[0], 16);
  const chat = {
    mem, eye, busy: true, batch: null,
    context: { turn: 16, parts: [[0, 16]] as Part[] },
  } as unknown as Parameters<typeof Chat.show>[0];
  const tree = new MemoryTree(() => {});
  tree.hear(project(chat));
  expect(tree.context()).toEqual([[0, 16]]);
  tree.reconnect();
  expect(tree.context()).toEqual([]); // Disconnected snapshot is not current.
  tree.hear(project(chat)); // Rejoin receives the authoritative snapshot.
  expect(tree.context()).toEqual([[0, 16]]);

  (chat as { busy: boolean }).busy = false;
  (chat as { context: unknown }).context = null;
  tree.hear(project(chat));
  expect(tree.turn).toBeNull();
  expect(tree.context()).toEqual([]);
  const reload = {
    mem, eye: Chat.eye(mem as unknown as Parameters<typeof Chat.eye>[0], 16),
    busy: false, batch: null, context: null,
  } as unknown as Parameters<typeof Chat.show>[0];
  expect(project(reload)).toMatchObject({ $: "view", context: null });
});
