# UniiChat native memory tree (TSP)

This feature is isolated from the core Tern entry. It presents UniiChat's existing
OptMem protocol inside a native \`@stencil-hq/tern\` picker without a second
WebSocket, a local memory copy, a new server route, or HTML scraping.

- **Turn context:** the exact \`view.parts\` that the server presents before
  \`view.turn\`. Part sizes distinguish older merged memories (L1+) from
  newer individual message summaries (L0). Live messages after the turn
  boundary are deliberately not mislabeled as prior model context.
- **Levels:** level L0 has one message per node; L1 has two, L2 four, and
  so on. Six or fewer parent zooms are outstanding at a time, and only
  sixteen rows are rendered/requested per page.
- **Provenance:** every node shows its exact source message interval and
  tree ancestry. Opening children uses UniiChat's existing \`zoom\` read;
  reaching a leaf shows \`know.whole\` (the original message, not a
  summary reconstructed from it). Missing, still-building summaries are
  explicitly marked as pending.

## Core integration

\`registerMemoryTree\` in \`register.ts\` is the **only integration entry**.
Its \`MemoryTreeHost\` matches the Hermes×Tern overlay approach (overlay
stack, semantic \`picker\`, callbacks, existing socket queue). The core
slice owns the actual command/menu binding, Tern session, render loop,
and fallback TUI. It should call:

\`\`\`ts
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
\`\`\`

These are adapter calls, not a replacement for the core's existing
message handler. Route server events in wire order: \`know\` arrives
before \`zoom\` and \`root\`. Native \`picker\` receives regular semantic
nodes and reuses the host's overlay focus/close behavior.

## Verification for OMP

From the repository root:

\`\`\`sh
bun install
bun run tsp:check
bun test --isolate tsp/memory-tree/model.test.ts tsp/memory-tree/register.test.ts
bun run test
bun build tsp/memory-tree/register.ts --target bun --outfile /tmp/uniichat-memory-tree.js
\`\`\`

No tests or real Tern-host visual acceptance were run through the GitHub
connector. After the independent core slice is integrated, verify a
logged-in UniiChat socket in a Tern host: the newest turn view, levels
L0 through a merged root, keyboard navigation, source provenance,
loading summaries, reconnection, and that normal \`bun Term.ts\` still
works when Tern is unavailable.

## Provenance

UniiChat's message tree and memory-view algorithms are from the
original UniiChat contributors (Higher Order Company, Apache-2.0).
The semantic picker, overlay patterns and TSP API are reused from
Stencil Labs' Tern SDK and the Hermes×Tern integration, including the
contributions of their respective maintainers. This module does not
change the storage format or claiming semantics of those systems.
