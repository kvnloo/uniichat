// Probe Tern first; a terminal without TSP runs the existing Term.ts path.
// Mirrors the Hermes x Tern connect() capability check, not a terminal-env
// heuristic. No user data or server connection is made on probe failure.
import { connect } from "@stencil-hq/tern";
import { NativeChat } from "./client.tsx";

export async function tryTern(
  url: string,
  authorization: Record<string, string>,
  version: string,
  negotiate: typeof connect = connect,
): Promise<boolean> {
  const session = await negotiate({ app: "unii", version, features: ["edit", "undo", "send"] });
  if (!session) {
    return false;
  }
  await new NativeChat(session, url, authorization).run();
  return true;
}
