// Acp
// ===
// `unii acp`: UniiChat as an Agent Client Protocol agent (ACP,
// agentclientprotocol.com), for editors and agent hosts such as T3 Code,
// Zed or JetBrains. It speaks JSON-RPC, one message per line, on stdin
// and stdout; it is a view of the chat and a device, as Term.ts is, by
// View.ts's Link.
//
// UniiChat has one chat, so every ACP session is a view of that same chat:
// what one prompts, the others (the site, a unii) see. A session is a
// device of its own, named after this computer and its cwd, so the
// agent's tools reach that folder: its work dir is a dir under HOME/acp
// whose agents' dirs (main, and each subagent's) are links to the cwd.
// A prompt sends a message and streams what follows (its thoughts, its
// reply, its tool calls and their results) until no work runs; a cancel
// stops all work. Nothing but ACP goes to stdout; notes go to stderr.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as Call from "./Call.ts";
import { Machine, type Job } from "./Machine.ts";
import * as View from "./View.ts";

// Types
// =====

// a JSON-RPC message: a request (id and method), a notification (method),
// an answer (id, result or error)
type Rpc = { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: any; result?: any; error?: { code: number; message: string } };

// a turn being prompted: whether the chat worked since it was sent (a
// message taken by the turn running joins it), when its message was
// answered (0: not yet), its end
type Turn = { worked: boolean; acked: number; end: (reason: "end_turn" | "cancelled") => void; cancelled: boolean };

// a session: its id, its cwd, its view, the jobs running here, the tool
// calls shown and not yet answered (by the order the chat logs them), the
// turn prompted (null: none), whether its reply streamed since its last
// entry
type Session = {
  id      : string;
  cwd     : string;
  work    : string;
  v       : View.View;
  jobs    : Map<string, AbortController>;
  calls   : string[];
  turn    : Turn | null;
  streamed: boolean;
};

// what Term.ts gives: the server, its session's header, this device
export type Host = { url: string; auth: () => Record<string, string>; device: string; home: string; version: string };

// Constants
// =========

const PROTOCOL = 1;

// a turn whose message was answered and that saw no work this long ended
// at once (it went to a turn already running, which then ended) (ms)
const IDLE = 3000;

// the ACP tool kinds of UniiChat's tools
const KINDS: Record<string, string> = { shell: "execute", read: "read", write: "edit", edit: "edit", zoom: "search", date: "search", spawn: "other", tell: "other", computer: "other" };

// Acp
// ===

export async function acp(host: Host): Promise<void> {
  const sessions = new Map<string, Session>();
  let buf = "";

  function write(msg: object): void {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  }
  function update(s: Session, update: object): void {
    write({ method: "session/update", params: { sessionId: s.id, update } });
  }
  function text(s: Session, kind: "agent_message_chunk" | "agent_thought_chunk", body: string): void {
    if (body !== "") {
      update(s, { sessionUpdate: kind, content: { type: "text", text: body } });
    }
  }

  // Requests
  // --------

  async function handle(msg: Rpc): Promise<void> {
    if (msg.method === undefined) {
      return; // an answer: this agent asks the client nothing
    }
    const reply = (result: unknown): void => {
      if (msg.id !== undefined) {
        write({ id: msg.id, result });
      }
    };
    const fail = (code: number, message: string): void => {
      if (msg.id !== undefined) {
        write({ id: msg.id, error: { code, message } });
      }
    };
    try {
      switch (msg.method) {
        case "initialize": {
          return reply({
            protocolVersion   : PROTOCOL,
            agentCapabilities : { loadSession: false, promptCapabilities: { image: true, audio: false, embeddedContext: true } },
            agentInfo         : { name: "unii", title: "UniiChat", version: host.version },
            authMethods       : [],
          });
        }
        case "authenticate": {
          return reply({});
        }
        case "session/new": {
          if (!await signed(host)) {
            return fail(-32000, "unii is signed out of " + host.url + ": run `unii login` in a terminal first.");
          }
          const s = session_new(host, String(msg.params?.cwd ?? process.cwd()));
          sessions.set(s.id, s);
          connect(s);
          return reply({ sessionId: s.id });
        }
        case "session/prompt": {
          const s = sessions.get(String(msg.params?.sessionId));
          if (s === undefined) {
            return fail(-32602, "No session " + msg.params?.sessionId + ".");
          }
          return reply({ stopReason: await prompt(s, msg.params?.prompt ?? []) });
        }
        case "session/cancel": {
          const s = sessions.get(String(msg.params?.sessionId));
          if (s?.turn != null) {
            s.turn.cancelled = true;
            View.link_send(s.v, { $: "stop" }, () => s.turn?.end("cancelled"));
          }
          return;
        }
        default: {
          return fail(-32601, "Method not found: " + msg.method);
        }
      }
    } catch (err: any) {
      fail(-32603, String(err?.message ?? err));
    }
  }

  // a prompt: its message sent; ends once no work runs, or as cancelled
  function prompt(s: Session, blocks: any[]): Promise<"end_turn" | "cancelled"> {
    const { said, images } = prompt_read(blocks);
    if (s.turn !== null) {
      s.turn.end("end_turn");
    }
    return new Promise((resolve) => {
      const turn: Turn = {
        worked    : View.view_running(s.v),
        acked     : 0,
        cancelled : false,
        end       : (reason) => {
          if (s.turn === turn) {
            s.turn = null;
            resolve(turn.cancelled ? "cancelled" : reason);
          }
        },
      };
      s.turn = turn;
      s.streamed = false;
      const blob = new Blob([...images, said]);
      View.link_send(s.v, { $: "say", sizes: images.map((b) => b.size), body: () => blob }, (a) => {
        if (a.error !== undefined) {
          text(s, "agent_message_chunk", "UniiChat refused the message: " + a.error);
          turn.end("end_turn");
          return;
        }
        turn.acked = Date.now();
        setTimeout(() => turn_check(s), IDLE);
      }, said);
    });
  }

  // a turn ends once the chat worked and rests, or rested since its
  // message was taken
  function turn_check(s: Session): void {
    const turn = s.turn;
    if (turn === null || View.view_running(s.v)) {
      return;
    }
    if (turn.worked || (turn.acked > 0 && Date.now() - turn.acked >= IDLE)) {
      turn.end("end_turn");
    }
  }

  // Server
  // ------

  function connect(s: Session): void {
    const dev = "&device=" + encodeURIComponent(device_name(host, s.cwd)) + "&computer=0&work=" + encodeURIComponent(s.work);
    View.link_open(s.v, {
      open : (query) => new WebSocket(host.url.replace(/^http/, "ws") + "/ws" + query + dev, { headers: host.auth() } as any),
      post : (p, body) => fetch(host.url + p, { method: "POST", headers: host.auth(), body }),
      hear : (msg) => hear(s, msg),
      lost : async (up) => up || await signed(host),
    });
  }

  function hear(s: Session, msg: View.Server): void {
    const notes = s.v.notes.length;
    for (const out of View.view_hear(s.v, msg)) {
      View.link_send(s.v, out);
    }
    if (msg.$ === "job" || msg.$ === "jobs") {
      jobs(s, msg);
      return;
    }
    const turn = s.turn;
    if (turn === null) {
      s.v.notes.length = 0;
      return;
    }
    s.v.notes.slice(notes).forEach((n) => text(s, "agent_message_chunk", "\n\n_" + n + "_\n\n"));
    s.v.notes.length = 0;
    switch (msg.$) {
      case "delta": {
        if (msg.agent === undefined && msg.kind === "unii") {
          s.streamed = true;
          text(s, "agent_message_chunk", msg.text);
        } else if (msg.agent === undefined && msg.kind === "mind") {
          text(s, "agent_thought_chunk", msg.text);
        }
        return;
      }
      case "entry": {
        if (msg.agent === undefined && msg.id !== undefined) {
          entry(s, msg.kind, msg.text);
        }
        return;
      }
      case "state": {
        turn.worked ||= msg.busy || msg.agents.length > 0;
        turn_check(s);
        return;
      }
    }
  }

  // a message the chat logged while prompted: a reply not streamed, a
  // tool call (shown running) or its result, an agent's report
  function entry(s: Session, kind: string, body: string): void {
    const streamed = s.streamed;
    s.streamed = false;
    switch (kind) {
      case "unii": {
        if (!streamed) {
          text(s, "agent_message_chunk", body);
        }
        return;
      }
      case "note": {
        text(s, "agent_message_chunk", "\n\n_" + body + "_\n\n");
        return;
      }
      case "work": {
        const report = Call.report_read(body);
        text(s, "agent_thought_chunk", report === null ? body : "[" + report.name + "] " + report.text);
        return;
      }
      case "tool": {
        const id   = crypto.randomUUID();
        const call = Call.call_parse(body);
        const json = /^\S+ (\{[\s\S]*)$/.exec(body)?.[1];
        let input: unknown = undefined;
        try {
          input = json === undefined ? undefined : JSON.parse(json);
        } catch {}
        s.calls.push(id);
        update(s, {
          sessionUpdate : "tool_call",
          toolCallId    : id,
          title         : ((call.name + " " + Call.call_line(call)).trim() || body).slice(0, 200),
          kind          : KINDS[call.name] ?? "other",
          status        : "in_progress",
          rawInput      : input,
        });
        return;
      }
      case "echo": {
        const id = s.calls.shift();
        if (id !== undefined) {
          update(s, { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", content: [{ type: "content", content: { type: "text", text: body } }] });
        }
        return;
      }
    }
  }

  // Jobs
  // ----

  // the server's word on this session's jobs: a job, run unless it runs
  // or its output waits for an answer; or their ids, the rest halted
  function jobs(s: Session, msg: View.Server & { $: "jobs" | "job" }): void {
    if (msg.$ === "job") {
      const sent = s.v.out.some((p) => p.msg.$ === "out" && p.msg.job === msg.id);
      if (!s.jobs.has(msg.id) && !sent) {
        run(s, msg.id, msg.job as Job);
      }
      return;
    }
    for (const [id, abort] of s.jobs) {
      if (!msg.ids.includes(id)) {
        abort.abort();
      }
    }
  }

  async function run(s: Session, id: string, job: Job): Promise<void> {
    const abort = new AbortController();
    s.jobs.set(id, abort);
    work_link(s, job.cwd);
    const out  = job.name === "computer" ? { text: "This ACP session does no computer use.", fail: true } : await Machine.run(job, s.work, abort.signal);
    const size = Buffer.byteLength(JSON.stringify(out));
    const most = View.FRAME - 1024;
    const big  = { text: "The output, " + size + " bytes, is over the " + most + " a tool may send.", fail: true };
    s.jobs.delete(id);
    View.link_send(s.v, { $: "out", job: id, out: size > most ? big : out });
  }

  // Stdio
  // -----

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    let at: number;
    while ((at = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, at).trim();
      buf = buf.slice(at + 1);
      if (line === "") {
        continue;
      }
      let msg: Rpc;
      try {
        msg = JSON.parse(line);
      } catch {
        write({ id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      void handle(msg);
    }
  });
  const bye = () => {
    for (const s of sessions.values()) {
      s.v.ws?.close(View.QUIT);
    }
    Machine.end();
    process.exit(0);
  };
  process.stdin.on("end", bye);
  for (const sig of ["SIGHUP", "SIGTERM", "SIGINT"]) {
    process.on(sig, bye);
  }
}

// Sessions
// ========

function session_new(host: Host, cwd: string): Session {
  const real = path.resolve(cwd);
  const work = path.join(host.home, "acp", crypto.createHash("sha256").update(real).digest("hex").slice(0, 16));
  const s: Session = { id: crypto.randomUUID(), cwd: real, work, v: View.view_new(), jobs: new Map(), calls: [], turn: null, streamed: false };
  fs.mkdirSync(work, { recursive: true, mode: 0o700 });
  work_link(s, "main");
  return s;
}

// an agent's dir in the session's work dir: a link to its cwd, so each
// agent works there (a real dir already there is left as it is)
function work_link(s: Session, agent: string): void {
  const at = path.join(s.work, path.basename(agent));
  try {
    if (fs.lstatSync(at).isSymbolicLink() && fs.readlinkSync(at) !== s.cwd) {
      fs.unlinkSync(at);
    } else {
      return;
    }
  } catch {}
  try {
    fs.symlinkSync(s.cwd, at, "dir");
  } catch (err: any) {
    process.stderr.write("unii acp: " + at + ": " + err.message + "\n");
  }
}

// the device a session is, to the agent: this computer's, then its
// folder's name
function device_name(host: Host, cwd: string): string {
  return host.device + "-" + (path.basename(cwd) || "root");
}

// Prompt
// ======

// an ACP prompt as a UniiChat message: its text, a resource as its uri
// (its text, if embedded), its images
export function prompt_read(blocks: any[]): { said: string; images: Blob[] } {
  const parts: string[] = [];
  const images: Blob[] = [];
  for (const b of blocks) {
    if (b?.type === "text") {
      parts.push(String(b.text));
    } else if (b?.type === "image" && typeof b.data === "string") {
      images.push(new Blob([Buffer.from(b.data, "base64")], { type: String(b.mimeType ?? "image/png") }));
    } else if (b?.type === "resource_link") {
      parts.push(String(b.uri));
    } else if (b?.type === "resource" && b.resource !== undefined) {
      const r = b.resource;
      parts.push(typeof r.text === "string" ? "<file uri=\"" + r.uri + "\">\n" + r.text + "\n</file>" : String(r.uri));
    }
  }
  return { said: parts.join("\n\n"), images };
}

async function signed(host: Host): Promise<boolean> {
  const auth = host.auth();
  if (auth.authorization === undefined) {
    return false;
  }
  const res = await fetch(host.url + "/api/me", { headers: auth }).catch(() => null);
  return res === null || res.status !== 401;
}
