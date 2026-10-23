# UniiChat Tern core

The native path probes the public @stencil-hq/tern 0.1.0 connect API after UniiChat login. A missing Tern session leaves the original Term.ts terminal, screen, keyboard and device-tool behavior unchanged.

Native mode runs a browser-like UniiChat tab over the same View.ts Link: /ws?tab=<id>&wire=2, authenticated /api/act uploads, canonical turn/summary projection, streamed deltas, server acknowledgments, tool/result cards, editor edits and undo, stop and close. It does not advertise a device or silently drop device jobs. Open a normal unii terminal separately for device-specific tools.

The Tern surface uses Hermes x Tern's omp.session and omp.editor roles with UniiChat-specific memory blocks. The server remains the only session and memory authority. Native host acceptance remains necessary before marking this production-ready.

## OMP verification

- `bun install`
- `bun test --isolate tsp`
- `bun run test`
- `bunx tsc --noEmit -p tsp/tsconfig.json`
- `bun build Term.ts --target bun --outdir /tmp/uniichat-tsp-check`
- In a Tern-enabled terminal, `bun Term.ts http://127.0.0.1:8788`: check native stream, tool calls, composer edits/undo/submit, stop, reconnect and memory summary zoom.
- In a terminal without TSP, run the same command and verify the original Screen/Paint UI, device tool calls and keyboard.

## Provenance

UniiChat View.ts and server protocol: original Higher Order Company contributors. Native patterns and semantic roles: Hermes x Tern integration from kvnloo/hermes-tern and kvnloo/hermes-agent/ui-tsp, itself building on the Stencil Labs Tern SDK and OMP interaction conventions. This is a downstream UniiChat-only adapter.
