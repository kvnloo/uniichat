# UniiChat native Tern client

The public `@stencil-hq/tern@0.1.0` handshake activates this frontend after the existing login. No Tern session means **the original Term.ts terminal and its device executor remain unchanged**. Tern uses UniiChat's own authenticated `View.link_open` and `View.link_send`, `/ws?tab=…&wire=2` and `/api/act`; the server remains the authority for memory, turns and jobs.

**Native Tern is a real device**, not a browser-only tab. It registers `device`, `computer` and `work` exactly as Term.ts does, including macOS Bonjour LocalHostName, `UNII_WORK` (default `~/.unii/work`) and the strict `UNII_COMPUTER=1` opt-in. The server's `job`/`jobs` events execute and cancel `Machine.run` through `DeviceJobs`. In-flight jobs and unacknowledged `out` actions de-duplicate on reconnect; output over `View.FRAME - 1024` bytes is replaced with a failure rather than closing the wire. Final close or a signal aborts work and calls `Machine.end` to kill child process groups. No second traditional terminal is required.

The shared `View.ts` link retains server authentication, acknowledgments and replay. Normal reconnect backoff is owned by NativeChat, and its timeout is cancelled on close; the existing View MOVE code retains its immediate move semantics, with a network-free closed socket guard if its already-queued callback arrives after shutdown. Native callbacks are epoch-guarded. A hidden surface does not render; whole-surface `gone` (identified by `ids` even without optional `sf`) waits for the host's visible edge when detached, or reopens a new SDK surface if still visible, with three recoveries maximum. No private wire extensions or fabricated ACKs are used.

## Integrated native OptMem Memory

The fork-only integration branch preserves core commit `205f6641fdbd385842d0571fa6593614c0f0974a`
and memory-tree commit `7653dd3f3e2012d18816f2aadd416d25be47dd6a`
as separate parents of merge commit `72848434ea7b542d33248b6ce3ae3c89d31b2335`.
The core branch supplies its verified Screen performance fix and Tern lifecycle;
the memory branch supplies the existing server-authoritative `view.context`
snapshot and `tsp/memory-tree/**` unchanged. Shared `Clip.ts`,
`tsp/assets.d.ts` and `bun.lock` are identical. The merged package keeps
`@stencil-hq/tern@0.1.0`, `@types/bun@1.3.10` and TypeScript 6.0.3.

`NativeChat` registers `registerMemoryTree` **once**. It forwards every
server event in wire order after `View.view_hear` and before redraw; all
read requests use `View.link_send` with durable ACK/replay semantics.
The physical WebSocket `open` callback resets the explorer on *subsequent*
transport epochs, before the new socket can deliver its authoritative join
`view.context` (including a known empty snapshot, or null/absent for idle/
unavailable). It does not infer active-call context from display `view.parts`.

- Native composer button ID: `dock.composer.bar.memory`, role
  `unii.memory.action`, visible even while the agent is working.
- Local composer command: `/memory` (also accepts trailing whitespace);
  consumes only its own command, never sends it as model text.
- Modal picker logical key: `unii-memory-tree`, role `unii.memory-tree`;
  each opening receives a unique native root `layer.memory-tree-N`. It lives
  in the top-level `layer` of the existing session surface, never another
  TSP surface. Closed/replaced pickers reject previously bound native actions
  and keys; callbacks also require the current native root and surface epoch.
- Keyboard: Tab switches current model-call context / OptMem levels;
  Up/Down selects, Left/Right changes levels, PageUp/PageDown pages,
  Enter opens summary children and Esc closes. Native picker actions also
  supply Refresh, Close and level navigation. On close, focus returns to
  `dock.composer.line.input`; opening with the bar does not consume a draft.
- Source preview shows original messages when available, precise ranges,
  ancestry, pending versus compacted summaries, and explicit idle/unavailable
  state. Reads are bounded to sixteen visible nodes and at most six pending
  zooms. No second memory store, WebSocket or private TSP action exists.

The SDK delivers **raw terminal bytes as keys**. UniiChat alone owns its
composer text and UTF-16 caret: raw typing, fragmented Unicode, bracketed
paste and Enter all follow the same editor/send path. A semantic `SendEvent.text` is authoritative even before its `onEdit`
callback arrives. A paired `onSend` repeating a raw Enter's already-consumed
text is rejected, while a different full-text submission is accepted without
clearing a newer unsent draft; a delayed full-text edit for that submitted
text is also ignored. Modal keys cannot reach the composer.
The original `Term.ts` plain-terminal fallback is unchanged.

### OMP acceptance on exact integration head (not executed in this chat)

```sh
bun install --frozen-lockfile
bun test --isolate tsp/pty.test.ts
bun test --isolate tsp/client.test.tsx tsp/device.test.ts
bun test --isolate tsp/memory-tree/model.test.ts tsp/memory-tree/register.test.ts tsp/memory-tree/server-projection.test.ts
bun run tsp:core:check
bun run tsp:memory:check
bun run tsp:check
bun run test
bun build Term.ts --target bun --outdir /tmp/uniichat-tsp-integrated
bun build tsp/memory-tree/register.ts --target bun --outfile /tmp/uniichat-memory-tree.js
```

`tsp/pty.test.ts` is mandatory, **not** a synthetic Tern callback check.
It launches the actual `tsp/entry.ts` `tryTern` entry under an OS PTY
(Linux util-linux `script`, macOS BSD `script`) via `tsp/pty-child.ts`,
uses the pinned SDK's real raw input stream, and connects to a disposable
localhost Bun WebSocket/HTTP peer. It verifies ordinary typing, fragmented
UTF-8 code points, bracketed paste with embedded newline, one exact POST
after Enter, and local Memory keyboard actions. Pinned-SDK loopback tests
add semantic full-text send/edit ordering, raw Enter duplicate rejection,
optional-`sf` gone/detach recovery and per-open picker callback isolation. No credentials, provider
calls, GUI, user data or live Tern pane are used.

Then inspect the compiled app in an **owned** disposable headless Sway/Tern
session using fresh `UNII_HOME`, `UNII_WORK` and
`UNII_NO_TELEMETRY=1`: verify active-call frozen context during imports,
compacted-to-source exploration, native modal focus, close/reopen, host
detach/recovery and session reconnect/handoff, alongside ordinary terminal
fallback. Do not access live panes or real Unii/OptMem directories.
Treat earlier MBP receipts as evidence for their respective **source heads**,
not as passing results for this integrated head.

## OMP checks (not run by this connector worker)

Run from the downstream checkout at the exact PR head:

```sh
bun install --frozen-lockfile
bun test --isolate tsp/device.test.ts tsp/client.test.tsx
bun test --isolate tsp
bun run test
bunx tsc --noEmit -p tsp/tsconfig.json
bun build Term.ts --target bun --outdir /tmp/uniichat-tsp-check
```

`tsp/client.test.tsx` runs **NativeChat itself** inside the pinned real Tern SDK against an owned `127.0.0.1` Bun WebSocket/HTTP peer. It tests native editor edits and atomic submit, streamed output, canonical actions/ACKs, tool execution and de-duplication, cancellation, reconnect, surface gone/visibility, stale actions and shutdown. The peer acknowledges only frames actually received. No credentials, provider calls, GUI session or home state are needed for the controlled loopback test.

For native UI acceptance OMP should use an isolated headless Sway/Tern pane and a temporary `UNII_HOME`, then confirm editing, native lifecycle, tool execution and interruption. Also verify plain terminal fallback, `UNII_COMPUTER` gating and the terminal build. Do not point smoke tests at a live account or a real desktop.

## Provenance

UniiChat's original Higher Order Company authors own `Term.ts`, `View.ts`, `Machine.ts` and the server wire. The lifecycle and surface conventions come from Hermes × Tern in `kvnloo/hermes-tern/frontend/src` and `kvnloo/hermes-agent/ui-tsp`; the native SDK is Stencil Labs' `@stencil-hq/tern`. This adapter changes only the downstream fork.
