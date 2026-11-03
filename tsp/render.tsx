// Tern-native transcript nodes, using the Hermes x Tern semantic role
// vocabulary. UniiChat's own View.Row is projected, not reinterpreted.
import type { JSX } from "@stencil-hq/tern";
import * as View from "../View.ts";
import type { Display } from "./projection.ts";

export type Navigation = {
  open(id: number, n: number): void;
  shut(id: number, n: number): void;
};

function fenced(content: string): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return fence + "\n" + content + "\n" + fence;
}

export function renderRows(rows: readonly Display[], on: Navigation): JSX.Element[] {
  return rows.map((row) => {
    switch (row.type) {
      case "caption":
        return <text key={row.key} role="unii.caption" spans={[{ s: "muted", t: row.text }]} wrap="word" />;
      case "summary":
        return row.call ? tool(row, false) : (
          <row key={row.key} role="unii.memory.summary" align="start" gap="sm" onClick={() => on.open(row.id, row.n)} title="Expand remembered messages">
            <icon key="arrow" name="chev" />
            <text key="level" spans={[{ s: "dim mono", t: View.block_name(row.id, row.n) }]} />
            <md key="text">{row.text}</md>
          </row>
        );
      case "expanded":
        return (
          <col key={row.key} role="unii.memory.expanded">
            <row key="head" role="unii.memory.collapse" onClick={() => on.shut(row.id, row.n)} gap="sm" title="Collapse remembered messages">
              <icon key="arrow" name="chev" />
              <text key="label" text={View.block_name(row.id, row.n) + " · fold"} />
            </row>
            <col key="children" role="unii.memory.children">{renderRows(row.children, on)}</col>
          </col>
        );
      case "message":
        if (row.call) {
          return tool(row, row.id === null);
        }
        if (row.kind === "user") {
          return (
            <card key={row.key} role="omp.user" tone="user">
              {row.images.length ? <text key="images" spans={[{ s: "muted", t: row.images.length + " image(s)" }]} /> : null}
              <md key="body">{row.text}</md>
            </card>
          );
        }
        if (row.kind === "unii") {
          return <col key={row.key} role="omp.assistant"><md key="body">{row.text}</md></col>;
        }
        if (row.kind === "mind") {
          return <col key={row.key} role="omp.thinking"><text key="name" spans={[{ s: "dim", t: "Thinking" }]} /><md key="body">{row.text}</md></col>;
        }
        if (row.kind === "echo") {
          return <col key={row.key} role="unii.tool.result"><text key="label" spans={[{ s: "dim mono", t: "Result" }]} /><md key="body">{fenced(row.text)}</md></col>;
        }
        return (
          <col key={row.key} role={row.kind === "work" ? "omp.agent.report" : "unii.message"}>
            {row.who ? <text key="who" spans={[{ s: "muted strong", t: row.who }]} /> : null}
            <md key="body">{row.text}</md>
          </col>
        );
    }
  });
}

function tool(row: Extract<Display, { type: "message" | "summary" }>, running: boolean): JSX.Element {
  const call = row.call;
  if (!call) {
    // The caller selects only rows parsed by UniiChat's Call.ts.
    throw new Error("Tool node requires a parsed call");
  }
  const name = call.name || "tool";
  const target = [call.head, call.device ? "on " + call.device : ""].filter(Boolean).join(" · ");
  return (
    <tool key={row.key} role="unii.tool" name={name} status={running ? "running" : "done"}
      title={target || name}
      collapsible={call.blocks.length > 0} collapsed={call.blocks.length > 0}>
      {call.blocks.map((block, i) => (
        <col key={"arg." + i} role="unii.tool.argument">
          {block.k ? <text key="key" spans={[{ s: "muted", t: block.k }]} /> : null}
          <md key="code">{fenced(block.x)}</md>
        </col>
      ))}
    </tool>
  );
}
