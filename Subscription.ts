// Subscription
// ============
// Reuse the owner's OAuth login read-only. No API-key fallback, token copies,
// refresh-token rotation, or changes to another application's credential store.

import { Database } from "bun:sqlite";
import * as os from "node:os";
import * as path from "node:path";

export type Login = { access: string; accountId?: string; expires: number };

export namespace Subscription {

  export function login(provider: "anthropic" | "openai-codex", file = path.join(process.env.OMP_AGENT_DIR || path.join(os.homedir(), ".omp", "agent"), "agent.db")): Login {
    let data: unknown;
    let db: Database | undefined;
    try {
      db = new Database(file, { readonly: true });
      const row = db.query("SELECT data FROM auth_credentials WHERE provider = ? AND credential_type = 'oauth' AND disabled_cause IS NULL ORDER BY updated_at DESC, id DESC LIMIT 1").get(provider) as { data: string } | null;
      data = row ? JSON.parse(row.data) : null;
    } catch {
      throw new Error("Cannot read the existing OMP " + provider + " subscription login.");
    } finally {
      db?.close();
    }
    return Subscription.validate(provider, data);
  }

  export function validate(provider: "anthropic" | "openai-codex", data: unknown): Login {
    if (!data || typeof data !== "object" || !("access" in data) || typeof data.access !== "string" || !data.access
      || !("expires" in data) || typeof data.expires !== "number" || !Number.isFinite(data.expires)) {
      throw new Error("No existing OMP " + provider + " OAuth subscription login.");
    }
    if (provider === "anthropic" && !data.access.startsWith("sk-ant-oat")) {
      throw new Error("The OMP anthropic login is not a subscription OAuth token.");
    }
    const accountId = "accountId" in data ? data.accountId : undefined;
    if (provider === "openai-codex" && (typeof accountId !== "string" || !accountId)) {
      throw new Error("The OMP openai-codex subscription login has no account ID.");
    }
    if (data.expires <= Date.now()) {
      throw new Error("The existing OMP " + provider + " subscription login expired; let OMP refresh its login, then retry.");
    }
    return { access: data.access, accountId: typeof accountId === "string" ? accountId : undefined, expires: data.expires };
  }

}
