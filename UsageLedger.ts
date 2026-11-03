// Optional, local request metrics. Never records prompts, credentials, or provider error text.
import * as fs from "node:fs";
import type { Ask } from "./AskAI.ts";
import type { Usage } from "./Price.ts";

const reported = new WeakSet<Usage>();

export namespace UsageLedger {
  // Called where OpenAI.usage fills the vendor's counters, before billing estimates.
  export function measured(use: Usage): void {
    reported.add(use);
  }

  export function append(ask: Ask, use: Usage, started: number, retries: number, status: number | null, stop: string, complete: boolean, outputBytes: number): void {
    const file = process.env.UNII_USAGE_LEDGER;
    if (!file) return;
    const exact = reported.has(use) || (ask.vendor !== "openai-api" && ask.vendor !== "openai-sub" && complete);
    const row = {
      at: new Date().toISOString(), role: ask.role ?? "chat", target: ask.target ?? null,
      vendor: ask.vendor, model: ask.model, effort: ask.effort,
      input: exact ? use.input : null, cached_read: exact ? use.read : null,
      cache_write: exact ? use.write : null, output: exact ? use.output : null,
      latency_ms: Date.now() - started, retries, status, error: ["done", "tools", "again"].includes(stop) ? null : stop,
      usage_reported: exact, output_bytes: outputBytes,
    };
    try {
      fs.appendFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600 });
    } catch {
      // An optional local trace must not fail a model call or expose paths.
      console.error("unii: cannot append usage ledger");
    }
  }
}
