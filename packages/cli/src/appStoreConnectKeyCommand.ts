import { failureMessage, type OpenedLocalControlSession } from "./localControl";

/** A `.p8` key is a few hundred bytes; the host bounds it at 4 KiB. */
const MAX_PRIVATE_KEY_BYTES = 4 * 1_024;

// Spelled out so each served route has a caller the wiring check can find.
const APP_STORE_CONNECT_KEY_ROUTES = {
  set: "/api/desktop/app-store-connect-key/set",
  status: "/api/desktop/app-store-connect-key/status",
  remove: "/api/desktop/app-store-connect-key/remove",
} as const;

export type AppStoreConnectKeyCliCommand =
  | {
      readonly action: "set";
      readonly issuerId: string;
      readonly keyId: string;
      readonly replace: boolean;
      /**
       * Where the key is kept in 1Password, saved in the key's place. A
       * reference is not a secret, so it may be a flag value; the host reads
       * the key with the person's `op` only when it uses it.
       */
      readonly onePasswordReference?: string;
    }
  | { readonly action: "status" | "remove" };

/**
 * `octant apple key set --issuer <id> --key-id <id> --stdin [--replace]`,
 * `octant apple key set --issuer <id> --key-id <id> --op-reference
 * op://<vault>/<item>/<field> [--replace]`, and `octant apple key
 * status|remove`. The private key is read from standard
 * input only (`< AuthKey_<id>.p8`), never from an argument or a flag value,
 * which other processes and shell history can read. `--stdin` is required so
 * a forgotten redirect is refused instead of waiting on a terminal.
 */
export function resolveAppStoreConnectKeyCliCommand(
  positional: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): AppStoreConnectKeyCliCommand | undefined {
  const [noun, action, ...rest] = positional;
  if (noun !== "key" || rest.length !== 0) return undefined;
  if (action === "status" || action === "remove") {
    return Object.keys(flags).length === 0 ? { action } : undefined;
  }
  if (action !== "set") return undefined;
  const { issuer, "key-id": keyId, stdin, "op-reference": reference, replace, ...others } = flags;
  // Exactly one source: the key on standard input, or its 1Password reference.
  const fromStdin = stdin === true && reference === undefined;
  const fromOnePassword = stdin === undefined && typeof reference === "string";
  if (
    Object.keys(others).length !== 0 ||
    typeof issuer !== "string" ||
    typeof keyId !== "string" ||
    !(fromStdin || fromOnePassword) ||
    (replace !== undefined && replace !== true)
  ) {
    return undefined;
  }
  return {
    action: "set",
    issuerId: issuer,
    keyId,
    replace: replace === true,
    ...(typeof reference === "string" ? { onePasswordReference: reference } : {}),
  };
}

export interface RunAppStoreConnectKeyCliCommandInput {
  readonly command: AppStoreConnectKeyCliCommand;
  readonly session: OpenedLocalControlSession;
  /** Reads standard input to its end. */
  readonly readStdin: () => Promise<string>;
  readonly stdout: { readonly write: (chunk: string) => unknown };
  readonly stderr: { readonly write: (chunk: string) => unknown };
}

export async function runAppStoreConnectKeyCliCommand(
  input: RunAppStoreConnectKeyCliCommandInput,
): Promise<number> {
  const { command, session } = input;
  let body: Record<string, unknown> = {};
  if (command.action === "set" && command.onePasswordReference !== undefined) {
    body = {
      issuerId: command.issuerId,
      keyId: command.keyId,
      onePasswordReference: command.onePasswordReference,
      replace: command.replace,
    };
  } else if (command.action === "set") {
    const privateKey = (await input.readStdin()).trim();
    if (privateKey === "") {
      input.stderr.write(
        "No private key on standard input; nothing was saved. Run it as `octant apple key set --issuer <id> --key-id <id> --stdin < AuthKey_<id>.p8`.\n",
      );
      return 1;
    }
    if (Buffer.byteLength(privateKey, "utf8") > MAX_PRIVATE_KEY_BYTES) {
      input.stderr.write("That is larger than an App Store Connect key; nothing was saved.\n");
      return 1;
    }
    body = {
      issuerId: command.issuerId,
      keyId: command.keyId,
      privateKey,
      replace: command.replace,
    };
  }
  const response = await session.send({
    path: APP_STORE_CONNECT_KEY_ROUTES[command.action],
    method: "POST",
    body,
  });
  const outcome =
    response.status === 200 && typeof response.body === "object" && response.body !== null
      ? (response.body as Record<string, unknown>).outcome
      : undefined;
  if (outcome === "stored" || outcome === "missing" || outcome === "removed") {
    input.stdout.write(
      outcome === "stored"
        ? "This host has an App Store Connect key.\n"
        : "This host has no App Store Connect key.\n",
    );
    return 0;
  }
  if (response.status === 200) {
    input.stderr.write("Octant returned an unusable answer.\n");
    return 1;
  }
  const category =
    typeof response.body === "object" && response.body !== null
      ? (response.body as Record<string, unknown>).category
      : undefined;
  input.stderr.write(
    `${
      category === "already-stored"
        ? "This host already has an App Store Connect key. Add --replace to overwrite it."
        : category === "credential-store-unavailable"
          ? "Nothing was changed: this host has no credential store the Octant server can reach. Use the Octant desktop app on this Mac."
          : failureMessage(response, "Octant refused the App Store Connect key request.")
    }\n`,
  );
  return 1;
}
