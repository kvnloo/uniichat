import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Codex } from "./Codex.ts";
import type { Ask } from "./AskAI.ts";

const ASK: Ask = { vendor: "openai-sub", model: "gpt-6-luna", effort: "low", speed: "slow", system: "test", blocks: [], searches: 0, server: "" };

test("Codex's empty completion preserves text, tool calls and encrypted reasoning in output order", () => {
  const st = Codex.wire.start(ASK);
  const reasoning = { type: "reasoning", encrypted_content: "opaque", summary: [] };
  const tool = { type: "function_call", name: "shell", call_id: "call_1", arguments: '{"command":"pwd"}' };
  const message = { type: "message", content: [{ type: "output_text", text: "Checking the directory." }] };
  for (const [output_index, item] of [[2, message], [0, reasoning], [1, tool]] as const) {
    Codex.read(st, { type: "response.output_item.done", output_index, item }, () => {});
  }
  expect(Codex.read(st, { type: "response.completed", response: { status: "completed", output: [] } }, () => {})).toBe(true);
  const step = Codex.wire.step(st, ASK);
  expect(step.stop).toBe("tools");
  expect(step.out).toEqual([reasoning, tool, message]);
  expect(step.uses).toEqual([{ id: "call_1", name: "shell", input: { command: "pwd" } }]);
  expect(step.entries.find((entry) => entry.kind === "unii")?.text).toBe("Checking the directory.");
});

test("Codex's complete terminal output supersedes partial item events", () => {
  const st = Codex.wire.start(ASK);
  Codex.read(st, { type: "response.output_item.done", output_index: 0, item: { type: "message", content: [{ type: "output_text", text: "partial" }] } }, () => {});
  Codex.read(st, { type: "response.done", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "final" }] }] } }, () => {});
  expect(Codex.wire.step(st, ASK).entries).toEqual([{ kind: "unii", text: "final" }]);
});

test("Codex rejects expired and API-key credentials without exposing or changing them", () => {
  const before = process.env.CODEX_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "unii-codex-auth-"));
  process.env.CODEX_HOME = home;
  try {
    const token = "header." + Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url") + ".signature";
    const expired = JSON.stringify({ tokens: { access_token: token, account_id: "private-account", refresh_token: "private-refresh" } });
    fs.writeFileSync(path.join(home, "auth.json"), expired);
    expect(() => Codex.key()).toThrow("Codex subscription login expired; let Codex or OMP refresh its login, then retry.");
    expect(fs.readFileSync(path.join(home, "auth.json"), "utf8")).toBe(expired);
    fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "private-api-key" }));
    expect(() => Codex.key()).toThrow("The Codex login is not a ChatGPT subscription OAuth login.");
  } finally {
    if (before === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = before;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
