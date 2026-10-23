import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { UsageLedger } from "./UsageLedger.ts";
import { Codex } from "./Codex.ts";
import { Price } from "./Price.ts";
import type { Ask } from "./AskAI.ts";

const ASK: Ask = { vendor: "openai-sub", model: "gpt-6-luna", effort: "low", speed: "slow", system: "PRIVATE_PROMPT", blocks: [], searches: 0, server: "", role: "import", target: "0+2" };

test("ledger is opt-in, records exact usage and distinguishes missing counters from zero", () => {
  const old = process.env.UNII_USAGE_LEDGER;
  const dir = fs.mkdtempSync(os.tmpdir() + "/unii-ledger-test-");
  const file = dir + "/usage.jsonl";
  try {
    delete process.env.UNII_USAGE_LEDGER;
    const state = Codex.wire.start(ASK);
    const use = state.use;
    UsageLedger.append(ASK, use, Date.now(), 0, 200, "done", true, 0);
    expect(fs.existsSync(file)).toBe(false);
    process.env.UNII_USAGE_LEDGER = file;
    Codex.read(state, { type: "response.completed", response: { status: "completed", usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 }, output_tokens: 12 }, output: [] } }, () => {});
    UsageLedger.append(ASK, use, Date.now() - 5, 1, 200, "done", true, 11);
    UsageLedger.append(ASK, Price.usage("slow"), Date.now(), 2, 503, "busy", false, 0);
    const rows = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ role: "import", target: "0+2", model: ASK.model, effort: "low", input: 50, cached_read: 40, cache_write: 10, output: 12, retries: 1, error: null, usage_reported: true });
    expect(rows[0].latency_ms).toBeGreaterThanOrEqual(5);
    expect(rows[1]).toMatchObject({ input: null, cached_read: null, cache_write: null, output: null, retries: 2, status: 503, error: "busy", usage_reported: false });
    expect(fs.readFileSync(file, "utf8")).not.toContain("PRIVATE_PROMPT");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  } finally {
    if (old === undefined) delete process.env.UNII_USAGE_LEDGER;
    else process.env.UNII_USAGE_LEDGER = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
