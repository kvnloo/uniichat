// Runs UniiChat's real native entry in an owned OS PTY. No sign-in,
// provider, live pane, or application state is involved.
import { tryTern } from "./entry.ts";

const url = process.env.UNII_PTY_URL;
if (!url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) {
  throw new Error("The PTY fixture requires an owned loopback UNII_PTY_URL");
}
if (!(await tryTern(url, { authorization: "Bearer owned-pty-fixture" }, "pty-fixture"))) {
  throw new Error("The pinned native Tern entry did not negotiate in the owned PTY");
}
