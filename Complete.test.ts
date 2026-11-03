import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { choices } from "./Complete.ts";
import * as View from "./View.ts";
import { LABELS } from "./Pick.ts";

const COMMANDS = ["/model [name]", "/effort [level]", "/speed [speed]", "/tab [name]", "/stop [name]", "/open #id", "/close #id", "/import [...]", "/image <path>", "/goal <message>", "/topup <usd>", "/delete <name>"].map((use) => ({ use, description: use }));

function view(): View.View {
  const v = View.view_new();
  v.vendors = ["openai-sub", "anthropic-sub"];
  v.models = LABELS;
  v.pick = { vendor: "openai-sub", model: "gpt-6-luna", effort: "low", speed: "slow" };
  return v;
}

test("model completion uses enabled catalogs and the selected model's valid effort and speed choices", () => {
  const v = view();
  expect(choices("/model SOL", 10, COMMANDS, v).map((c) => c.label)).toContain("gpt-6.1-sol");
  v.models = ["gpt-6-luna", "opus-4.5"];
  expect(choices("/model ", 7, COMMANDS, v).map((c) => c.label)).toEqual(["gpt-6-luna", "opus-4.5"]);
  v.pick = { vendor: "anthropic-sub", model: "opus-4.5", effort: "low", speed: "slow" };
  expect(choices("/effort ", 8, COMMANDS, v).map((c) => c.label)).toEqual(["low", "medium", "high"]);
  expect(choices("/speed ", 7, COMMANDS, v).map((c) => c.label)).toEqual(["slow"]);
});

test("completion replaces the token at the cursor without losing later input, and uses live agent/block state", () => {
  const v = view();
  const text = "/model gpt-6-luZZ later";
  const match = choices(text, 15, COMMANDS, v).find((c) => c.label === "gpt-6-luna");
  expect(match?.text).toBe("/model gpt-6-luna later");
  expect(match?.pos).toBe("/model gpt-6-luna".length);
  v.agents = ["Mira", "Orion"];
  v.parts = [[4, 2]];
  expect(choices("/stop mi", 8, COMMANDS, v).map((c) => c.text)).toEqual(["/stop Mira"]);
  expect(choices("/tab uni", 8, COMMANDS, v).map((c) => c.text)).toEqual(["/tab UniiChat"]);
  expect(choices("/open #4", 8, COMMANDS, v).map((c) => c.text)).toEqual(["/open #4+2"]);
  v.agents = [];
  expect(choices("/stop mi", 8, COMMANDS, v)).toEqual([]);
});

test("import options keep earlier flags, exclude duplicates and only offer known session numbers", () => {
  const v = view();
  const text = "/import claude se";
  expect(choices(text, text.length, COMMANDS, v).map((c) => c.text)).toEqual(["/import claude sessions "]);
  const flags = "/import tools ";
  expect(choices(flags, flags.length, COMMANDS, v).some((c) => c.text === "/import tools tools ")).toBe(false);
  expect(choices("/import -#", 10, COMMANDS, v, 2).map((c) => c.text)).toEqual(["/import -#1 ", "/import -#2 "]);
  for (const input of ["/import since ", "/import pause ", "/goal arbitrary", "/topup ", "/delete ", "hello /model", "/model\n"]) {
    expect(choices(input, input.length, COMMANDS, v)).toEqual([]);
  }
});

test("path completion distinguishes directories, image files and exports, including quoted image paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unii-completion-"));
  try {
    fs.mkdirSync(path.join(dir, "photos"));
    fs.writeFileSync(path.join(dir, "night light.png"), "image");
    fs.writeFileSync(path.join(dir, "chats.json"), "{}");
    fs.writeFileSync(path.join(dir, "notes.txt"), "text");
    const image = '/image "' + dir + '/night';
    expect(choices(image, image.length, COMMANDS, view()).map((c) => c.text)).toEqual(['/image "' + dir + '/night light.png"']);
    const exports = "/import claude " + dir + "/";
    expect(choices(exports, exports.length, COMMANDS, view()).map((c) => c.text)).toEqual([exports + "photos/", exports + "chats.json"]);
    const missing = "/image " + dir + "/missing/";
    expect(choices(missing, missing.length, COMMANDS, view())).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
