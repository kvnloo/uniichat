// Native Tern editor state. UTF-16 offsets match the SDK's edit/cursor contract.
// Keep server-visible prompts separate from the UI's transient draft.
import type { EditEvent, Key } from "@stencil-hq/tern";

type Snapshot = { text: string; cursor: number };
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const HISTORY_LIMIT = 100;

function bound(value: number, length: number): number {
  return Math.max(0, Math.min(length, value));
}

function neighbor(text: string, cursor: number, direction: -1 | 1): number {
  const stops = [...GRAPHEMES.segment(text)].map((part) => part.index);
  stops.push(text.length);
  if (direction < 0) {
    return stops.filter((at) => at < cursor).at(-1) ?? 0;
  }
  return stops.find((at) => at > cursor) ?? text.length;
}

export class Editor {
  text = "";
  cursor = 0;
  #undo: Snapshot[] = [];
  #redo: Snapshot[] = [];

  set(text: string, cursor = text.length): void {
    this.#save();
    this.text = text;
    this.cursor = bound(cursor, text.length);
  }

  clear(): void {
    this.text = "";
    this.cursor = 0;
    this.#undo = [];
    this.#redo = [];
  }

  edit(ev: Pick<EditEvent, "from" | "to" | "text" | "cursor" | "len">): boolean {
    if (ev.len !== this.text.length || !Number.isInteger(ev.from) || !Number.isInteger(ev.to) ||
        ev.from < 0 || ev.to < ev.from || ev.to > this.text.length ||
        !Number.isInteger(ev.cursor) || typeof ev.text !== "string") {
      return false;
    }
    if (ev.from === ev.to && ev.text === "") {
      this.cursor = bound(ev.cursor, this.text.length);
      return true;
    }
    this.#replace(ev.from, ev.to, ev.text, ev.cursor);
    return true;
  }

  insert(text: string): void {
    this.#replace(this.cursor, this.cursor, text, this.cursor + text.length);
  }

  undo(): void {
    const previous = this.#undo.pop();
    if (previous) {
      this.#redo.push(this.#snapshot());
      this.#restore(previous);
    }
  }

  redo(): void {
    const next = this.#redo.pop();
    if (next) {
      this.#undo.push(this.#snapshot());
      this.#restore(next);
    }
  }

  // Returns "send" only for an unmodified Enter. The native onSend event
  // carries an atomic copy of the editor text and uses the same send path.
  key(key: Key): "send" | "changed" | null {
    if (key.name === "enter") {
      if (key.shift || key.alt) {
        this.insert("\n");
        return "changed";
      }
      return "send";
    }
    if ((key.ctrl || key.meta) && key.name === "z") {
      key.shift ? this.redo() : this.undo();
      return "changed";
    }
    if (key.name === "paste") {
      this.insert((key.text ?? "").replace(/\r\n?/g, "\n"));
      return "changed";
    }
    if (!key.ctrl && !key.meta) {
      if (key.name === "left" || key.name === "right") {
        this.cursor = neighbor(this.text, this.cursor, key.name === "left" ? -1 : 1);
        return "changed";
      }
      if (key.name === "home") {
        this.cursor = 0;
        return "changed";
      }
      if (key.name === "end") {
        this.cursor = this.text.length;
        return "changed";
      }
      if (key.name === "backspace" || key.name === "delete") {
        const from = key.name === "backspace" ? neighbor(this.text, this.cursor, -1) : this.cursor;
        const to = key.name === "delete" ? neighbor(this.text, this.cursor, 1) : this.cursor;
        if (from !== to) {
          this.#replace(from, to, "", from);
        }
        return "changed";
      }
      if (key.text && !key.alt) {
        this.insert(key.text);
        return "changed";
      }
    }
    return null;
  }

  #snapshot(): Snapshot {
    return { text: this.text, cursor: this.cursor };
  }

  #restore(value: Snapshot): void {
    this.text = value.text;
    this.cursor = value.cursor;
  }

  #save(): void {
    this.#undo.push(this.#snapshot());
    if (this.#undo.length > HISTORY_LIMIT) {
      this.#undo.shift();
    }
    this.#redo = [];
  }

  #replace(from: number, to: number, value: string, cursor: number): void {
    this.#save();
    this.text = this.text.slice(0, from) + value + this.text.slice(to);
    this.cursor = bound(cursor, this.text.length);
  }
}
