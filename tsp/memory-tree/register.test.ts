import { expect, test } from "bun:test";
import { Node, type ActionEvent, type Key } from "@stencil-hq/tern";
import type { Client } from "../../View.ts";
import { registerMemoryTree, type MemoryTreeOverlay } from "./register.ts";

const key = (name: string): Key => ({ name, ctrl: false, alt: false, meta: false, shift: false } as Key);

function makeHost() {
  let active: MemoryTreeOverlay | null = null;
  const sent: Client[] = [];
  let opened = 0;
  let closed = 0;
  let changes = 0;
  const host = {
    open(overlay: MemoryTreeOverlay) {
      active = overlay;
      opened++;
    },
    close(overlay: MemoryTreeOverlay) {
      expect(active).toBe(overlay);
      active = null;
      closed++;
      overlay.onClose?.();
    },
    changed() { changes++; },
    send(message: Client) { sent.push(message); },
  };
  return {
    host, sent,
    get overlay() { return active; },
    get opened() { return opened; },
    get closed() { return closed; },
    get changes() { return changes; },
  };
}

test("one native overlay registers without opening another Tern surface", () => {
  const h = makeHost();
  const feature = registerMemoryTree(h.host);
  feature.hear({ $: "view", parts: [[0, 4], [4, 1]], turn: 4,
    context: { turn: 4, parts: [[0, 4]] } });
  expect(h.opened).toBe(0);
  feature.open();
  feature.open();
  expect(h.opened).toBe(1);
  expect(h.sent).toEqual([{ $: "root" }]);
  expect(h.overlay?.key).toBe("unii-memory-tree");
  expect(h.overlay?.modal).toBe(true);
  expect(h.changes).toBeGreaterThan(0);
  feature.dispose();
  feature.dispose();
  expect(h.closed).toBe(1);
  feature.open();
  expect(h.opened).toBe(1);
});

test("native keyboard navigation requests only supported existing read acts", () => {
  const h = makeHost();
  const feature = registerMemoryTree(h.host);
  feature.hear({ $: "view", parts: [[0, 8]], turn: 8,
    context: { turn: 8, parts: [[0, 8]] } });
  feature.open();
  feature.hear({ $: "root", parts: [[0, 8]] });
  h.overlay!.onKey(key("tab"));
  expect(h.sent.slice(0, 2)).toEqual([{ $: "root" }, { $: "zoom", part: [0, 8] }]);
  h.overlay!.onKey(key("left"));
  // Level 1 still sits under the same root; pending reads are deduplicated.
  expect(h.sent.filter(x => x.$ === "zoom")).toHaveLength(1);
  h.overlay!.onKey(key("escape"));
  expect(h.closed).toBe(1);
});

test("incoming server updates redraw while open, but not once disposed", () => {
  const h = makeHost();
  const feature = registerMemoryTree(h.host);
  feature.open();
  const before = h.changes;
  feature.hear({ $: "know", nodes: { "0+2": { text: "merged", to: "2026-01-01T00:00:00Z" } } });
  expect(h.changes).toBeGreaterThan(before);
  feature.reconnect();
  expect(h.sent.at(-1)).toEqual({ $: "root" });
  feature.dispose();
  const stable = h.changes;
  feature.hear({ $: "root", parts: [[0, 2]] });
  expect(h.changes).toBe(stable);
});

test("rendering the native Tern picker works with no stored memory", () => {
  const h = makeHost();
  const feature = registerMemoryTree(h.host);
  feature.open();
  const view = h.overlay!.node("layer.unii-memory-tree");
  expect(view).toBeDefined();
  h.overlay!.onKey(key("tab"));
  expect(h.overlay!.node("layer.unii-memory-tree")).toBeDefined();
  feature.dispose();
});

test("external overlay replacement releases visibility and allows reopening", () => {
  const h = makeHost();
  const feature = registerMemoryTree(h.host);
  feature.open();
  h.host.close(h.overlay!); // A stack can dismiss/recreate a sheet independently.
  feature.open();
  expect(h.opened).toBe(2);
  expect(h.sent).toEqual([{ $: "root" }, { $: "root" }]);
  feature.dispose();
  expect(h.closed).toBe(2);
});

test("registration switches between current model call and idle without another transport", () => {
  const h = makeHost();
  const feature = registerMemoryTree(h.host);
  feature.open();
  feature.hear({ $: "view", parts: [[0, 16]], turn: 8,
    context: { turn: 8, parts: [[0, 4], [4, 4]] } });
  expect(h.overlay!.node("layer.unii-memory-tree")).toBeDefined();
  const changed = h.changes;
  feature.hear({ $: "view", parts: [[0, 16]], turn: 16, context: null });
  expect(h.changes).toBeGreaterThan(changed);
  expect(h.overlay!.node("layer.unii-memory-tree")).toBeDefined();
  expect(h.sent).toEqual([{ $: "root" }]);
  feature.dispose();
});

test("reopening binds native actions to a new picker root and rejects stale owners", async () => {
  const h = makeHost();
  const feature = registerMemoryTree(h.host);
  feature.open();
  const former = h.overlay!;
  const oldNode = former.node("memory-tree-old") as Node;
  expect(oldNode.props["key"]).toBe("memory-tree-old");
  const oldRefresh = oldNode.handlers?.onAction?.["refresh"];
  const oldClose = oldNode.handlers?.onAction?.["close"];
  expect(oldRefresh).toBeDefined();
  const oldEvent: ActionEvent = { ev: "action", sf: "unii", id: "layer.memory-tree-old",
    act: "refresh", raw: {} };
  h.host.close(former);
  feature.open();
  const current = h.overlay!;
  expect(current).not.toBe(former);
  expect(current.key).toBe(former.key);
  const freshNode = current.node("memory-tree-new") as Node;
  expect(freshNode.props["key"]).toBe("memory-tree-new");
  const count = h.sent.filter(msg => msg.$ === "root").length;
  const changes = h.changes;
  await oldRefresh?.(oldEvent);
  await oldClose?.({ ...oldEvent, act: "close" });
  expect(former.onKey(key("tab"))).toBe(false);
  former.onClose?.();
  expect(h.overlay).toBe(current);
  expect(h.closed).toBe(1);
  expect(h.changes).toBe(changes);
  expect(h.sent.filter(msg => msg.$ === "root")).toHaveLength(count);

  // Even a retained action from a differently keyed node in this open
  // cannot claim the native root which was first bound for this picker.
  const wrongNode = current.node("not-current-root") as Node;
  await wrongNode.handlers?.onAction?.["refresh"]?.({ ...oldEvent, id: "layer.not-current-root" });
  expect(h.sent.filter(msg => msg.$ === "root")).toHaveLength(count);
  await freshNode.handlers?.onAction?.["refresh"]?.({ ...oldEvent, id: "layer.memory-tree-new" });
  expect(h.sent.filter(msg => msg.$ === "root")).toHaveLength(count + 1);
  feature.dispose();
  expect(h.closed).toBe(2);
});
