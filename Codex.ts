// Codex
// =====
// ChatGPT subscription calls through the Codex Responses endpoint, in the
// same agent/tool loop as the APIs. Credentials are read from Codex CLI's
// auth.json for each step, never copied to Unii or inherited by its tools.
// Codex owns login and refresh: run `codex login` if its session expires.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Ask } from "./AskAI.ts";
import type { Emit, Item, Tool, Wire } from "./Agent.ts";
import { OpenAI, type State as OpenAIState } from "./OpenAI.ts";

type State = OpenAIState & { items: Map<number, unknown> };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export namespace Codex {

  export function key(): string {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    let auth: unknown;
    try {
      auth = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8"));
    } catch {
      throw new Error("No Codex subscription login: run `codex login` on the server.");
    }
    const tokens = auth !== null && typeof auth === "object" && "tokens" in auth ? auth.tokens : null;
    const access = tokens !== null && typeof tokens === "object" && "access_token" in tokens ? tokens.access_token : null;
    const account = tokens !== null && typeof tokens === "object" && "account_id" in tokens ? tokens.account_id : null;
    if (typeof access !== "string" || !access || typeof account !== "string" || !account) {
      throw new Error("No Codex subscription login: run `codex login` with your ChatGPT account (not an API key).");
    }
    let expiry: unknown;
    try {
      const claims: unknown = JSON.parse(Buffer.from(access.split(".")[1], "base64url").toString());
      expiry = claims !== null && typeof claims === "object" && "exp" in claims ? claims.exp : null;
    } catch {
      throw new Error("Invalid Codex subscription login: run `codex login` again.");
    }
    if (typeof expiry !== "number" || !Number.isFinite(expiry) || expiry * 1000 <= Date.now()) {
      throw new Error("Codex subscription login expired: run `codex login` again.");
    }
    return JSON.stringify({ access, account });
  }

  export function body(ask: Ask, items: Item[], tools: Tool[], _max: number): unknown {
    const input = items.flatMap((item): unknown[] => item.$ === "User"
      ? [{ role: "user", content: [
          ...item.parts.map((p) => ({ type: "input_text", text: p.text })),
          ...item.imgs.map(OpenAI.image),
        ] }]
      : OpenAI.input(item));
    const defs: object[] = tools.map((t) => ({ type: "function", name: t.name, description: t.info, parameters: t.schema }));
    if (ask.searches > 0) {
      defs.push({ type: "web_search" });
    }
    return {
      model        : ask.model,
      instructions : ask.system,
      input,
      tools        : defs,
      reasoning    : { effort: ask.effort, summary: "auto", context: "all_turns" },
      include      : ["reasoning.encrypted_content"],
      store        : false,
      stream       : true,
    };
  }

  // Codex can omit every output item from response.completed. The item-done
  // events, not the terminal envelope, are then the authoritative transcript.
  export function read(st: State, ev: unknown, on: Emit): boolean {
    if (!record(ev)) {
      throw new Error("Invalid Codex stream event.");
    }
    if (ev.type === "response.output_item.done" && typeof ev.output_index === "number" && record(ev.item)) {
      st.items.set(ev.output_index, ev.item);
    }
    if ((ev.type === "response.completed" || ev.type === "response.done") && record(ev.response)) {
      const output = Array.isArray(ev.response.output) && ev.response.output.length > 0
        ? ev.response.output
        : [...st.items].sort(([a], [b]) => a - b).map(([, item]) => item);
      return OpenAI.read(st, { ...ev, type: "response.completed", response: { ...ev.response, output } }, on);
    }
    return OpenAI.read(st, ev, on);
  }

  export const wire: Wire<State> = {
    ...OpenAI.wire,
    key     : Codex.key,
    url     : "https://chatgpt.com/backend-api/codex/responses",
    headers : (key) => {
      const { access, account } = JSON.parse(key);
      return {
        authorization        : "Bearer " + access,
        "chatgpt-account-id" : account,
        "content-type"       : "application/json",
        accept               : "text/event-stream",
      };
    },
    body    : Codex.body,
    start   : (ask) => ({ ...OpenAI.wire.start(ask), items: new Map() }),
    read    : Codex.read,
  };

}
