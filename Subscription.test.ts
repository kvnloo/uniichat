import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type Item } from "./Agent.ts";
import type { Ask, Event, Try, Vendor } from "./AskAI.ts";
import { Claude } from "./Claude.ts";
import { Codex } from "./Codex.ts";
import { Pick, LABELS } from "./Pick.ts";
import { Subscription } from "./Subscription.ts";
import { CLAUDE_MODELS, CODEX_MODELS } from "./SubscriptionModels.ts";

const CLAUDE: Ask = { vendor: "anthropic-sub", model: "claude-haiku-5-5", effort: "low", speed: "slow", system: "system", blocks: [], searches: 0, server: "" };
const CODEX: Ask = { ...CLAUDE, vendor: "openai-sub", model: "gpt-6-luna" };
const TOOL = { name: "echo", info: "Return text", schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };

type ClaudeBody = {
  tools: Array<{ name: string }>;
  system: Array<{ text: string }>;
  thinking: { type: string; budget_tokens?: number };
  messages: Array<{ content: Array<Record<string, unknown>> }>;
  max_tokens: number;
  output_config?: object;
};
type CodexBody = { service_tier?: string; reasoning: { effort: string }; store: boolean };

// All credentials below are synthetic, and every network request is intercepted.
async function credentials(go: (home: string) => unknown): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "unii-subscriptions-"));
  const before = { CODEX_HOME: process.env.CODEX_HOME, OMP_AGENT_DIR: process.env.OMP_AGENT_DIR };
  const db = new Database(path.join(home, "agent.db"));
  db.exec("CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT, credential_type TEXT, data TEXT, disabled_cause TEXT, updated_at INTEGER)");
  const put = db.query("INSERT INTO auth_credentials (provider,credential_type,data,disabled_cause,updated_at) VALUES (?, 'oauth', ?, NULL, 1)");
  put.run("anthropic", JSON.stringify({ access: "sk-ant-oat-synthetic", expires: Date.now() + 3600000 }));
  put.run("openai-codex", JSON.stringify({ access: "synthetic-codex", accountId: "synthetic-account", expires: Date.now() + 3600000 }));
  db.close();
  const access = "header." + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url") + ".signature";
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: { access_token: access, account_id: "synthetic-account" } }));
  process.env.CODEX_HOME = home;
  process.env.OMP_AGENT_DIR = home;
  try {
    await go(home);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function sse(events: unknown[]): Response {
  return new Response(events.map((ev) => "data: " + JSON.stringify(ev) + "\n\n").join(""));
}

function reply(vendor: Vendor, tool: boolean): Response {
  if (vendor === "openai-sub") {
    const item = tool
      ? { type: "function_call", name: "echo", call_id: "call_1", arguments: '{"text":"echoed"}' }
      : { type: "message", content: [{ type: "output_text", text: "done" }] };
    return sse([
      { type: "response.created" },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { status: "completed", output: [] } },
    ]);
  }
  return sse([
    { type: "message_start", message: { usage: {} } },
    { type: "content_block_start", index: 0, content_block: tool ? { type: "tool_use", id: "call_1", name: "_echo", input: { text: "echoed" } } : { type: "text", text: "done" } },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ]);
}

test("subscription catalogs contain all discovered text models without expanding API catalogs", () => {
  expect(CODEX_MODELS.map((m) => m.id)).toEqual(["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-reserve", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "codex-auto-review"]);
  expect(CLAUDE_MODELS).toHaveLength(14);
  expect(new Set(CLAUDE_MODELS.map((m) => m.id)).size).toBe(14);
  expect(Pick.models(["openai-api"], LABELS)).toHaveLength(3);
  expect(Pick.models(["claude-api"], LABELS)).toHaveLength(3);
  const offer = { vendors: ["openai-sub", "anthropic-sub"] as Vendor[], models: LABELS };
  expect(Pick.read({ ...CODEX, effort: "ultra" }, offer)).toBeNull();
  expect(Pick.read({ ...CODEX, model: "gpt-6-sol", effort: "ultra" }, offer)?.effort).toBe("ultra");
  expect(Pick.read({ ...CLAUDE, model: "sonnet-4.6", effort: "xhigh" }, offer)).toBeNull();
  expect(Pick.options({ ...CODEX, model: "gpt-6-sol" }, "effort", offer).map(([e]) => e)).toContain("ultra");
  expect(Pick.on({ ...CODEX, effort: "ultra" }, "anthropic-sub", Pick.model("anthropic-sub", "opus-4.5")!).effort).toBe("high");
});

test("subscription credentials reject API keys, invalid expiry, disabled and expired logins without modifying stores", () => credentials((home) => {
  const file = path.join(home, "agent.db");
  const before = fs.readFileSync(file);
  expect(Claude.key()).toBe("sk-ant-oat-synthetic");
  expect(JSON.parse(Codex.key()).account).toBe("synthetic-account");
  expect(fs.readFileSync(file)).toEqual(before);
  for (const data of [null, {}, { access: "private-api-key", expires: Date.now() + 10000 }, { access: "sk-ant-oat-private", expires: NaN }, { access: "sk-ant-oat-private", expires: 1 }]) {
    expect(() => Subscription.validate("anthropic", data)).toThrow();
  }
  const db = new Database(file);
  db.exec("UPDATE auth_credentials SET disabled_cause = 'disabled'");
  db.close();
  expect(() => Subscription.login("anthropic", file)).toThrow("No existing OMP anthropic OAuth subscription login.");
}));

test("Claude OAuth uses bearer auth, model-specific thinking and limits, and preserves signed tool replay", async () => {
  const headers = Claude.headers("sk-ant-oat-private", CLAUDE);
  expect(headers.authorization).toBe("Bearer sk-ant-oat-private");
  expect(headers["x-api-key"]).toBeUndefined();
  expect(headers["anthropic-beta"]).toContain("oauth-2025-04-20");
  const thinking = { type: "thinking", thinking: "private reasoning", signature: "opaque-signature" };
  const use = { type: "tool_use", id: "tool_1", name: "_echo", input: { text: "ok" } };
  const items: Item[] = [{ $: "User", parts: [{ text: "hello", mark: true }], imgs: [] }, { $: "Turn", out: [thinking, use] }, { $: "Back", backs: [{ id: "tool_1", out: { text: "ok", fail: false } }] }];
  // These are in-process request constructors, not unvalidated external JSON.
  const body = Claude.body(CLAUDE, items, [TOOL], 128000) as ClaudeBody;
  expect(body.tools[0].name).toBe("_echo");
  expect(TOOL.name).toBe("echo");
  expect(body.system[0].text).toContain("You are Claude Code");
  expect(body.thinking.type).toBe("adaptive");
  expect(body.messages[1].content).toEqual([thinking, use]);
  expect(body.messages[2].content[0].tool_use_id).toBe("tool_1");
  const legacy = Claude.body({ ...CLAUDE, model: "claude-haiku-4-5-20251001" }, [], [], 128000) as ClaudeBody;
  expect(legacy.max_tokens).toBe(64000);
  expect(legacy.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  expect(legacy.output_config).toBeUndefined();
  expect(() => Claude.body({ ...CLAUDE, model: "claude-sonnet-4-6", effort: "xhigh" }, [], [], 128000)).toThrow("Unsupported");
  expect(await Claude.wire.count("private", CLAUDE, {})).toBeNull();
  const st = Claude.wire.start(CLAUDE);
  Claude.wire.read(st, { type: "content_block_start", index: 0, content_block: use }, () => {});
  Claude.wire.read(st, { type: "message_delta", delta: { stop_reason: "tool_use" } }, () => {});
  const step = Claude.wire.step(st, CLAUDE);
  expect(step.uses[0].name).toBe("echo");
  expect(step.out[0]).toMatchObject({ name: "_echo" });
});

test("Codex speed and effort are sent rather than silently dropped", () => {
  const body = Codex.body({ ...CODEX, speed: "fast" }, [], [], 128000) as CodexBody;
  expect(body.service_tier).toBe("priority");
  expect(body.reasoning.effort).toBe("low");
  expect(body.store).toBe(false);
  expect(() => Codex.body({ ...CODEX, effort: "ultra" }, [], [], 128000)).toThrow("Unsupported");
  expect(() => Codex.body({ ...CODEX, speed: "ultrafast" }, [], [], 128000)).toThrow("Unsupported");
});

for (const ask of [CODEX, CLAUDE]) {
  test(ask.vendor + " preserves the native tool/send loop without API-price lookup", () => credentials(async () => {
    const real = globalThis.fetch;
    const events: Event[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    let tools = 0;
    let run: Try;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body: Record<string, unknown> = JSON.parse(String(init?.body));
      if (String(url) === "http://fixture/tools") {
        if (body.method === "tools/list") return Response.json({ result: { tools: [{ name: TOOL.name, description: TOOL.info, inputSchema: TOOL.schema }] } });
        tools++;
        expect(body.params).toEqual({ name: "echo", arguments: { text: "echoed" } });
        run.send({ text: "sent during tool", imgs: [] });
        return Response.json({ result: { content: [{ type: "text", text: "echoed" }] } });
      }
      expect(String(url)).toBe(ask.vendor === "openai-sub" ? Codex.wire.url : Claude.wire.url);
      bodies.push(body);
      return reply(ask.vendor, bodies.length === 1);
    }) as typeof fetch;
    try {
      expect(Agent.worst({ ...ask, model: "subscription-only-no-api-price" }, "{}", [], async () => { throw new Error("must not count"); })).toEqual({ input: 0, token: 0, exact: null });
      run = Agent.ask({ ...ask, server: "http://fixture/tools", blocks: [{ text: "use echo", mark: false }] }, (ev) => events.push(ev));
      expect(await run.done).toMatchObject({ ok: true, text: "done" });
      expect(tools).toBe(1);
      expect(bodies).toHaveLength(2);
      expect(JSON.stringify(bodies[1])).toContain("sent during tool");
      expect(JSON.stringify(bodies[1])).toContain(ask.vendor === "openai-sub" ? "function_call_output" : "tool_result");
      expect(events.some((ev) => ev.$ === "Entry" && ev.kind === "user" && ev.text === "sent during tool")).toBe(true);
    } finally {
      globalThis.fetch = real;
    }
  }));

  test(ask.vendor + " stop aborts the native in-flight request", () => credentials(async () => {
    const real = globalThis.fetch;
    const { promise: ready, resolve: started } = Promise.withResolvers<void>();
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal;
      started();
      const { promise, reject } = Promise.withResolvers<Response>();
      signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      return await promise;
    }) as typeof fetch;
    try {
      const run = Agent.ask(ask, () => {});
      await ready;
      run.stop();
      expect(await run.done).toMatchObject({ ok: false, text: "stopped" });
      expect(signal?.aborted).toBe(true);
    } finally {
      globalThis.fetch = real;
    }
  }));

  test(ask.vendor + " provider denial never falls back to an API or another provider", () => credentials(async () => {
    const real = { fetch: globalThis.fetch, error: console.error };
    const urls: string[] = [];
    const logs: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return Response.json({ error: { message: "subscription model access denied" } }, { status: 403 });
    }) as typeof fetch;
    console.error = (...args) => { logs.push(args.join(" ")); };
    try {
      const end = await Agent.ask(ask, () => {}).done;
      expect(end).toMatchObject({ ok: false, stop: "down" });
      expect(urls).toEqual([ask.vendor === "openai-sub" ? Codex.wire.url : Claude.wire.url]);
      expect(logs.join(" ")).toContain("HTTP 403: subscription model access denied");
    } finally {
      globalThis.fetch = real.fetch;
      console.error = real.error;
    }
  }));
}
