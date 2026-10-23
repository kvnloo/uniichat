import { expect, test } from "bun:test";
import { MemoryTree, PAGE_SIZE, partKey, validPart } from "./model.ts";
import type { Client, Part } from "../../View.ts";

const make = () => {
  const sent: Client[] = [];
  const memory = new MemoryTree(message => sent.push(message));
  return { memory, sent };
};

const zoomReply = (parent: Part) => {
  const half = parent[1] / 2;
  return {
    $: "zoom" as const, id: parent[0], n: parent[1],
    parts: [[parent[0], half], [parent[0] + half, half]] as Part[],
  };
};

test("node coordinates are aligned, bounded powers of two", () => {
  expect(validPart([0, 1])).toBe(true);
  expect(validPart([8, 8])).toBe(true);
  expect(validPart([1, 2])).toBe(false);
  expect(validPart([-1, 1])).toBe(false);
  expect(validPart([0, 3])).toBe(false);
  expect(validPart([0, 2 ** 31])).toBe(false);
  expect(validPart([NaN, 1])).toBe(false);
  expect(partKey([16, 4])).toBe("16+4");
});

test("turn context is the server-supplied frozen view, excluding new turn messages", () => {
  const { memory } = make();
  memory.hear({ $: "view", parts: [[0, 8], [8, 2], [10, 1], [11, 1]], turn: 11 });
  expect(memory.context()).toEqual([[0, 8], [8, 2], [10, 1]]);
  memory.hear({ $: "entry", id: 12, kind: "user", text: "New turn message" });
  expect(memory.context()).toEqual([[0, 8], [8, 2], [10, 1]]);
  expect(memory.detail([0, 8]).inTurnContext).toBe(true);
  expect(memory.detail([11, 1]).inTurnContext).toBe(false);
  memory.hear({ $: "view", parts: [[0, 8], [8, 4], [12, 1]], turn: 12 });
  expect(memory.context()).toEqual([[0, 8], [8, 4]]);
});

test("roots must tile the history; level pages do not enumerate all of it", () => {
  const { memory } = make();
  expect(memory.hear({ $: "root", parts: [[0, 8], [12, 4]] })).toBe(false);
  expect(memory.roots).toBeNull();
  memory.hear({ $: "root", parts: [[8, 4], [0, 8], [12, 2]] });
  expect(memory.roots).toEqual([[0, 8], [8, 4], [12, 2]]);
  expect(memory.count).toBe(14);
  expect(memory.levelCount(0)).toBe(14);
  expect(memory.levelCount(2)).toBe(3);
  expect(memory.levelCount(3)).toBe(1);
  expect(memory.levelAt(2, 0)).toEqual([[0, 4], [4, 4], [8, 4]]);
  expect(memory.levelAt(0, 1)).toEqual([]);
  expect(memory.levelAt(-1, 0)).toEqual([]);
  expect(memory.levelPages(0)).toBe(1);
  expect(PAGE_SIZE).toBe(16);
});

test("opens children lazily in server order, to the original source", () => {
  const { memory, sent } = make();
  memory.hear({ $: "root", parts: [[0, 8]] });
  memory.ensureLevel(0, 0);
  memory.ensureLevel(0, 0);
  expect(sent).toEqual([{ $: "zoom", part: [0, 8] }]);

  memory.hear({ $: "know", nodes: { "0+8": { text: "Long-ago preferences", to: "2026-01-01T00:00:00Z" } } });
  memory.hear(zoomReply([0, 8]));
  memory.ensureLevel(0, 0);
  expect(sent.slice(1)).toEqual([{ $: "zoom", part: [0, 4] }, { $: "zoom", part: [4, 4] }]);
  memory.hear(zoomReply([0, 4]));
  memory.hear(zoomReply([4, 4]));
  memory.ensureLevel(0, 0);
  expect(sent.slice(3)).toEqual([
    { $: "zoom", part: [0, 2] }, { $: "zoom", part: [2, 2] },
    { $: "zoom", part: [4, 2] }, { $: "zoom", part: [6, 2] },
  ]);
  for (const part of [[0, 2], [2, 2], [4, 2], [6, 2]] as Part[]) {
    memory.hear(zoomReply(part));
  }
  memory.hear({ $: "know", whole: { "6": { kind: "user", text: "Please keep the source.", date: "2026-01-01T00:00:00Z" } } });
  const detail = memory.detail([6, 1]);
  expect(detail.kind).toBe("source");
  expect(detail.text).toBe("Please keep the source.");
  expect(detail.author).toBe("user");
  expect(detail.first).toBe(6);
  expect(detail.last).toBe(6);
  expect(memory.lineage([6, 1])).toEqual([[0, 8], [4, 4], [6, 2], [6, 1]]);
  expect(memory.pending.size).toBe(0);
});

test("summary provenance is an exact source range, not invented source text", () => {
  const { memory } = make();
  memory.hear({ $: "root", parts: [[0, 8]] });
  memory.hear({ $: "know", nodes: {
    "0+8": { text: "Prefers a calm UI", to: "2026-01-01T00:00:00Z" },
    "0+4": { text: "Earlier messages", to: "2025-12-30T00:00:00Z" },
  } });
  const summary = memory.detail([0, 8]);
  expect(summary.kind).toBe("summary");
  expect(summary.text).toBe("Prefers a calm UI");
  expect([summary.first, summary.last, summary.level]).toEqual([0, 7, 3]);
  expect(summary.date).toBe("2026-01-01T00:00:00Z");
  expect(memory.detail([0, 1]).kind).toBe("pending");
  expect(memory.detail([4, 4]).kind).toBe("pending");
  expect(memory.lineage([2, 2])).toEqual([[0, 8], [0, 4], [2, 2]]);
});

test("invalid, unsolicited, and leaf zooms cannot mutate the tree", () => {
  const { memory, sent } = make();
  memory.hear({ $: "root", parts: [[0, 4]] });
  memory.zoom([0, 1]);
  memory.zoom([8, 2]);
  memory.zoom([2, 2]); // Descendant has not been exposed by its parent.
  expect(sent).toEqual([]);
  memory.zoom([0, 4]);
  expect(sent).toEqual([{ $: "zoom", part: [0, 4] }]);
  expect(memory.hear({ $: "zoom", id: 0, n: 4, parts: [[0, 2], [3, 1]] })).toBe(false);
  expect(memory.pending.has("0+4")).toBe(true);
  expect(memory.hear(zoomReply([0, 4]))).toBe(true);
  expect(memory.expanded.has("0+4")).toBe(true);
  memory.zoom([2, 2]);
  expect(sent.at(-1)).toEqual({ $: "zoom", part: [2, 2] });
});

test("levels are paged and pending zooms are bounded", () => {
  const { memory, sent } = make();
  memory.hear({ $: "root", parts: [[0, 64]] });
  expect(memory.levelPages(0)).toBe(4);
  expect(memory.levelAt(0, 1)[0]).toEqual([16, 1]);
  expect(memory.levelAt(0, 1).at(-1)).toEqual([31, 1]);
  memory.ensureLevel(0, 1);
  expect(sent).toEqual([{ $: "zoom", part: [0, 64] }]);
  memory.hear(zoomReply([0, 64]));
  memory.ensureLevel(0, 1);
  expect(sent.at(-1)).toEqual({ $: "zoom", part: [0, 32] });
  expect(memory.pending.size).toBeLessThanOrEqual(6);
});

test("reconnection discards stale wire exposure and rerequests real roots", () => {
  const { memory, sent } = make();
  memory.hear({ $: "view", parts: [[0, 2], [2, 1]], turn: 2 });
  memory.hear({ $: "root", parts: [[0, 2], [2, 1]] });
  memory.zoom([0, 2]);
  expect(memory.pending.size).toBe(1);
  memory.reconnect();
  expect(memory.pending.size).toBe(0);
  expect(memory.roots).toBeNull();
  expect(memory.context()).toEqual([[0, 2]]);
  expect(sent.at(-1)).toEqual({ $: "root" });
});
