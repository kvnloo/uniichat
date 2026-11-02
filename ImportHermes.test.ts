// ImportHermes's test: a Hermes home's state.db files, read as a
// person's sessions and their messages

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as Import from "./Import.ts";
import * as ImportHermes from "./ImportHermes.ts";

// a Hermes home with a state.db (and a profile's): a person's session, a
// delegated child, a subagent's, a hidden one
function home(): string {
  const dir = fs.mkdtempSync(os.tmpdir() + "/unii-hermes-home-");
  for (const path of [dir + "/state.db", dir + "/profiles/work/state.db"]) {
    fs.mkdirSync(path.replace(/\/state\.db$/, ""), { recursive: true });
    const db = new Database(path);
    db.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, parent_session_id TEXT, started_at REAL, cwd TEXT, title TEXT, hidden INTEGER)");
    db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, timestamp REAL, active INTEGER, compacted INTEGER, display_kind TEXT)");
    const at = path.endsWith("/profiles/work/state.db") ? 1_790_000_000 : 1_789_000_000;
    db.run("INSERT INTO sessions VALUES ('p', 'cli', NULL, ?, '/home/k/code', 'fix', 0), ('c', 'cli', 'p', ?, '/x', 'child', 0), ('s', 'subagent', NULL, ?, '/x', 'sub', 0), ('h', 'cli', NULL, ?, '/x', 'hid', 1)", [at, at, at, at]);
    const call = JSON.stringify([{ type: "function", function: { name: "terminal", arguments: '{"command":"ls"}' } }]);
    const rows: unknown[][] = [
      ["p", "user", "old turn", null, at + 1, 0, 1, null],
      ["p", "assistant", "old reply", null, at + 2, 0, 1, null],
      ["p", "user", "dropped draft", null, at + 3, 0, 0, null],
      ["p", "user", "fix the bug", null, at + 4, 1, 0, null],
      ["p", "assistant", "on it", call, at + 5, 1, 0, null],
      ["p", "tool", "a.ts", null, at + 6, 1, 0, null],
      ["p", "user", "[CONTEXT COMPACTION — REFERENCE ONLY] summary", null, at + 7, 1, 0, null],
      ["p", "assistant", "internal", null, at + 8, 1, 0, "internal_notification"],
      ["p", "session_meta", "{}", null, at + 9, 1, 0, null],
      ["c", "user", "child say", null, at + 1, 1, 0, null],
      ["s", "user", "sub say", null, at + 1, 1, 0, null],
      ["h", "user", "hidden say", null, at + 1, 1, 0, null],
    ];
    for (const r of rows) {
      db.run("INSERT INTO messages (session_id, role, content, tool_calls, timestamp, active, compacted, display_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", r as any);
    }
    db.close();
  }
  return dir;
}

test("a Hermes home's person's sessions import, from each profile", async () => {
  const dir = home();
  expect(ImportHermes.hermes_dbs(dir).map((p) => p.slice(dir.length))).toEqual(["/state.db", "/profiles/work/state.db"]);
  const sessions = await ImportHermes.hermes_sessions(dir);
  expect(sessions.map((s) => [s.app, s.form, s.where])).toEqual([
    ["Hermes", "msgs", "session in /home/k/code"],
    ["Hermes", "msgs", "session in /home/k/code"],
  ]);
  expect(sessions[0]!.start).not.toBe(sessions[1]!.start);
  const msgs: Import.Msg[] = [];
  for await (const m of Import.import_read(sessions[0]!)) {
    msgs.push(m);
  }
  expect(msgs.map((m) => [m.kind, m.text])).toEqual([
    ["user", "old turn"],
    ["unii", "old reply"],
    ["user", "fix the bug"],
    ["unii", "on it"],
    ["tool", 'terminal {"command":"ls"}'],
    ["echo", "a.ts"],
  ]);
  expect(msgs[0]!.date).toBe(new Date(1_789_000_001 * 1000).toISOString());
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a state.db of another schema is skipped, not an error", async () => {
  const dir = fs.mkdtempSync(os.tmpdir() + "/unii-hermes-home-");
  new Database(dir + "/state.db").run("CREATE TABLE other (x)");
  expect(await ImportHermes.hermes_sessions(dir)).toEqual([]);
  fs.rmSync(dir, { recursive: true, force: true });
});
