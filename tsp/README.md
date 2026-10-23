# UniiChat native Tern client

The public `@stencil-hq/tern@0.1.0` handshake activates this frontend after the existing login. No Tern session means **the original Term.ts terminal and its device executor remain unchanged**. Tern uses UniiChat's own authenticated `View.link_open` and `View.link_send`, `/ws?tab=…&wire=2` and `/api/act`; the server remains the authority for memory, turns and jobs.

**Native Tern is a real device**, not a browser-only tab. It registers `device`, `computer` and `work` exactly as Term.ts does, including macOS Bonjour LocalHostName, `UNII_WORK` (default `~/.unii/work`) and the strict `UNII_COMPUTER=1` opt-in. The server's `job`/`jobs` events execute and cancel `Machine.run` through `DeviceJobs`. In-flight jobs and unacknowledged `out` actions de-duplicate on reconnect; output over `View.FRAME - 1024` bytes is replaced with a failure rather than closing the wire. Final close or a signal aborts work and calls `Machine.end` to kill child process groups. No second traditional terminal is required.

The shared `View.ts` link retains server authentication, acknowledgments and replay. Normal reconnect backoff is owned by NativeChat, and its timeout is cancelled on close; the existing View MOVE code retains its immediate move semantics, with a network-free closed socket guard if its already-queued callback arrives after shutdown. Native callbacks are epoch-guarded. A hidden surface does not render; whole-surface `gone` waits for the host's visible edge when detached, or reopens a new SDK surface if still visible, with three recoveries maximum. No private wire extensions or fabricated ACKs are used.

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
