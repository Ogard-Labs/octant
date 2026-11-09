import type { RemoteSetupCheckInput, RemoteSetupCheckResult } from "@octant/contracts/remote-setup";
import type { ShieldServer } from "@octant/contracts/shield-servers";
import { Schema } from "effect";
import { ServerFolderPath } from "@octant/contracts/server-projects";
import type { ServerConnection } from "./serverConnection";

/** A fixed read-only shell probe; a folder travels as a literal argument, never shell text. */
const PROBE = 'if [ -n "$1" ]; then cd -- "$1" 2>/dev/null || exit 3; fi; pwd -P';
const validFolder = Schema.is(ServerFolderPath);

interface RemoteSetupChecksOptions {
  readonly servers: () => ReadonlyArray<ShieldServer>;
  readonly agentAvailable: () => boolean;
  readonly connection: Pick<ServerConnection, "run">;
}

export class RemoteSetupChecks {
  readonly #options: RemoteSetupChecksOptions;
  #running = 0;
  constructor(options: RemoteSetupChecksOptions) {
    this.#options = options;
  }

  async check(input: RemoteSetupCheckInput, signal?: AbortSignal): Promise<RemoteSetupCheckResult> {
    const server = this.#options
      .servers()
      .find((entry) => String(entry.serverId) === String(input.serverId));
    if (server === undefined) return { status: "stopped", reason: "server-not-registered" };
    if (input.runtime !== "octant-harness")
      return { status: "stopped", reason: "unsupported-runtime" };
    if (server.signIn === "octant-key")
      return { status: "stopped", reason: "kept-key-unsupported" };
    if (!this.#options.agentAvailable()) return { status: "stopped", reason: "missing-agent" };
    if (this.#running >= 4) return { status: "stopped", reason: "busy" };
    this.#running++;
    try {
      const call = await this.#options.connection.run(
        { alias: server.alias, user: server.user },
        {
          script: PROBE,
          args: [input.folder ?? ""],
          freshConnection: true,
          timeoutMs: 12_000,
          maxOutputBytes: 2_048,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      const current = this.#options
        .servers()
        .find((entry) => String(entry.serverId) === String(input.serverId));
      if (
        current === undefined ||
        current.alias !== server.alias ||
        current.user !== server.user ||
        current.signIn !== server.signIn
      )
        return { status: "stopped", reason: "registration-changed" };
      if (call.status === "cancelled") return { status: "stopped", reason: "cancelled" };
      if (call.status === "timed-out")
        return { status: "disconnected", reason: "host-unavailable" };
      if (call.status === "unreachable") {
        // Advisory remedies only: OpenSSH still makes the trust decision with strict checking.
        const error = call.errorOutput ?? call.message;
        const reason =
          /REMOTE HOST IDENTIFICATION HAS CHANGED|REVOKED HOST KEY|Offending .* key/i.test(error)
            ? "changed-identity"
            : /No .*host key is known|not known.*strict|not in.*known_hosts/i.test(error)
              ? "unknown-identity"
              : /Permission denied|sign_and_send_pubkey|agent refused operation/i.test(error)
                ? "authentication-refused"
                : "host-unavailable";
        return { status: "disconnected", reason };
      }
      if (call.status !== "ran") return { status: "disconnected", reason: "probe-unavailable" };
      if (call.exitCode === 3) return { status: "disconnected", reason: "directory-unavailable" };
      const folder = call.output.toString("utf8").replace(/\n$/, "");
      if (call.exitCode !== 0 || call.truncated || !validFolder(folder))
        return { status: "disconnected", reason: "probe-unavailable" };
      return { status: "connected", reason: "ready", folder };
    } catch {
      return { status: "disconnected", reason: "probe-unavailable" };
    } finally {
      this.#running--;
    }
  }
}
