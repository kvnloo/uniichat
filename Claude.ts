// Claude
// ======
// Claude Pro/Max OAuth through the native Messages wire. OMP owns the login;
// Unii reads it per step, and keeps its own tools, send, stop and compaction.

import type { Ask } from "./AskAI.ts";
import type { Item, Step, Tool } from "./Agent.ts";
import { Anthropic, type State } from "./Anthropic.ts";
import { Subscription } from "./Subscription.ts";
import { CLAUDE_MODELS } from "./SubscriptionModels.ts";

const VERSION = "2.1.280";
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const BUDGET: Record<string, number> = { low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 32768 };

type Body = {
  max_tokens: number;
  system: Array<{ type: string; text: string }>;
  thinking: { type: "adaptive"; display: "summarized" } | { type: "enabled"; budget_tokens: number };
  output_config?: { effort: string };
} & Record<string, unknown>;

export namespace Claude {

  export function key(): string {
    return Subscription.login("anthropic").access;
  }

  export function headers(key: string, ask: Ask): Record<string, string> {
    const betas = ["claude-code-20250219", "oauth-2025-04-20", "interleaved-thinking-2025-05-14"];
    if (ask.speed === "fast") betas.push("fast-mode-2026-02-01");
    return {
      authorization: "Bearer " + key,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": betas.join(","),
      "content-type": "application/json",
      accept: "text/event-stream",
      "user-agent": "claude-cli/" + VERSION + " (external, cli)",
      "x-app": "cli",
    };
  }

  export function body(ask: Ask, items: Item[], tools: Tool[], max: number): unknown {
    const model = CLAUDE_MODELS.find((m) => m.id === ask.model);
    if (!model) throw new Error("Unknown Anthropic subscription model: " + ask.model);
    if (!model.efforts?.includes(ask.effort) || !model.speeds.includes(ask.speed)) {
      throw new Error("Unsupported Anthropic subscription effort or speed for " + ask.model);
    }
    // Custom OAuth tools occupy a separate namespace. Replay the original wire
    // blocks unchanged, including names, signatures and opaque thinking data.
    const defs = tools.map((t) => ({ ...t, name: "_" + t.name }));
    // Anthropic.body is our in-process constructor, not unvalidated wire data.
    const body = Anthropic.body(ask, items, defs, Math.min(max, model.max)) as Body;
    body.system.unshift({ type: "text", text: IDENTITY });
    body.thinking = model.adaptive
      ? { type: "adaptive", display: "summarized" }
      : { type: "enabled", budget_tokens: Math.min(BUDGET[ask.effort], body.max_tokens - 1) };
    if (!model.effort) delete body.output_config;
    return body;
  }

  export function step(st: State, ask: Ask): Step {
    const step = Anthropic.step(st, ask);
    return {
      ...step,
      uses: step.uses.map((use) => ({ ...use, name: use.name.startsWith("_") ? use.name.slice(1) : use.name })),
      entries: step.entries.map((entry) => entry.kind === "tool" && entry.text.startsWith("_") ? { ...entry, text: entry.text.slice(1) } : entry),
    };
  }

  export const wire: typeof Anthropic.wire = {
    ...Anthropic.wire,
    key: Claude.key,
    url: "https://api.anthropic.com/v1/messages?beta=true",
    headers: Claude.headers,
    body: Claude.body,
    // The API-key token-count path must never receive a subscription credential.
    count: async () => null,
    read: (st, ev, on) => Anthropic.read(st, ev, (kind, text, fresh) => on(kind, kind === "tool" && fresh && text.startsWith("_") ? text.slice(1) : text, fresh)),
    step: Claude.step,
  };

}
