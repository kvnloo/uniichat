// TSP chat transport. Shares the same View.ts Link and server actions as
// Term.ts and web/src/main.ts, with no server protocol or session fork.
// A Tern pane is a tab, not a device: it must not claim device jobs until
// native execution/interrupt bridging is implemented.
import type { EditEvent, Key, SendEvent, Session, Surface } from "@stencil-hq/tern";
import * as View from "../View.ts";
import { Editor } from "./editor.ts";
import { projectView } from "./projection.ts";
import { renderRows } from "./render.tsx";

const INPUT = "dock.composer.line.input";

export class NativeChat {
  readonly view = View.view_new();
  readonly editor = new Editor();
  readonly #tern: Session;
  readonly #surface: Surface;
  readonly #url: string;
  readonly #auth: Record<string, string>;
  #alive = false;
  #queued = false;

  constructor(tern: Session, url: string, auth: Record<string, string>) {
    this.#tern = tern;
    this.#url = url;
    this.#auth = { ...auth };
    this.#surface = tern.open({ id: "unii", mode: "inline", role: "omp.session", title: "UniiChat" });
  }

  async run(): Promise<void> {
    this.#alive = true;
    this.#draw();
    this.#surface.focus(INPUT);
    this.#connect();
    try {
      for await (const item of this.#tern) {
        if (item.type === "key") {
          this.#key(item.key);
        }
        // Tern dispatches native editor and click callbacks before this
        // loop. No undocumented event fields or private SDK APIs needed.
      }
    } finally {
      this.#alive = false;
      this.view.ws?.close(View.QUIT);
      await this.#tern.close();
    }
  }

  #connect(): void {
    View.link_open(this.view, {
      open: (query) => new WebSocket(this.#url.replace(/^http/, "ws") + "/ws" + query, { headers: this.#auth } as any),
      post: (path, body) => fetch(this.#url + path, { method: "POST", headers: this.#auth, body }),
      hear: (msg) => {
        for (const action of View.view_hear(this.view, msg)) {
          this.#send(action);
        }
        this.changed();
      },
      lost: async () => {
        this.changed();
        return this.#alive;
      },
    });
  }

  #send(msg: View.Client, submitted?: string): void {
    View.link_send(this.view, msg, (answer) => {
      if (answer.error !== undefined) {
        this.view.notes.push(answer.error);
        // Never overwrite a newer draft when an offline/slow post fails.
        if (msg.$ === "say" && submitted !== undefined && this.editor.text === "") {
          this.editor.set(submitted);
        }
      }
      this.changed();
    }, msg.$ === "say" ? submitted?.trim() ?? "" : "");
  }

  #act(act: View.Act): View.Client[] {
    const actions = View.view_act(this.view, act);
    for (const msg of actions) {
      this.#send(msg);
    }
    this.changed();
    return actions;
  }

  #sendText(text: string): void {
    const actions = View.view_act(this.view, { $: "Send", text });
    const accepted = actions.length > 0;
    if (accepted && text.trim() !== "") {
      this.editor.clear();
    }
    for (const action of actions) {
      this.#send(action, action.$ === "say" ? text : undefined);
    }
    this.changed();
  }

  #edit(ev: EditEvent): void {
    if (this.editor.edit(ev)) {
      this.changed();
    }
  }

  #key(key: Key): void {
    if (key.ctrl && key.name === "d") {
      this.#quit();
      return;
    }
    if (key.ctrl && key.name === "c") {
      this.view.busy ? this.#stop() : this.#quit();
      return;
    }
    const action = this.editor.key(key);
    if (action === "send") {
      this.#sendText(this.editor.text);
    } else if (action === "changed") {
      this.changed();
    }
  }

  #stop(): void {
    this.#act({ $: "Send", text: "" });
  }

  #quit(): void {
    if (!this.#alive) {
      return;
    }
    this.#alive = false;
    this.view.ws?.close(View.QUIT);
    void this.#tern.close();
  }

  changed(): void {
    if (this.#queued || !this.#alive) {
      return;
    }
    this.#queued = true;
    queueMicrotask(() => {
      this.#queued = false;
      if (this.#alive) {
        this.#draw();
      }
    });
  }

  #draw(): void {
    if (this.#surface.closed) {
      return;
    }
    const frame = projectView(this.view);
    const stop = () => this.#stop();
    this.#surface.render({
      main: [
        ...renderRows(frame.main, { open: (id, n) => this.#act({ $: "Open", id, n }), shut: (id, n) => this.#act({ $: "Shut", id, n }) }),
        ...renderRows(frame.tail, { open: (id, n) => this.#act({ $: "Open", id, n }), shut: (id, n) => this.#act({ $: "Shut", id, n }) }),
      ],
      dock: [
        frame.busy ? (
          <row key="working" role="omp.working" gap="sm" align="center">
            <spinner key="spinner" style="dots" tone="accent" />
            <text key="label" text="Working" />
            <text key="stop" role="omp.composer.stop" text="Stop" onClick={stop} />
          </row>
        ) : null,
        <col key="composer" role="omp.editor">
          <row key="line" role="omp.composer.line">
            <editor key="input" role="omp.composer.input" text={this.editor.text} cursor={this.editor.cursor}
              placeholder={frame.typing ? View.HINT : "Viewing an agent"} maxLines={18} sendable={frame.typing}
              onEdit={(ev: EditEvent) => this.#edit(ev)}
              onSend={(ev: SendEvent) => this.#sendText(ev.text)}
              onUndo={() => { this.editor.undo(); this.changed(); }}
            />
          </row>
          <row key="bar" role="omp.composer.bar" align="center" gap="sm">
            <text key="model" spans={[{ s: "muted", t: frame.model ?? "UniiChat" }]} />
            <text key="status" spans={[{ s: "dim", t: frame.connected ? "Connected" : "Connecting…" }]} />
            {frame.typing ? <text key="send" text="Send" onClick={() => this.#sendText(this.editor.text)} /> : null}
          </row>
        </col>,
        <status key="statusline" role="unii.status">
          <seg key="brand" spans={[{ t: "UniiChat" }]} priority={10} />
          {frame.page ? <seg key="page" spans={[{ t: frame.page }]} priority={5} /> : null}
          {frame.notes.length ? <seg key="note" spans={[{ t: frame.notes.at(-1) ?? "" }]} priority={8} /> : null}
          <seg key="connection" side="right" priority={4} spans={[{ t: frame.connected ? "Online" : "Offline" }]} />
        </status>,
      ],
    });
  }
}
