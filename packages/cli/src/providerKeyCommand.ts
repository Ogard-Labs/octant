import { failureMessage, type OpenedLocalControlSession } from "./localControl";

/** The credential broker's bound; a larger key is refused before it is sent. */
const MAX_KEY_BYTES = 12 * 1_024;

// Spelled out so each served route has a caller the wiring check can find.
const PROVIDER_KEY_ROUTES = {
  set: "/api/desktop/provider-credentials/set",
  status: "/api/desktop/provider-credentials/status",
  remove: "/api/desktop/provider-credentials/remove",
  "remove-provider": "/api/desktop/provider-credentials/remove-provider",
} as const;

export type ProviderKeyCliCommand =
  | {
      readonly action: "set";
      readonly instance: string;
      readonly fromStdin: boolean;
      readonly replace: boolean;
    }
  | { readonly action: "status" | "remove" | "remove-provider"; readonly instance: string };

/**
 * `octant provider key set|status|remove <instance>` and `octant provider remove
 * <instance>`. The key itself is never an argument or a flag value: argv is
 * visible to other processes and lands in shell history.
 */
export function resolveProviderKeyCliCommand(
  positional: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): ProviderKeyCliCommand | undefined {
  if (positional[0] === "remove") {
    const [, provider, ...others] = positional;
    return provider === undefined ||
      provider.trim() === "" ||
      others.length !== 0 ||
      Object.keys(flags).length !== 0
      ? undefined
      : { action: "remove-provider", instance: provider };
  }
  const [noun, action, instance, ...rest] = positional;
  if (noun !== "key" || instance === undefined || instance.trim() === "" || rest.length !== 0) {
    return undefined;
  }
  if (action === "status" || action === "remove") {
    return Object.keys(flags).length === 0 ? { action, instance } : undefined;
  }
  if (action !== "set") return undefined;
  if (
    Object.entries(flags).some(
      ([name, value]) => (name !== "stdin" && name !== "replace") || value !== true,
    )
  ) {
    return undefined;
  }
  return {
    action: "set",
    instance,
    fromStdin: flags.stdin === true,
    replace: flags.replace === true,
  };
}

export interface ProviderKeyInput {
  /** True when a person is at a terminal that can take a hidden prompt. */
  readonly interactive: boolean;
  /** Reads one line from the terminal with echo off; undefined when the person cancels. */
  readonly readHidden: (prompt: string) => Promise<string | undefined>;
  /** Reads standard input to its end. */
  readonly readStdin: () => Promise<string>;
}

export interface RunProviderKeyCliCommandInput {
  readonly command: ProviderKeyCliCommand;
  readonly session: OpenedLocalControlSession;
  readonly key: ProviderKeyInput;
  readonly platform: NodeJS.Platform;
  readonly stdout: { readonly write: (chunk: string) => unknown };
  readonly stderr: { readonly write: (chunk: string) => unknown };
}

export async function runProviderKeyCliCommand(
  input: RunProviderKeyCliCommandInput,
): Promise<number> {
  const { command, session } = input;
  let body: Record<string, unknown> = { instance: command.instance };
  if (command.action === "set") {
    const read = await readKey(command, input.key);
    if (read.kind === "refused") {
      input.stderr.write(`${read.message}\n`);
      return 1;
    }
    body = { instance: command.instance, credential: read.key, replace: command.replace };
  }
  const response = await session.send({
    path: PROVIDER_KEY_ROUTES[command.action],
    method: "POST",
    body,
  });
  if (response.status === 200) {
    const answer = answerOf(response.body);
    if (answer === undefined) {
      input.stderr.write("Octant returned an unusable answer.\n");
      return 1;
    }
    input.stdout.write(`${describeAnswer(answer, command)}\n`);
    return 0;
  }
  input.stderr.write(`${describeRefusal(response, command, input.platform)}\n`);
  return 1;
}

type ReadKey =
  | { readonly kind: "read"; readonly key: string }
  | { readonly kind: "refused"; readonly message: string };

async function readKey(
  command: Extract<ProviderKeyCliCommand, { action: "set" }>,
  key: ProviderKeyInput,
): Promise<ReadKey> {
  let value: string | undefined;
  if (command.fromStdin) {
    // One trailing newline is what `echo` and most secret managers add.
    value = (await key.readStdin()).replace(/\r?\n$/, "");
  } else if (key.interactive) {
    value = await key.readHidden("API key or bearer token (input hidden): ");
    if (value === undefined) return { kind: "refused", message: "No key was saved." };
  } else {
    return {
      kind: "refused",
      message:
        "No terminal to read the key from. Pipe it in with --stdin, for example `secret-reader | octant provider key set <instance> --stdin`.",
    };
  }
  if (value.trim() === "")
    return { kind: "refused", message: "The key is empty; nothing was saved." };
  if (Buffer.byteLength(value, "utf8") > MAX_KEY_BYTES) {
    return {
      kind: "refused",
      message: "The key is larger than the credential store accepts (12 KiB); nothing was saved.",
    };
  }
  return { kind: "read", key: value };
}

interface Answer {
  readonly outcome: "stored" | "missing" | "removed";
  readonly instanceId: string;
  readonly displayName: string | null;
}

function answerOf(body: unknown): Answer | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { outcome, instanceId, displayName } = body as Record<string, unknown>;
  if (outcome !== "stored" && outcome !== "missing" && outcome !== "removed") return undefined;
  if (typeof instanceId !== "string") return undefined;
  if (displayName !== null && typeof displayName !== "string") return undefined;
  return { outcome, instanceId, displayName };
}

function describeAnswer(answer: Answer, command: ProviderKeyCliCommand): string {
  const name =
    answer.displayName === null
      ? answer.instanceId
      : `${answer.displayName} (${answer.instanceId})`;
  if (answer.outcome === "stored") return `${name} has a stored key.`;
  if (answer.outcome === "missing") return `${name} has no stored key.`;
  if (command.action === "remove-provider") return `${name} was removed with its stored key.`;
  return `${name} has no stored key now.`;
}

function describeRefusal(
  response: { readonly status: number; readonly body: unknown },
  command: ProviderKeyCliCommand,
  platform: NodeJS.Platform,
): string {
  const body =
    typeof response.body === "object" && response.body !== null
      ? (response.body as Record<string, unknown>)
      : {};
  switch (body.category) {
    case "credential-store-unavailable": {
      const outcome = command.action === "remove-provider" ? "removed" : "saved";
      return platform === "linux"
        ? `Nothing was ${outcome}: the Octant server has no credential store. Changing a key needs a running Secret Service (org.freedesktop.secrets on your user session bus) and /usr/bin/secret-tool. Start and unlock the keyring, then run \`octant server restart\` and try again.`
        : `Nothing was ${outcome}: this host has no credential store the Octant server can reach. Use the Octant desktop app.`;
    }
    case "journal-unavailable":
      return "Nothing was changed: Octant could not record the change in its journal. Try again.";
    case "provider-refused":
      return `"${command.instance}" was not removed: ${typeof body.message === "string" ? body.message : "Octant refused."}`;
    case "provider-removed-key-kept": {
      const id = typeof body.instanceId === "string" ? body.instanceId : command.instance;
      return `"${command.instance}" was removed, but its stored key could not be cleared. Octant retries when it next starts; to clear it now, run \`octant provider key remove ${id}\`.`;
    }
    case "ambiguous": {
      const candidates = Array.isArray(body.candidates) ? body.candidates : [];
      const lines = candidates.flatMap((candidate: unknown) => {
        if (typeof candidate !== "object" || candidate === null) return [];
        const { id, displayName } = candidate as Record<string, unknown>;
        return typeof id === "string" && typeof displayName === "string"
          ? [`  ${id}  ${displayName}`]
          : [];
      });
      return [`More than one provider is named "${command.instance}". Use its id:`, ...lines].join(
        "\n",
      );
    }
    case "not-found":
      return `No provider has the id or name "${command.instance}".`;
    case "no-stored-key-authentication":
      return `"${command.instance}" does not use an API key or bearer token, so it has no key to store.`;
    case "already-stored":
      return `"${command.instance}" already has a stored key. Add --replace to overwrite it.`;
    case "several-keys":
      return `"${command.instance}" holds several keys. Remove them with \`octant provider key remove\`, then set one key.`;
    case "unauthorized":
      return "Octant refused this command's local authority.";
    default:
      return failureMessage(response, "Octant refused the provider key request.");
  }
}

/**
 * Reads one line from a terminal with echo off. Every keystroke is consumed
 * here and nothing is written back, so the key never appears on screen, not
 * even as a mask that would reveal its length.
 */
export interface TerminalInput {
  readonly isRaw: boolean;
  readonly setRawMode: (mode: boolean) => unknown;
  readonly resume: () => unknown;
  readonly pause: () => unknown;
  readonly on: (event: "data", listener: (chunk: Buffer | string) => void) => unknown;
  readonly removeListener: (event: "data", listener: (chunk: Buffer | string) => void) => unknown;
}

export function readHiddenLineFromTerminal(
  stdin: TerminalInput,
  stderr: { readonly write: (chunk: string) => unknown },
  prompt: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let value = "";
    const wasRaw = stdin.isRaw;
    const finish = (result: string | undefined): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stderr.write("\n");
      resolve(result);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\r" || character === "\n") return finish(value);
        // Ctrl-C and Ctrl-D cancel without saving anything.
        if (character === "\u0003" || character === "\u0004") return finish(undefined);
        if (character === "\u007f" || character === "\b") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        value += character;
      }
    };
    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

export async function readAllStdin(stdin: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
