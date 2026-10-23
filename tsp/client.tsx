// Native Tern presentation over UniiChat's canonical View.ts transport.
// Unlike a browser tab, this is a device executor: the same /ws identity,
// pending-output deduplication and Machine lifetime as Term.ts.
import type { EditEvent, Key, SendEvent, Session, Surface } from "@stencil-hq/tern";
import * as View from "../View.ts";
import { DeviceJobs, localDevice, type DeviceRuntime, type LocalDevice } from "./device.ts";
import { Editor } from "./editor.ts";
import { projectView } from "./projection.ts";
import { renderRows } from "./render.tsx";

const INPUT = "dock.composer.line.input";
const MAX_RECOVERIES = 3;

export type NativeOptions = { device?: LocalDevice; runtime?: DeviceRuntime };

type HostEvent = { ev?: unknown; sf?: unknown; ids?: unknown; visible?: unknown; msg?: unknown };

// View.link_open owns a zero-delay reconnect on server MOVE. If that timer
// fires after disposal, give it an already-closed, network-free socket, so
// it cannot create a live connection or retry. Normal retries are owned
// and cancellable by NativeChat (its Link.lost returns false).
function closedSocket(): WebSocket {
  const socket = {
    onmessage: null as ((ev: MessageEvent) => void) | null,
    onclose: null as ((ev: CloseEvent) => void) | null,
    close: () => {},
    send: () => {},
  };
  queueMicrotask(() => socket.onclose?.({ code: View.QUIT } as CloseEvent));
  return socket as unknown as WebSocket;
}

export class NativeChat {
  readonly view = View.view_new();
  readonly editor = new Editor();
  readonly device: DeviceJobs;
  readonly #tern: Session;
  readonly #url: string;
  readonly #auth: Record<string, string>;
  #surface: Surface | null = null;
  #detachedId: string | null = null;
  #surfaceEpoch = 0;
  #recoveries = 0;
  #alive = false;
  #ended = false;
  #hidden = false;
  #queued = false;
  #retry: ReturnType<typeof setTimeout> | undefined;
  readonly #exit = () => this.device.close();
  readonly #signal = () => this.stop();

  constructor(tern: Session, url: string, auth: Record<string, string>, options: NativeOptions = {}) {
    this.#tern = tern;
    this.#url = url.replace(/\/$/, "");
    this.#auth = { ...auth };
    this.device = new DeviceJobs(this.view, (msg) => this.#send(msg), options.device ?? localDevice(), options.runtime);
  }

  async run(): Promise<void> {
    if (this.#ended || this.#alive) {
      throw new Error("NativeChat can run only once");
    }
    this.#alive = true;
    process.on("exit", this.#exit);
    for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) {
      process.on(signal, this.#signal);
    }
    try {
      this.#openSurface();
      this.#connect();
      for await (const item of this.#tern) {
        if (!this.#alive) {
          break;
        }
        if (item.type === "key") {
          this.#key(item.key);
        } else {
          // The SDK has already dispatched node callbacks. Only lifecycle
          // events (visible, gone, error) need handling at the app level.
          this.#event(item.event);
        }
      }
    } finally {
      this.dispose();
      process.off("exit", this.#exit);
      for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) {
        process.off(signal, this.#signal);
      }
      await this.#tern.close();
    }
  }

  // Safe from a signal, input EOF, host removal or a native Stop/Exit action.
  stop(): void {
    this.dispose();
    void this.#tern.close();
  }

  dispose(): void {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    this.#alive = false;
    this.#surface = null;
    this.#surfaceEpoch++;
    if (this.#retry !== undefined) {
      clearTimeout(this.#retry);
      this.#retry = undefined;
    }
    this.device.close();
    this.view.flush = () => {};
    this.view.out = [];
    const socket = this.view.ws;
    if (socket !== null) {
      socket.close(View.QUIT);
      // View.link_open owns the ping interval. Deliver its normal close
      // edge now, even if a half-open socket never reports onclose.
      socket.onclose?.({ code: View.QUIT } as CloseEvent);
    }
    this.view.ws = null;
  }

  #connect(): void {
    if (!this.#alive) {
      return;
    }
    View.link_open(this.view, {
      open: (query) => this.#alive
        ? new WebSocket(this.#url.replace(/^http/, "ws") + "/ws" + query + this.device.query, { headers: this.#auth } as any)
        : closedSocket(),
      post: (path, body) => fetch(this.#url + path, { method: "POST", headers: this.#auth, body }),
      hear: (msg) => {
        if (!this.#alive) {
          return;
        }
        for (const action of View.view_hear(this.view, msg)) {
          this.#send(action);
        }
        if (msg.$ === "job" || msg.$ === "jobs") {
          this.device.hear(msg);
        }
        this.changed();
      },
      lost: async (up) => {
        if (!this.#alive) {
          return false;
        }
        this.changed();
        // Match Term.ts's refusal rule: do not retry a revoked session.
        if (!up) {
          const res = await fetch(this.#url + "/api/me", { headers: this.#auth }).catch(() => null);
          if (!this.#alive) {
            return false;
          }
          if (res?.status === 401) {
            this.view.notes.push("This terminal is signed out: run unii again to sign in.");
            this.stop();
            return false;
          }
        }
        // Returning false disables View.link_open's non-cancellable normal
        // retry timer. Our single retry is cancelled on dispose.
        if (this.#retry === undefined) {
          this.#retry = setTimeout(() => {
            this.#retry = undefined;
            if (this.#alive) {
              this.#connect();
            }
          }, View.RETRY);
        }
        return false;
      },
    });
  }

  #send(msg: View.Client, submitted?: string): void {
    if (!this.#alive) {
      return;
    }
    View.link_send(this.view, msg, (answer) => {
      if (!this.#alive) {
        return;
      }
      if (answer.error !== undefined) {
        this.view.notes.push(answer.error);
        if (msg.$ === "say" && submitted !== undefined && this.editor.text === "") {
          this.editor.set(submitted);
        }
      }
      this.changed();
    }, msg.$ === "say" ? submitted?.trim() ?? "" : "");
  }

  #act(act: View.Act): void {
    if (!this.#alive) {
      return;
    }
    for (const msg of View.view_act(this.view, act)) {
      this.#send(msg);
    }
    this.changed();
  }

  #sendText(text: string): void {
    if (!this.#alive) {
      return;
    }
    const actions = View.view_act(this.view, { $: "Send", text });
    if (actions.length > 0 && text.trim() !== "" && this.editor.text === text) {
      this.editor.clear();
    }
    for (const action of actions) {
      this.#send(action, action.$ === "say" ? text : undefined);
    }
    this.changed();
  }

  #edit(event: EditEvent): void {
    if (this.editor.edit(event)) {
      this.changed();
    }
  }

  #key(key: Key): void {
    if (key.ctrl && key.name === "d") {
      this.stop();
      return;
    }
    if (key.ctrl && key.name === "c") {
      this.view.busy ? this.#stop() : this.stop();
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

  #event(event: HostEvent): void {
    if (!this.#alive) {
      return;
    }
    // A detached surface is no longer in Session.surfaces; its last id
    // still owns the host's later visible edge.
    if (event.ev === "visible" && this.#surface === null && event.sf === this.#detachedId) {
      this.#hidden = event.visible === false;
      if (!this.#hidden) {
        this.#recover();
      }
      return;
    }
    const surface = this.#surface;
    if (surface === null || event.sf !== surface.id) {
      return;
    }
    if (event.ev === "visible") {
      this.#hidden = event.visible === false;
      if (!this.#hidden) {
        if (this.#surface?.closed) {
          this.#recover();
        }
        this.changed();
      }
    } else if (event.ev === "gone") {
      const ids = Array.isArray(event.ids) ? event.ids : [];
      if (ids.includes(surface.id)) {
        this.#detachedId = surface.id;
        this.#surface = null;
        this.#surfaceEpoch++;
        // A hidden pane may be detached temporarily. Wait for an explicit
        // visible edge rather than opening a new document in the dark.
        if (!this.#hidden) {
          this.#recover();
        }
      } else {
        this.changed();
      }
    } else if (event.ev === "error") {
      this.view.notes.push("Tern rejected the native surface: " + String(event.msg ?? "protocol error"));
      this.stop();
    }
  }

  #recover(): void {
    if (!this.#alive || this.#hidden) {
      return;
    }
    if (this.#recoveries >= MAX_RECOVERIES) {
      this.view.notes.push("Tern surface recovery limit reached.");
      this.stop();
      return;
    }
    this.#recoveries++;
    this.#openSurface();
  }

  #openSurface(): void {
    if (!this.#alive) {
      return;
    }
    const n = ++this.#surfaceEpoch;
    const surface = this.#tern.open({
      id: n === 1 ? "unii" : "unii-" + n,
      mode: "inline",
      role: "omp.session",
      title: "UniiChat",
    });
    this.#surface = surface;
    this.#detachedId = null;
    this.#draw();
    if (this.#surface === surface && !surface.closed) {
      surface.focus(INPUT);
    }
  }

  changed(): void {
    if (this.#queued || !this.#alive) {
      return;
    }
    this.#queued = true;
    queueMicrotask(() => {
      this.#queued = false;
      if (this.#alive) {
        try {
          this.#draw();
        } catch (reason) {
          this.view.notes.push("Native render failed: " + String(reason));
          this.stop();
        }
      }
    });
  }

  #draw(): void {
    const surface = this.#surface;
    if (!this.#alive || this.#hidden || surface === null) {
      return;
    }
    if (surface.closed) {
      this.#detachedId = surface.id;
      this.#surface = null;
      this.#surfaceEpoch++;
      this.#recover();
      return;
    }
    const epoch = this.#surfaceEpoch;
    const active = () => this.#alive && !this.#hidden && this.#surfaceEpoch === epoch;
    const act = (action: View.Act) => { if (active()) this.#act(action); };
    const frame = projectView(this.view);
    const navigation = {
      open: (id: number, n: number) => act({ $: "Open", id, n }),
      shut: (id: number, n: number) => act({ $: "Shut", id, n }),
    };
    surface.render({
      main: [
        ...renderRows(frame.main, navigation),
        ...renderRows(frame.tail, navigation),
      ],
      dock: [
        frame.busy ? (
          <row key="working" role="omp.working" gap="sm" align="center">
            <spinner key="spinner" style="dots" tone="accent" />
            <text key="label" text="Working" />
            <text key="stop" role="omp.composer.stop" text="Stop" onClick={() => act({ $: "Send", text: "" })} />
          </row>
        ) : null,
        <col key="composer" role="omp.editor">
          <row key="line" role="omp.composer.line">
            <editor key="input" role="omp.composer.input" text={this.editor.text} cursor={this.editor.cursor}
              placeholder={frame.typing ? View.HINT : "Viewing an agent"} maxLines={18} sendable={frame.typing}
              onEdit={(ev: EditEvent) => { if (active()) this.#edit(ev); }}
              onSend={(ev: SendEvent) => { if (active()) this.#sendText(ev.text); }}
              onUndo={() => { if (active()) { this.editor.undo(); this.changed(); } }}
            />
          </row>
          <row key="bar" role="omp.composer.bar" align="center" gap="sm">
            <text key="model" spans={[{ s: "muted", t: frame.model ?? "UniiChat" }]} />
            <text key="status" spans={[{ s: "dim", t: frame.connected ? "Connected" : "Connecting…" }]} />
            {frame.typing ? <text key="send" text="Send" onClick={() => { if (active()) this.#sendText(this.editor.text); }} /> : null}
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
