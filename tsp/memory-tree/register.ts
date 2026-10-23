// Native memory explorer for UniiChat. Uses only public @stencil-hq/tern nodes and
// the existing UniiChat view/know/root/zoom socket messages. No second connection.
// The core calls registerMemoryTree once, forwards server events via hear, and
// exposes open through its own command/menu without importing this module's state.

import { node, type JSX, type Key, type PickerItem } from "@stencil-hq/tern";
import type { Client, Part, Server } from "../../View.ts";
import { MemoryTree, PAGE_SIZE, partKey, partLevel } from "./model.ts";

export interface MemoryTreeOverlay {
  readonly key: string;
  readonly modal: true;
  node(id: string): JSX.Element;
  onKey(key: Key): boolean;
}

export interface MemoryTreeHost {
  /** Existing overlay stack; no surface is opened or replaced by this feature. */
  open(overlay: MemoryTreeOverlay): void;
  close(overlay: MemoryTreeOverlay): void;
  changed(): void;
  /** Must use View.link_send (ack/replay), not an untracked raw ws.send. */
  send(message: Client): void;
}

export interface MemoryTreeRegistration {
  open(): void;
  hear(message: Server): void;
  /** Call on a fresh WebSocket join after transport loss. */
  reconnect(): void;
  dispose(): void;
}

type Tab = "turn" | "level";
const PREVIEW = 8000;

const labelOf = (p: Part): string => {
  const [id, n] = p;
  return "L" + partLevel(p) + "  #" + id + (n === 1 ? "" : "–" + (id + n - 1));
};

const snippet = (text: string, max = 96): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
};

const textNode = (key: string, value: string): JSX.Element =>
  node("text", { key, text: value, wrap: "word" });

/** One registration call; no global listeners, server endpoints, or shared-file edits. */
export function registerMemoryTree(host: MemoryTreeHost): MemoryTreeRegistration {
  const memory = new MemoryTree(message => host.send(message));
  let visible = false;
  let disposed = false;
  let tab: Tab = "turn";
  let level = 0;
  let page = 0;
  let selected: string | null = null;

  const pageCount = () => tab === "turn" ? memory.contextPages() : memory.levelPages(level);
  const shown = (): Part[] => tab === "turn" ? memory.contextAt(page) : memory.levelAt(level, page);
  const current = (): Part | null => shown().find(p => partKey(p) === selected) ?? shown()[0] ?? null;

  const reconcile = () => {
    page = Math.min(page, pageCount() - 1);
    const currentParts = shown();
    if (!currentParts.some(p => partKey(p) === selected)) selected = currentParts.length ? partKey(currentParts[0]!) : null;
  };

  const refresh = () => {
    if (disposed) return;
    reconcile();
    if (tab === "level") memory.ensureLevel(level, page);
    if (visible) host.changed();
  };

  const setTab = (next: Tab) => {
    tab = next;
    page = next === "turn" ? memory.contextPages() - 1 : 0;
    selected = null;
    refresh();
  };

  const setLevel = (next: number, anchor = current()?.[0] ?? 0) => {
    if (!memory.roots) {
      tab = "level";
      level = 0;
      page = 0;
      selected = null;
      refresh();
      return;
    }
    tab = "level";
    level = Math.max(0, Math.min(memory.maxLevel, next));
    const size = 2 ** level;
    const index = Math.max(0, Math.min(memory.levelCount(level) - 1, Math.floor(anchor / size)));
    page = Math.floor(index / PAGE_SIZE);
    selected = partKey([index * size, size]);
    refresh();
  };

  const movePage = (step: number) => {
    page = Math.max(0, Math.min(pageCount() - 1, page + step));
    selected = null;
    refresh();
  };

  const select = (key: string | undefined) => {
    if (key && shown().some(p => partKey(p) === key)) {
      selected = key;
      host.changed();
    }
  };

  const activate = (part: Part | null) => {
    if (!part || part[1] === 1) return;
    memory.zoom(part);
    setLevel(partLevel(part) - 1, part[0]);
  };

  const close = () => {
    if (!visible) return;
    visible = false;
    host.close(overlay);
  };

  const preview = (part: Part | null): JSX.Element[] => {
    if (!part) {
      return [textNode("none", tab === "turn" ?
        "No context snapshot yet. The server sends the exact view at the next turn." :
        memory.roots === null ? "Loading memory roots from UniiChat…" : "No nodes at this level.")];
    }
    const detail = memory.detail(part);
    const lineage = memory.lineage(part).map(labelOf).join("  ›  ");
    const body = detail.text.length > PREVIEW ?
      detail.text.slice(0, PREVIEW) + "\n\n… Preview limited to " + PREVIEW + " characters; the source is unchanged." :
      detail.text;
    const kind = detail.kind === "source" ? "Original message" :
      detail.kind === "summary" ? (detail.level === 0 ? "One-line message summary" : "Merged summary") :
      "Summary or source not yet received";
    const dates = detail.date ? " · last source " + detail.date : "";
    return [
      node("text", { key: "head", role: "omp.picker.title", text: labelOf(part), wrap: "word" }),
      textNode("kind", kind + (detail.author ? " · " + detail.author : "") + dates),
      textNode("range", "Provenance: messages #" + detail.first + "–#" + detail.last),
      node("rule", { key: "lineage-rule", label: "Compaction ancestry" }),
      textNode("lineage", lineage),
      node("rule", { key: "body-rule", label: detail.kind === "source" ? "Original message" : "Stored summary" }),
      node("md", { key: "body", role: "unii.memory-tree.content", text: body }),
      ...(detail.images.length ? [textNode("images", "Source images: " + detail.images.join(", "))] : []),
      textNode("hint", part[1] > 1 ?
        "Open children to trace this summary to its two inputs, repeatedly down to source messages." :
        "Leaf of the memory tree. This is the source message, not a reconstruction."),
    ];
  };

  const panel = (): JSX.Element => {
    reconcile();
    const list = shown();
    const active = current();
    const items: PickerItem[] = list.map(p => {
      const detail = memory.detail(p);
      return {
        id: detail.key,
        label: labelOf(p) + "  " + snippet(detail.text),
        detail: detail.kind === "source" ?
          "Detailed · " + (detail.author ?? "message") :
          detail.kind === "summary" ?
            (p[1] === 1 ? "One-line summary" : "Compacted from " + p[1] + " messages") :
            "Waiting for " + (p[1] === 1 ? "source message" : "summary"),
        badges: [
          { text: p[1] === 1 ? "source / leaf" : "L" + partLevel(p) + " compact" },
          ...(tab === "turn" ? [{ text: "turn context", tone: "accent" as const }] : []),
        ],
      };
    });
    const title = tab === "turn" ? "Memory in view for current turn" : "OptMem levels";
    const subtitle = tab === "turn" ?
      (memory.turn === null ? "Waiting for a server view" :
        "Before turn #" + memory.turn + " · " + memory.context().length + " blocks in model context") :
      (memory.roots === null ? "Reading root nodes…" :
        "Level " + level + " of " + memory.maxLevel + " · " + memory.levelCount(level) +
        " nodes · L0 contains source messages; higher levels are compactions");
    const actions = [
      { id: "previous", keys: ["pageup"], label: "Previous", disabled: page === 0 },
      { id: "next", keys: ["pagedown"], label: "Next", disabled: page >= pageCount() - 1 },
      ...(tab === "level" ? [
        { id: "coarser", keys: ["left"], label: "Coarser", disabled: level >= memory.maxLevel },
        { id: "finer", keys: ["right"], label: "Finer", disabled: level <= 0 },
      ] : []),
      { id: "open", keys: ["enter"], label: "Open children", primary: true, disabled: !active || active[1] === 1 },
      { id: "refresh", label: "Refresh roots" },
      { id: "close", keys: ["esc"], label: "Close", end: true },
    ];
    return node("picker", {
      key: "memory-tree",
      role: "unii.memory-tree",
      icon: "history",
      title,
      subtitle: [{ s: "muted", t: subtitle }],
      size: "lg",
      noun: "memory nodes",
      items,
      order: items.map(item => item.id),
      ...(active ? { selected: partKey(active) } : {}),
      preview: "side",
      state: tab === "level" && memory.roots === null ? "loading" : "ready",
      empty: tab === "turn" ? "No earlier messages were in this turn's context." : "No nodes at this level.",
      tab,
      tabs: [
        { id: "turn", label: "Turn context", count: memory.context().length },
        { id: "level", label: "Levels", count: memory.levelCount(level) },
      ],
      actions,
      onSelect: (event: { item: string }) => select(event.item),
      onActivate: (event: { item: string }) => activate(list.find(p => partKey(p) === event.item) ?? null),
      onAction: {
        tab: (event: { value: string }) => setTab(event.value === "level" ? "level" : "turn"),
        previous: () => movePage(-1),
        next: () => movePage(1),
        coarser: () => setLevel(level + 1),
        finer: () => setLevel(level - 1),
        open: () => activate(current()),
        refresh: () => {
          memory.requestRoots();
          refresh();
        },
        close,
      },
    }, preview(active));
  };

  const overlay: MemoryTreeOverlay = {
    key: "unii-memory-tree",
    modal: true,
    node: () => panel(),
    onKey: (key: Key) => {
      if (key.name === "escape") {
        close();
      } else if (key.name === "tab") {
        setTab(tab === "turn" ? "level" : "turn");
      } else if (key.name === "page_up") {
        movePage(-1);
      } else if (key.name === "page_down") {
        movePage(1);
      } else if (key.name === "enter" || (key.name === "right" && tab === "turn")) {
        activate(current());
      } else if (tab === "level" && key.name === "left") {
        setLevel(level + 1);
      } else if (tab === "level" && key.name === "right") {
        setLevel(level - 1);
      } else if (key.name === "up" || key.name === "down") {
        const all = shown().map(partKey);
        const at = Math.max(0, all.indexOf(selected ?? ""));
        selected = all[Math.max(0, Math.min(all.length - 1, at + (key.name === "down" ? 1 : -1)))] ?? null;
        host.changed();
      } else if (key.name === "home") {
        selected = shown().length ? partKey(shown()[0]!) : null;
        host.changed();
      } else if (key.name === "end") {
        selected = shown().length ? partKey(shown().at(-1)!) : null;
        host.changed();
      }
      return true;
    },
  };

  return {
    open: () => {
      if (disposed || visible) return;
      visible = true;
      tab = "turn";
      page = memory.contextPages() - 1;
      selected = null;
      host.open(overlay);
      memory.requestRoots();
      refresh();
    },
    hear: (message: Server) => {
      if (disposed || !memory.hear(message)) return;
      if (visible) refresh();
    },
    reconnect: () => {
      if (disposed) return;
      memory.reconnect();
      if (visible) refresh();
    },
    dispose: () => {
      if (disposed) return;
      close();
      disposed = true;
    },
  };
}
