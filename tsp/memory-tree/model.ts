// UniiChat's OptMem tree, projected from its existing view/know/root/zoom wire events.
// Source of truth: Memory.ts (node coordinates) and Server.ts (Chat.teach/Chat.eye).
// Never fetch /tree HTML or /export: the authenticated socket already serves these nodes.

import type { Client, Entry, Node as Summary, Part, Server } from "../../View.ts";

export const PAGE_SIZE = 16;
const MAX_ZOOMS = 6;
const MAX_LEVEL = 30;

export type MemoryKind = "source" | "summary" | "pending";

export interface MemoryDetail {
  readonly part: Part;
  readonly key: string;
  readonly level: number;
  readonly first: number;
  readonly last: number;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly date?: string;
  readonly author?: string;
  readonly images: readonly string[];
  readonly inTurnContext: boolean;
}

export function validPart(value: unknown): value is Part {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [id, size] = value;
  return Number.isSafeInteger(id) && id >= 0 &&
    Number.isSafeInteger(size) && size >= 1 && size <= 2 ** MAX_LEVEL &&
    Number.isInteger(Math.log2(size)) && id % size === 0 &&
    Number.isSafeInteger(id + size);
}

export function partKey([id, size]: Part): string {
  return String(id) + "+" + String(size);
}

export function partLevel([, size]: Part): number {
  return Math.log2(size);
}

export function contains(outer: Part, inner: Part): boolean {
  return outer[0] <= inner[0] && outer[0] + outer[1] >= inner[0] + inner[1];
}

function parts(value: unknown): Part[] {
  if (!Array.isArray(value)) return [];
  return value.filter(validPart).map(([a, b]) => [a, b] as Part);
}

function validRoots(value: unknown): Part[] | null {
  const found = parts(value).sort((a, b) => a[0] - b[0]);
  let end = 0;
  for (const p of found) {
    if (p[0] !== end) return null;
    end += p[1];
  }
  return found;
}

function keyPart(value: string): Part | null {
  if (!/^(0|[1-9]\d*)\+(1|[1-9]\d*)$/.test(value)) return null;
  const [a, b] = value.split("+").map(Number);
  const p: Part = [a!, b!];
  return validPart(p) && partKey(p) === value ? p : null;
}

/**
 * Data-only memory model; it never mutates the chat or reads files.
 * Client actions go through the same durable View.link_send queue as the TUI.
 */
export class MemoryTree {
  readonly summaries = new Map<string, Summary>();
  readonly messages = new Map<number, Entry>();
  readonly exposed = new Set<string>();
  readonly expanded = new Set<string>();
  readonly pending = new Set<string>();
  roots: Part[] | null = null;
  turnParts: Part[] = [];
  turn: number | null = null;

  constructor(private readonly send: (message: Client) => void) {}

  /** Ingest each wire event after the core's usual view_hear handler. */
  hear(message: Server): boolean {
    switch (message.$) {
      case "know": {
        let changed = false;
        for (const [key, node] of Object.entries(message.nodes ?? {})) {
          if (keyPart(key) && typeof node?.text === "string") {
            this.summaries.set(key, node);
            changed = true;
          }
        }
        for (const [raw, entry] of Object.entries(message.whole ?? {})) {
          const id = Number(raw);
          if (Number.isSafeInteger(id) && id >= 0 && String(id) === raw &&
              typeof entry?.text === "string" && typeof entry.kind === "string") {
            this.messages.set(id, entry);
            changed = true;
          }
        }
        return changed;
      }
      case "view": {
        if (!Number.isSafeInteger(message.turn) || message.turn < 0) return false;
        const seen = parts(message.parts);
        this.turnParts = seen;
        this.turn = message.turn;
        for (const part of seen) this.exposed.add(partKey(part));
        return true;
      }
      case "root": {
        const roots = validRoots(message.parts);
        if (roots === null) return false;
        this.roots = roots;
        for (const part of roots) this.exposed.add(partKey(part));
        return true;
      }
      case "zoom": {
        const parent: Part = [message.id, message.n];
        // A previous socket epoch or a different UI may receive a zoom too.
        // Only a request from this explorer may disclose descendants here.
        if (!validPart(parent) || parent[1] === 1 || !this.pending.has(partKey(parent))) return false;
        const children = parts(message.parts);
        const half = parent[1] / 2;
        if (children.length !== 2 ||
            children[0]![0] !== parent[0] || children[0]![1] !== half ||
            children[1]![0] !== parent[0] + half || children[1]![1] !== half) return false;
        this.pending.delete(partKey(parent));
        this.expanded.add(partKey(parent));
        for (const child of children) this.exposed.add(partKey(child));
        return true;
      }
      case "entry": {
        if (message.agent !== undefined || !Number.isSafeInteger(message.id) ||
            message.id === undefined || message.id < 0) return false;
        this.messages.set(message.id, { kind: message.kind, text: message.text, date: message.date, images: message.images });
        return true;
      }
      default:
        return false;
    }
  }

  /** The source messages and summaries actually presented before the turn boundary. */
  context(): Part[] {
    return this.turn === null ? [] :
      this.turnParts.filter(p => p[0] + p[1] <= this.turn!);
  }

  contextAt(page: number): Part[] {
    return this.context().slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  }

  contextPages(): number {
    return Math.max(1, Math.ceil(this.context().length / PAGE_SIZE));
  }

  /** Level zero has one source message per node; larger levels have merged summaries. */
  get count(): number {
    return this.roots === null ? 0 : this.roots.reduce((max, p) => Math.max(max, p[0] + p[1]), 0);
  }

  get maxLevel(): number {
    return this.count ? Math.min(MAX_LEVEL, Math.floor(Math.log2(this.count))) : 0;
  }

  levelCount(level: number): number {
    return Number.isInteger(level) && level >= 0 && level <= this.maxLevel ?
      Math.floor(this.count / 2 ** level) : 0;
  }

  levelPages(level: number): number {
    return Math.max(1, Math.ceil(this.levelCount(level) / PAGE_SIZE));
  }

  levelAt(level: number, page: number): Part[] {
    if (!Number.isSafeInteger(page) || page < 0) return [];
    const n = 2 ** level;
    if (!Number.isInteger(level) || level < 0 || level > this.maxLevel) return [];
    const count = this.levelCount(level);
    const from = page * PAGE_SIZE;
    return Array.from({ length: Math.max(0, Math.min(PAGE_SIZE, count - from)) },
      (_, k): Part => [(from + k) * n, n]);
  }

  /** Source range is exact even if a particular compaction is not ready yet. */
  detail(part: Part): MemoryDetail {
    const [id, size] = part;
    const key = partKey(part);
    const source = size === 1 ? this.messages.get(id) : undefined;
    const summary = this.summaries.get(key);
    const kind: MemoryKind = source ? "source" : summary ? "summary" : "pending";
    return {
      part, key, level: partLevel(part), first: id, last: id + size - 1, kind,
      text: source?.text ?? summary?.text ??
        (size === 1 ? "Source message is loading." : "Summary has not been built yet."),
      ...(source?.kind ? { author: source.kind } : {}),
      ...(source?.date ?? summary?.to ? { date: source?.date ?? summary?.to } : {}),
      images: source?.images ?? [],
      inTurnContext: this.context().some(p => partKey(p) === key),
    };
  }

  /** Trace the exact parent->child chain; never infer an unrelated source. */
  lineage(part: Part): Part[] {
    const root = this.roots?.find(root => contains(root, part));
    if (!root) return [part];
    const chain: Part[] = [root];
    let at = root;
    while (at[1] > part[1]) {
      const size = at[1] / 2;
      at = part[0] < at[0] + size ? [at[0], size] : [at[0] + size, size];
      chain.push(at);
    }
    return chain;
  }

  requestRoots(): void {
    this.send({ $: "root" });
  }

  /** Only zoom known, aligned ancestors. Never issue a zoom for a leaf. */
  zoom(part: Part): void {
    const key = partKey(part);
    if (!validPart(part) || part[1] === 1 || this.expanded.has(key) ||
        this.pending.has(key) || this.pending.size >= MAX_ZOOMS) return;
    if (!(this.roots?.some(root => contains(root, part)) ||
          this.turnParts.some(root => contains(root, part)))) return;
    // An undisclosed descendant cannot be fetched out of order.
    if (!this.exposed.has(key)) return;
    this.pending.add(key);
    this.send({ $: "zoom", part });
  }

  /** Lazy, bounded expansion of only the visible page; no whole-history fanout. */
  ensureLevel(level: number, page: number): void {
    if (!this.roots) return;
    for (const target of this.levelAt(level, page)) {
      if (this.pending.size >= MAX_ZOOMS) break;
      let at = this.roots.find(root => contains(root, target));
      while (at && at[1] > target[1]) {
        const key = partKey(at);
        if (!this.expanded.has(key)) {
          this.zoom(at);
          break;
        }
        const half = at[1] / 2;
        at = target[0] < at[0] + half ? [at[0], half] : [at[0] + half, half];
      }
    }
  }

  /** Called on a new socket epoch so lost acks don't strand the exploration. */
  reconnect(): void {
    this.pending.clear();
    this.expanded.clear();
    this.exposed.clear();
    this.roots = null;
    // The last turn snapshot stays visible until the new join delivers its view.
    this.requestRoots();
  }
}
