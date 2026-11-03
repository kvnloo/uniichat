// ImportHermes
// ============
// Hermes Agent's chats, for /import (Term.ts). Claude Code, Codex and OMP
// keep a session as a log; Hermes keeps every one in SQLite, a state.db in
// its home ($HERMES_HOME, else ~/.hermes) and one in each of its profiles
// (profiles/<name>/state.db). Each person's session is written out as a
// msgs-form file (Import.ts: its messages as JSON lines) in a temp dir,
// then read from disk as any session is: a state.db of gigabytes is never
// held in memory, and the two reads (heads, then body) are the same file.
//
// A person's session: not a delegated child (parent_session_id), not an
// agent's or a script's (SKIP sources), not hidden. Its messages are its
// whole history, the turns a compaction archived (active=0, compacted=1)
// too, as Hermes's own Markdown export keeps them; never what Hermes
// injected (HIDDEN display kinds, its notices), never reasoning.

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as Import from "./Import.ts";

// Constants
// =========

// sources that are no person's chat: a delegated agent, a tool's own
// session, a one-shot script call
const SKIP = new Set(["subagent", "tool", "oneshot"]);

// display kinds Hermes gives what it injected, not what was said
const HIDDEN = ["hidden", "internal_notification", "async_delegation_complete", "process_complete"];

// a user row that is Hermes's notice, not the person's say
const NOTICE = /^\[(CONTEXT COMPACTION|IMPORTANT: Background process|ASYNC DELEGATION|INTERNAL NOTIFICATION|OUT-OF-BAND)/;

// Paths
// =====

// the state.db files of a Hermes home: its own, then its profiles'
export function hermes_dbs(home: string): string[] {
  const profiles = home + "/profiles";
  const names = fs.existsSync(profiles) ? fs.readdirSync(profiles).sort() : [];
  return [home + "/state.db", ...names.map((n) => profiles + "/" + n + "/state.db")].filter((p) => fs.existsSync(p));
}

// Sessions
// ========

// a Hermes home's sessions, each written to `dir`; a state.db that can't
// be read (another schema, locked) is skipped, never fails the import
export async function hermes_sessions(home: string, dir = fs.mkdtempSync(os.tmpdir() + "/unii-hermes-")): Promise<Import.Session[]> {
  const found: Import.Session[] = [];
  for (const [k, path] of hermes_dbs(home).entries()) {
    try {
      found.push(...(await db_sessions(path, dir + "/" + k)));
    } catch {
      continue;
    }
  }
  return found;
}

// one state.db's sessions
async function db_sessions(path: string, dir: string): Promise<Import.Session[]> {
  const db = new Database(path, { readonly: true });
  try {
    const scol = columns(db, "sessions");
    const mcol = columns(db, "messages");
    if (!scol.has("id") || !mcol.has("session_id") || !mcol.has("content")) {
      return [];
    }
    const person = [
      scol.has("parent_session_id") ? "(parent_session_id IS NULL OR parent_session_id = '')" : "1",
      scol.has("hidden") ? "COALESCE(hidden, 0) = 0" : "1",
      scol.has("source") ? "COALESCE(source, '') NOT IN (" + [...SKIP].map((s) => "'" + s + "'").join(",") + ")" : "1",
    ].join(" AND ");
    const pick = (c: string) => (scol.has(c) ? c : "NULL AS " + c);
    const rows = db.query(`SELECT id, ${pick("cwd")}, ${pick("title")} FROM sessions WHERE ${person} ORDER BY ${scol.has("started_at") ? "started_at" : "rowid"}`).all() as any[];
    const kept = [
      mcol.has("active") && mcol.has("compacted") ? "(COALESCE(active, 1) = 1 OR COALESCE(compacted, 0) = 1)" : "1",
      mcol.has("display_kind") ? "COALESCE(display_kind, '') NOT IN (" + HIDDEN.map((k) => "'" + k + "'").join(",") + ")" : "1",
      "role IN ('user', 'assistant', 'tool')",
    ].join(" AND ");
    const calls = mcol.has("tool_calls") ? "tool_calls" : "NULL AS tool_calls";
    const order = mcol.has("timestamp") ? "timestamp, id" : "id";
    const msgs  = db.query(`SELECT role, content, ${calls}, ${mcol.has("timestamp") ? "timestamp" : "NULL AS timestamp"} FROM messages WHERE session_id = ? AND ${kept} ORDER BY ${order}`);
    fs.mkdirSync(dir, { recursive: true });
    const found: Import.Session[] = [];
    for (const [k, row] of rows.entries()) {
      const file = dir + "/" + k + ".jsonl";
      const fd = fs.openSync(file, "w");
      try {
        let date = "";
        for (const m of msgs.iterate(row.id) as Iterable<any>) {
          for (const msg of row_msgs(m, date)) {
            date = msg.date;
            fs.writeSync(fd, JSON.stringify(msg) + "\n");
          }
        }
      } finally {
        fs.closeSync(fd);
      }
      const where = row.cwd ? "session in " + row.cwd : 'chat "' + String(row.title ?? "") + '"';
      const s = await Import.import_session(Bun.file(file), "msgs", "Hermes", where);
      if (s !== null) {
        found.push(s);
      } else {
        fs.rmSync(file, { force: true });
      }
    }
    return found;
  } finally {
    db.close();
  }
}

// a table's columns
function columns(db: Database, table: string): Set<string> {
  return new Set((db.query(`SELECT name FROM pragma_table_info('${table}')`).all() as any[]).map((r) => r.name));
}

// Messages
// ========

// a row's messages: a person's say (but Hermes's notices), Hermes's say
// and then its tool calls (their names and arguments), a tool's result
export function row_msgs(m: { role: string; content: unknown; tool_calls?: unknown; timestamp?: unknown }, last: string): Import.Msg[] {
  const date = row_date(m.timestamp, last);
  const text = typeof m.content === "string" ? m.content : m.content == null ? "" : String(m.content);
  switch (m.role) {
    case "user": {
      return NOTICE.test(text) ? [] : Import.msgs_of("user", text, date);
    }
    case "assistant": {
      return [...Import.msgs_of("unii", text, date), ...row_calls(m.tool_calls).flatMap((c) => Import.msgs_of("tool", c, date))];
    }
    case "tool": {
      return Import.msgs_of("echo", text, date);
    }
  }
  return [];
}

// a row's tool calls (OpenAI's shape, as JSON), each "name arguments"
function row_calls(raw: unknown): string[] {
  try {
    const calls = typeof raw === "string" && raw !== "" ? JSON.parse(raw) : [];
    return Array.isArray(calls) ? calls.map((c: any) => String(c?.function?.name ?? c?.name ?? "tool") + " " + String(c?.function?.arguments ?? c?.arguments ?? "")) : [];
  } catch {
    return [];
  }
}

// a row's time (unix seconds) as ISO; none or bad: `last`
function row_date(at: unknown, last: string): string {
  const s = typeof at === "number" ? at : Number(at);
  return Number.isFinite(s) && s > 0 ? new Date(s * 1000).toISOString() : last;
}
