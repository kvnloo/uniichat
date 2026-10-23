# UniiChat native memory tree (TSP)

This feature is isolated from the core Tern entry. It presents UniiChat's existing
OptMem protocol inside a native `@stencil-hq/tern` picker without a second
WebSocket, a local memory copy, a new server route, or HTML scraping.

- **Turn context:** the exact memory blocks frozen at the latest model call
  in the active turn, sent as `view.context: { turn, parts }`. These are
  the built nodes from `Memory.view` when `Chat.call` invokes `AskAI.ask`. `view.parts`
  and `view.turn` are **display-only**: imports and compaction can replace
  them independently of a model call. The server teaches the snapshot's
  nodes even when hidden from the display. An absent or `null` context
  means no available current-turn model-call snapshot, **not** zero
  historical context; a present snapshot with empty parts means a call
  really used no earlier memory blocks. Context is cleared at turn end,
  unavailable on cold reload until a new call, and carried on live handoff.
- **Levels:** level L0 has one message per node; L1 has two, L2 four, and
  so on. Six or fewer parent zooms are outstanding at a time, and only
  sixteen rows are rendered/requested per page.
- **Provenance:** every node shows its exact source message interval and
  tree ancestry. Opening children uses UniiChat's existing `zoom` read;
  reaching a leaf shows `know.whole` (the original message, not a
  summary reconstructed from it). Missing, still-building summaries are
  explicitly marked as pending.

## Core integration

`registerMemoryTree` in `register.ts` is the **only integration entry**.
Its `MemoryTreeHost` matches the Hermes×Tern overlay approach (overlay
stack, semantic `picker`, callbacks, existing socket queue). The core
slice owns the actual command/menu binding, Tern session, render loop,
and fallback TUI. It should call:

```ts
import { registerMemoryTree } from "./tsp/memory-tree/register.ts";
import { link_send, view_hear } from "./View.ts";

const memoryTree = registerMemoryTree({
  open: panel => overlays.open(panel),
  close: panel => overlays.close(panel),
  changed: () => redraw(),
  send: message => link_send(view, message),
});

// In the established server-message handler, after ordinary view_hear:
view_hear(view, msg).forEach(message => link_send(view, message));
memoryTree.hear(msg);

// Bind the core's native memory command/menu item:
memoryTree.open();

// On a *new* socket epoch after transport loss:
memoryTree.reconnect();

// On core shutdown:
memoryTree.dispose();
```

These are adapter calls, not a replacement for the core's existing
message handler. Route server events in wire order: `know` arrives
before `zoom` and `root`. Native `picker` receives regular semantic
nodes and reuses the host's overlay focus/close behavior. The terminal
ignores the additive, optional wire field. Never derive call-time context
from the visible blocks, import state, or raw message ranges.

## Native TypeScript scope

`tsp/memory-tree/tsconfig.json` checks the native memory model, registration,
and their tests with `strict: true`, `noEmit`, Bun types and the same compiler
profile as the independently verified `tsp/core` branch. Its small explicit
include also supplies the shared `*.swift` declaration. It deliberately
does **not** opt the transitive, legacy View/AskAI/Memory/Tools graph into
`noUncheckedIndexedAccess`, which is not enabled by `strict` and would
generate unrelated old indexing diagnostics. No runtime behavior, assertions,
application checks, or library types are suppressed.

`server-projection.test.ts` executes `server-projection.child.mjs` in an
isolated Bun process with disposable `UNII_DIR` and `UNII_HOME`, following
`Server.test.ts`'s subprocess convention. The child imports **real**
`Server.ts` at runtime and calls `Chat.eye` and `Chat.show`; the parent
still asserts the overlapping-import, compaction, handoff, reconnect,
idle and reload projections. The server implementation no longer enters
the standalone native TypeScript dependency graph just to test it. The
narrow `Clip.ts` decoder type boundary and locked `@types/bun@1.3.10`
match the verified core branch. Neither `Server.ts` nor native core
frontend files are modified here.

## Verification for OMP

From the repository root:

```sh
bun install --frozen-lockfile
bun run tsp:check
bun test --isolate tsp/memory-tree/model.test.ts tsp/memory-tree/register.test.ts tsp/memory-tree/server-projection.test.ts
bun run test
bun build tsp/memory-tree/register.ts --target bun --outfile /tmp/uniichat-memory-tree.js
```

No tests or real Tern-host visual acceptance were run through the GitHub
connector. After the independent core slice is integrated, verify a
logged-in UniiChat socket in a Tern host: the newest turn view, levels
L0 through a merged root, keyboard navigation, source provenance,
loading summaries, reconnection, import completion during a turn,
live handoff, and that normal `bun Term.ts` still works when Tern is
unavailable. Cold reload does not recover exact historical call context.
The independent `tsp/core` slice owns integration, not this branch. This
branch independently commits the same locked Bun typings/toolchain as its
green head `205f6641fdbd385842d0571fa6593614c0f0974a`.

## Provenance

UniiChat's message tree and memory-view algorithms are from the
original UniiChat contributors (Higher Order Company, Apache-2.0).
The semantic picker, overlay patterns and TSP API are reused from
Stencil Labs' Tern SDK and the Hermes×Tern integration, including the
contributions of their respective maintainers. This module does not
change the storage format or claiming semantics of those systems.
