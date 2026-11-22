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
import { posix } from "node:path";
import {
  currentProtectedFilesChoice,
  protectedAtLevel,
  secretGuardEntries,
} from "../process/secretGuard";
import { decodeInitializeResult } from "./codexProtocol";
import type { CodexAppServerConnection } from "./codexProcess";
import { makeCodexRpcClient } from "./codexRpcClient";
import type { ServerSignIn, ServerSignIns } from "./serverSignIn";

const VERSION_TIMEOUT_MS = 20_000;
const SIGN_IN_TIMEOUT_MS = 20_000;
const STARTUP_TIMEOUT_MS = 30_000;
const SIGN_IN_PATHS_TIMEOUT_MS = 20_000;
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

/** Said when Codex on the server reports no sign-in for the server's login. */
export function codexServerSignInRefusal(serverName: string): string {
  return `Codex isn't signed in on ${serverName}. Sign in there as the server's login, for example by running \`codex login\` in the Project terminal, then try again.`;
}

/**
 * Whether Codex is signed in on the server, from its own `codex login status`
 * there: it exits 0 when signed in, and otherwise says it is not logged in.
 * Nothing it prints is kept, since a signed-in answer can name the key's kind.
 */
export async function readCodexSignInOnServer(
  placement: ProviderServerPlacement,
): Promise<ServerSignIn> {
  const ran = await placement.run(["codex", "login", "status"], {
    timeoutMs: SIGN_IN_TIMEOUT_MS,
  });
  if (ran.status === "unreachable") return { status: "refused", message: ran.message };
  if (ran.exitCode === 0) return { status: "signed-in" };
  if (/not logged in/i.test(`${ran.output}\n${ran.errorOutput}`)) return { status: "signed-out" };
  return {
    status: "refused",
    message: `Octant could not read whether Codex is signed in on ${placement.serverName}. Check \`codex login status\` in the Project terminal.`,
  };
}

/**
 * The other providers' sign-ins Codex's own sandbox refuses on the server, as
 * Octant refuses them locally: the secret guard's provider sign-in list (the
 * list Full access still refuses, after the person's Protected files choice)
 * resolved for the server login's home and platform, read there with `uname`
 * and `$HOME`. Codex's own home (`$CODEX_HOME`, else `~/.codex`) stays its
 * own; it is re-allowed when it sits inside a denied folder. Entries for this
 * host's own folders (Octant's data directory) name nothing on the server and
 * are left out. Without a home the list cannot be built, so the launch is
 * refused rather than leaving those sign-ins readable.
 */
export async function readCodexProtectedSignInsOnServer(
  placement: ProviderServerPlacement,
): Promise<
  | {
      readonly status: "found";
      readonly denied: ReadonlyArray<string>;
      readonly allowed: ReadonlyArray<string>;
    }
  | { readonly status: "refused"; readonly message: string }
> {
  const ran = await placement.run(
    ["sh", "-c", 'uname -s; printf "%s\\n" "$HOME" "${CODEX_HOME:-}"'],
    { timeoutMs: SIGN_IN_PATHS_TIMEOUT_MS },
  );
  const [system = "", home = "", codexHomeSetting = ""] =
    ran.status === "ran" && ran.exitCode === 0
      ? ran.output.split("\n").map((line) => line.trim())
      : [];
  // A login's `$HOME` may carry a trailing slash (`/home/build/`); kept, it
  // would leave every sign-in path outside the home and drop them all.
  const serverHome = posix.isAbsolute(home) ? posix.normalize(home).replace(/(?<=.)\/+$/, "") : "";
  const unreadable = {
    status: "refused",
    message: `Octant could not read the home folder of the login on ${placement.serverName}, so it cannot keep other providers' sign-ins there out of Codex's reach.`,
  } as const;
  if (serverHome === "") return unreadable;
  const inside = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);
  const codexHome = posix.isAbsolute(codexHomeSetting)
    ? posix.normalize(codexHomeSetting).replace(/(?<=.)\/+$/, "")
    : posix.join(serverHome, ".codex");
  const entries = protectedAtLevel(
    secretGuardEntries({
      platform: system === "Darwin" ? "darwin" : "linux",
      homeDirectory: serverHome,
    }),
    true,
  );
  const paths = entries
    .map((entry) => posix.normalize(entry.kind === "path" ? entry.path : entry.directory))
    .filter((path) => inside(path, serverHome));
  // Codex's own sign-in is its group entry, left out by identity: no path is
  // ever dropped for lying under `CODEX_HOME`, so another provider's sign-in
  // there stays denied.
  const codexOwnSignIn = posix.join(serverHome, ".codex", "auth.json");
  const denied = [...new Set(paths.filter((path) => path !== codexOwnSignIn))];
  // The Provider sign-ins group always names paths in a valid home, so an
  // empty list means the home was misread, unless the person removed the group.
  if (denied.length === 0 && !currentProtectedFilesChoice().removed.includes("provider-sign-ins")) {
    return unreadable;
  }
  // Codex must read and write its own home to run; one that holds another
  // provider's sign-in, or lies inside a denied folder, cannot be kept apart.
  const overlap = denied.find((path) => inside(path, codexHome) || inside(codexHome, path));
  if (overlap !== undefined) {
    return {
      status: "refused",
      message: `Codex's home on ${placement.serverName} (${codexHome}) overlaps another provider's sign-in (${overlap}), so Codex's sandbox can't keep that sign-in out of its reach. Set CODEX_HOME there to a folder of its own, or use Full access.`,
    };
  }
  return { status: "found", denied, allowed: [] };
}

/**
 * Starts `codex app-server` on the server and initializes it, once Codex
 * there reports a sign-in. The connection
 * ends when its scope closes: standard input closes, and the host ends the
 * SSH connection if it is still open shortly after.
 */
export function startCodexOnServer(input: {
  readonly placement: ProviderServerPlacement;
  readonly args: (version: string) => ReadonlyArray<string>;
  readonly octantVersion: string;
  /** Codex's sign-in answers per server, read before the app-server starts. */
  readonly signIns: ServerSignIns;
  /**
   * Whether the launch runs Codex's own sandbox, which carries the sign-in
   * deny list. Full access on a server has no sandbox, so no list is read.
   */
  readonly sandboxed: boolean;
}): Effect.Effect<CodexAppServerConnection, ProviderFailure, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const found = await readCodexVersionOnServer(input.placement);
        if (found.status === "refused") throw failure("unavailable", found.message);
        // Refused before the app-server starts: one with no sign-in would
        // start and fail only at its first model request.
        const signIn = await input.signIns.read(input.placement);
        if (signIn.status === "signed-out") {
          throw failure("unauthenticated", codexServerSignInRefusal(input.placement.serverName));
        }
        if (signIn.status === "refused") throw failure("unavailable", signIn.message);
        const protectedSignIns = input.sandboxed
          ? await readCodexProtectedSignInsOnServer(input.placement)
          : undefined;
        if (protectedSignIns?.status === "refused") {
          throw failure("unavailable", protectedSignIns.message);
        }
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
          ...(protectedSignIns === undefined
            ? {}
            : {
                protectedSignIns: {
                  denied: protectedSignIns.denied,
                  allowed: protectedSignIns.allowed,
                },
              }),
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
