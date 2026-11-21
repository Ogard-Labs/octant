// Codex on a server Project's server, with no Octant there: `codex app-server`
// runs in the Project's folder on the server, started through the host's SSH
// connection, and speaks the same JSON-RPC over that connection's standard
// streams as a local app-server speaks over its pipes. Octant's own tools
// travel inside that protocol (`dynamicTools`, `item/tool/call`), so nothing
// on the server reaches this host.
//
// Nothing of this host's launch applies there: no Octant sandbox (none can run
// on the server, so Strict refuses this launch before it gets here), no egress
// proxy, no account home or credentials of this host, no local SSH wrappers.
// Codex uses the server login's own sign-in and its own sandbox and approval
// policy, which the thread's level maps to as it does locally.

import type { ProviderFailure } from "@octant/contracts";
import type { ProviderServerPlacement } from "@octant/provider-sdk/driver";
import { Effect, type Scope } from "effect";
import { decodeInitializeResult } from "./codexProtocol";
import type { CodexAppServerConnection } from "./codexProcess";
import { makeCodexRpcClient } from "./codexRpcClient";

const VERSION_TIMEOUT_MS = 20_000;
const STARTUP_TIMEOUT_MS = 30_000;
const SEMVER = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/;

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

function isProviderFailure(value: unknown): value is ProviderFailure {
  return typeof value === "object" && value !== null && "category" in value && "message" in value;
}

/** The version `codex --version` printed on the server, or why it could not be read. */
export async function readCodexVersionOnServer(
  placement: ProviderServerPlacement,
): Promise<
  | { readonly status: "found"; readonly version: string }
  | { readonly status: "refused"; readonly message: string }
> {
  const ran = await placement.run(["codex", "--version"], { timeoutMs: VERSION_TIMEOUT_MS });
  if (ran.status === "unreachable") return { status: "refused", message: ran.message };
  // 127 is the shell's "command not found".
  if (ran.exitCode === 127) {
    return {
      status: "refused",
      message: `Codex isn't installed on ${placement.serverName}, or isn't on the PATH an SSH login gets there.`,
    };
  }
  const version = ran.exitCode === 0 ? SEMVER.exec(ran.output)?.[1] : undefined;
  return version === undefined
    ? {
        status: "refused",
        message: `Octant could not read the Codex version on ${placement.serverName}.`,
      }
    : { status: "found", version };
}

/**
 * Starts `codex app-server` on the server and initializes it. The connection
 * ends when its scope closes: standard input closes, and the host ends the
 * SSH connection if it is still open shortly after.
 */
export function startCodexOnServer(input: {
  readonly placement: ProviderServerPlacement;
  readonly args: (version: string) => ReadonlyArray<string>;
  readonly octantVersion: string;
}): Effect.Effect<CodexAppServerConnection, ProviderFailure, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const found = await readCodexVersionOnServer(input.placement);
        if (found.status === "refused") throw failure("unavailable", found.message);
        const stream = input.placement.start(["codex", ...input.args(found.version)]);
        if (stream.status === "unreachable") throw failure("unavailable", stream.message);
        const rpc = makeCodexRpcClient({
          stdin: stream.stdin,
          stdout: stream.stdout,
          stderr: stream.stderr,
          limits: { requestTimeoutMs: STARTUP_TIMEOUT_MS },
        });
        const exited = Promise.race([stream.exited.then(() => undefined), rpc.exited]);
        void exited.catch(() => undefined);
        try {
          await rpc.request(
            "initialize",
            {
              clientInfo: { name: "Octant", title: "Octant", version: input.octantVersion },
              capabilities: { experimentalApi: true, requestAttestation: false },
            },
            decodeInitializeResult,
          );
          await rpc.notify("initialized");
        } catch {
          stream.stop();
          await rpc.close().catch(() => undefined);
          throw failure(
            "unavailable",
            `Codex on ${input.placement.serverName} did not start. Check that it is signed in there.`,
          );
        }
        // The process lives on the server; this host holds no pid of it.
        const connection: CodexAppServerConnection = {
          version: found.version,
          pid: 0,
          rpc,
          exited,
          // No egress proxy runs on the server, so its commands reach the
          // network as the server allows; the sandbox should say so.
          networkOpen: true,
        };
        return { connection, stop: stream.stop };
      },
      catch: (error) =>
        isProviderFailure(error)
          ? error
          : failure("unavailable", `Codex could not start on ${input.placement.serverName}.`),
    }),
    ({ connection, stop }) =>
      Effect.promise(async () => {
        await connection.rpc.close().catch(() => undefined);
        stop();
      }),
  ).pipe(Effect.map(({ connection }) => connection));
}
