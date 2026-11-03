// UniiChat's View.ts remains the authority for transcript, OptMem blocks,
// live deltas, tool parsing and acts. Only stable native display keys live here.
import type { Call } from "../Call.ts";
import type { Kind } from "../AskAI.ts";
import * as View from "../View.ts";

export type Display =
  | { type: "caption"; key: string; text: string }
  | { type: "summary"; key: string; id: number; n: number; text: string; call: Call | null }
  | { type: "expanded"; key: string; id: number; n: number; text: string; children: Display[] }
  | { type: "message"; key: string; id: number | null; kind: Kind; who: string; text: string; call: Call | null; images: string[] };

export type Frame = {
  main: Display[];
  tail: Display[];
  connected: boolean;
  busy: boolean;
  typing: boolean;
  model: string | null;
  page: string | null;
  notes: string[];
};

export function projectRows(rows: View.Row[], scope: string): Display[] {
  return rows.map((row, i) => {
    const at = scope + "." + (row.$ === "Msg" && row.id !== null ? "msg." + row.id : i);
    switch (row.$) {
      case "Cap":
        return { type: "caption", key: at, text: row.text };
      case "Sum":
        return { type: "summary", key: scope + ".part." + row.id + "." + row.n, id: row.id, n: row.n, text: row.text, call: row.call };
      case "Box":
        return { type: "expanded", key: scope + ".part." + row.id + "." + row.n, id: row.id, n: row.n, text: row.text, children: projectRows(row.rows, at) };
      case "Msg":
        return { type: "message", key: at, id: row.id, kind: row.kind, who: row.who, text: row.text, call: row.call, images: row.images };
    }
  });
}

export function projectView(view: View.View): Frame {
  return {
    main: projectRows(View.view_body(view), "main"),
    tail: projectRows(View.view_tail(view), "tail"),
    connected: view.up,
    busy: view.busy,
    typing: View.view_typing(view),
    model: view.pick?.model ?? null,
    page: view.page?.name ?? null,
    notes: view.notes.slice(-3),
  };
}
