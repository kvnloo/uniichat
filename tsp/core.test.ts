import { describe, expect, test } from "bun:test";
import * as View from "../View.ts";
import { Editor } from "./editor.ts";
import { projectRows, projectView } from "./projection.ts";

describe("Tern core uses UniiChat's canonical View.ts", () => {
  test("initial transcript, deltas and completed tool calls project to native items", () => {
    const v = View.view_new();
    View.view_hear(v, { $: "know", whole: {
      "0": { kind: "user", text: "hello" },
      "1": { kind: "tool", text: 'shell {"command":"echo hello","device":"host"}' },
      "2": { kind: "echo", text: "hello" },
    } });
    View.view_hear(v, { $: "view", parts: [[0, 1], [1, 1], [2, 1]], turn: 0 });
    const shown = projectView(v);
    expect(shown.main.some((r) => r.type === "message" && r.kind === "user" && r.text === "hello")).toBe(true);
    const call = shown.main.find((r) => r.type === "message" && r.kind === "tool");
    expect(call?.type).toBe("message");
    if (call?.type === "message") {
      expect(call.call?.name).toBe("shell");
      expect(call.call?.device).toBe("host");
      expect(call.call?.head).toBe("echo hello");
    }
    expect(shown.main.some((r) => r.type === "message" && r.kind === "echo")).toBe(true);
    View.view_hear(v, { $: "delta", kind: "unii", text: "Hel" });
    View.view_hear(v, { $: "delta", kind: "unii", text: "lo" });
    expect(projectView(v).tail.some((r) => r.type === "message" && r.text === "Hello")).toBe(true);
    View.view_hear(v, { $: "live", live: [] });
    expect(projectView(v).tail.some((r) => r.type === "message")).toBe(false);
  });

  test("memory summary opens into canonical children and requests server zoom", () => {
    const v = View.view_new();
    View.view_hear(v, { $: "know", nodes: { "0+2": { text: "Yesterday", to: "2026-10-21" } },
      whole: { "0": { kind: "user", text: "one" }, "1": { kind: "unii", text: "two" } } });
    View.view_hear(v, { $: "view", parts: [[0, 2]], turn: 2 });
    expect(projectView(v).main.some((r) => r.type === "summary" && r.n === 2)).toBe(true);
    expect(View.view_act(v, { $: "Open", id: 0, n: 2 })).toEqual([{ $: "zoom", part: [0, 2] }]);
    const expanded = projectView(v).main.find((r) => r.type === "expanded");
    expect(expanded?.type).toBe("expanded");
    if (expanded?.type === "expanded") {
      expect(expanded.children.length).toBe(2);
      expect(expanded.children[0]?.key).not.toBe(expanded.children[1]?.key);
    }
    expect(View.view_act(v, { $: "Shut", id: 0, n: 2 })).toEqual([]);
    expect(projectView(v).main.some((r) => r.type === "summary")).toBe(true);
  });

  test("stable projection keys distinguish live rows, messages and remembered blocks", () => {
    const rows: View.Row[] = [
      { $: "Cap", text: "note" },
      { $: "Sum", id: 2, n: 8, text: "month", call: null },
      ...View.entry_rows(4, "unii", "answer"),
      ...View.entry_rows(null, "mind", "working"),
    ];
    const keys = projectRows(rows, "test").map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(projectRows(rows, "test").map((r) => r.key)).toEqual(keys);
  });
});

describe("Tern native editor", () => {
  test("applies UTF-16 range edits, caret events, stale edit rejection and undo", () => {
    const ed = new Editor();
    ed.set("ab");
    expect(ed.edit({ from: 1, to: 2, text: "😀", cursor: 3, len: 2 })).toBe(true);
    expect(ed.text).toBe("a😀");
    expect(ed.cursor).toBe(3);
    expect(ed.edit({ from: 0, to: 1, text: "X", cursor: 1, len: 2 })).toBe(false);
    expect(ed.text).toBe("a😀");
    ed.undo();
    expect(ed.text).toBe("ab");
    ed.redo();
    expect(ed.text).toBe("a😀");
    expect(ed.key({ name: "backspace", ctrl: false, alt: false, meta: false, shift: false } as any)).toBe("changed");
    expect(ed.text).toBe("a");
  });

  test("keeps multiline prompts, atomic submit and failed-send recovery independent", () => {
    const ed = new Editor();
    ed.set("line");
    expect(ed.key({ name: "enter", shift: true } as any)).toBe("changed");
    ed.insert("two");
    expect(ed.text).toBe("line\ntwo");
    expect(ed.key({ name: "enter" } as any)).toBe("send");
    ed.clear();
    expect(ed.text).toBe("");
    ed.set("line\ntwo");
    expect(ed.text).toBe("line\ntwo");
  });
});
