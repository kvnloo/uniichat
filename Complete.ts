// Complete
// ========
// Local, non-executing command suggestions. Values come from the live view;
// paths read one directory only. Free text, money and deletion confirmations
// are never invented or accepted on the user's behalf.

import * as fs from "node:fs";
import * as os from "node:os";
import { Pick, type Move } from "./Pick.ts";
import * as View from "./View.ts";

export type Command = { use: string; description: string };
export type Choice = { text: string; pos: number; label: string; description: string; more: boolean };

export function choices(text: string, pos: number, commands: Command[], view: View.View, sessions = 0): Choice[] {
  if (!text.startsWith("/") || text.includes("\n")) return [];
  const head = text.slice(0, pos);
  const command = /^\/[a-z]*$/.test(head) && !/\s/.test(text);
  if (command) {
    return commands.filter((c) => c.use.startsWith(head)).map((c) => {
      const name = c.use.split(" ")[0];
      const value = name + (c.use.includes(" ") ? " " : "");
      return { text: value, pos: value.length, label: c.use, description: c.description, more: value.endsWith(" ") };
    });
  }
  const match = /^(\/[a-z]+\s+)(.*)$/.exec(head);
  if (!match) return [];
  const name = match[1].trim();
  if (!commands.some((c) => c.use.split(" ")[0] === name)) return [];
  const arg = match[2];
  const suffix = text.slice(pos);
  const result = (value: string, description: string, more = false): Choice => ({
    text: match[1] + value + suffix.replace(/^\S*/, ""),
    pos: match[1].length + value.length,
    label: value,
    description,
    more,
  });
  const filter = (values: Array<[string, string]>): Choice[] => values
    .filter(([value]) => value.toLowerCase().includes(arg.toLowerCase()))
    .map(([value, description]) => result(value, description));
  if (["/model", "/effort", "/speed"].includes(name)) {
    if (!view.pick) return [];
    const move = name.slice(1) as Move;
    return Pick.options(view.pick, move, view).filter(([value]) => value.toLowerCase().includes(arg.toLowerCase()))
      .map(([value, pick]) => result(value, move === "model" ? pick.vendor + (value === view.pick?.model ? " · current" : "") : move));
  }
  if (name === "/tab") return filter(View.view_tabs(view).map((tab) => [tab.name ?? View.MAIN, "chat tab"]));
  if (name === "/stop") return filter(view.agents.map((agent) => [agent, "running agent"]));
  if (name === "/open" || name === "/close") {
    const blocks: Array<[string, string]> = [];
    const walk = (rows: View.Row[]) => {
      for (const row of rows) {
        if (row.$ === "Sum" || row.$ === "Box") {
          blocks.push([View.block_name(row.id, row.n), "memory block"]);
        }
        if (row.$ === "Box") walk(row.rows);
      }
    };
    walk(View.view_body(view));
    return filter([...new Map(blocks).entries()]);
  }
  if (name === "/image") return paths(arg, false).map(([value, directory]) => result(value, directory ? "directory" : "image file", directory));
  if (name === "/import") {
    const start = arg.lastIndexOf(" ") + 1;
    const before = arg.slice(0, start);
    const token = arg.slice(start);
    const used = before.trim().toLowerCase().split(/\s+/);
    // 'since' takes an explicit date, never a made-up timestamp.
    if (used.includes("pause") || used.includes("resume")) return [];
    if (used.at(-1) === "since") return [];
    const flags = ["claude", "chatgpt", "since", "tools", "sessions", "go", ...Array.from({ length: sessions }, (_, i) => "-#" + (i + 1)), ...(before ? [] : ["pause", "resume"])];
    const options = flags.filter((flag) => !used.includes(flag) && flag.startsWith(token.toLowerCase()))
      .map((flag) => result(before + flag + " ", "import option", true));
    return [...options, ...paths(token, true).map(([value, directory]) => result(before + value, directory ? "directory" : "chat export", directory))];
  }
  return [];
}

function paths(typed: string, exports: boolean): Array<[string, boolean]> {
  const quote = typed.startsWith('"') || typed.startsWith("'") ? typed[0] : "";
  const raw = (quote ? typed.slice(1).replace(new RegExp(quote + "$"), "") : typed).replace(/\\(.)/g, "$1");
  const slash = raw.lastIndexOf("/");
  const prefix = raw.slice(0, slash + 1);
  const fragment = raw.slice(slash + 1);
  const dir = (prefix || ".").replace(/^~(?=\/|$)/, os.homedir());
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (/[\x00-\x1f\x7f]/.test(entry.name) || !entry.name.startsWith(fragment) || (entry.name.startsWith(".") && !fragment.startsWith("."))) return [];
      // Import's parser accepts whitespace-separated files, not shell quoting.
      if (exports && /\s/.test(entry.name)) return [];
      let directory = entry.isDirectory();
      let file = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stat = fs.statSync(dir + "/" + entry.name);
          directory = stat.isDirectory();
          file = stat.isFile();
        } catch {
          return [];
        }
      }
      return directory || (file && (exports ? /\.(zip|json)$/i : /\.(png|jpe?g|webp|gif)$/i).test(entry.name))
        ? [{ name: entry.name, directory }] : [];
    }).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
      .map((entry): [string, boolean] => {
        const directory = entry.directory;
        const value = prefix + entry.name + (directory ? "/" : "");
        const escaped = exports ? value : quote ? quote + value + (directory ? "" : quote) : value.replace(/[\\\s'\"]/g, "\\$&");
        return [escaped, directory];
      });
  } catch {
    return [];
  }
}
