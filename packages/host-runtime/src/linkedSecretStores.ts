/**
 * Linked external secret stores.
 *
 * A person can link a secret store they already use (the 1Password CLI today)
 * and point a provider API key or a connector credential at an item in it
 * instead of pasting the value. Octant keeps only the pointer: the store name
 * and the item reference, stored in the host credential store under the same
 * id the value would have had. The credential broker follows the pointer when
 * the value is used, hands the value to the caller that asked, and holds on to
 * nothing. A reference names an item and is not a secret; the value is never
 * journaled, logged, written to disk, or returned to a renderer.
 *
 * Every adapter answers with a value the caller must handle (`read`, `locked`,
 * `missing`, `unavailable`, ...), never an exception, and a store that cannot
 * answer fails closed: no value is invented, cached, or taken from elsewhere.
 * Adding another tool (the Bitwarden CLI, a macOS Keychain item) means adding
 * an adapter to {@link LINKED_SECRET_STORE_KINDS} and nothing else.
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Closed list of tools Octant can link. A new tool is a new adapter here. */
export const LINKED_SECRET_STORE_KINDS = ["onepassword"] as const;
export type LinkedSecretStoreKind = (typeof LINKED_SECRET_STORE_KINDS)[number];

export function isLinkedSecretStoreKind(value: unknown): value is LinkedSecretStoreKind {
  return LINKED_SECRET_STORE_KINDS.some((kind) => kind === value);
}

/** The longest reference Octant keeps. Real references are far shorter. */
export const MAX_LINKED_SECRET_REFERENCE_LENGTH = 512;
/** A fetched value larger than this is refused, matching the broker's credential bound. */
export const MAX_LINKED_SECRET_VALUE_BYTES = 12 * 1_024;

export type LinkedSecretRead =
  | { readonly status: "read"; readonly value: string }
  | { readonly status: "locked" }
  | { readonly status: "missing" }
  | { readonly status: "unavailable" }
  | { readonly status: "not-linked" }
  | { readonly status: "invalid-reference" };

/** What a read says without the value, for the check that proves a reference works. */
export type LinkedSecretCheck =
  | { readonly status: "found" }
  | Exclude<LinkedSecretRead, { readonly status: "read" }>;

export type LinkedSecretToolState = "ready" | "locked" | "not-installed" | "unavailable";

export interface LinkedSecretStoreAdapter {
  readonly kind: LinkedSecretStoreKind;
  /** Shown in Settings. */
  readonly label: string;
  /** Whether the reference has the shape this tool understands. */
  readonly isValidReference: (reference: string) => boolean;
  /** Whether the tool is installed and the store is open to it. */
  readonly probe: () => Promise<LinkedSecretToolState>;
  readonly read: (reference: string) => Promise<LinkedSecretRead>;
}

export interface LinkedSecretStoreStatus {
  readonly kind: LinkedSecretStoreKind;
  readonly label: string;
  readonly linked: boolean;
  readonly linkedAt?: string;
  readonly tool: LinkedSecretToolState;
}

export type LinkSecretStoreResult =
  | { readonly status: "linked" }
  | { readonly status: "locked" }
  | { readonly status: "not-installed" }
  | { readonly status: "unavailable" };

export interface LinkedSecretStores {
  readonly status: () => Promise<ReadonlyArray<LinkedSecretStoreStatus>>;
  readonly link: (kind: LinkedSecretStoreKind) => Promise<LinkSecretStoreResult>;
  readonly unlink: (kind: LinkedSecretStoreKind) => Promise<void>;
  readonly isLinked: (kind: LinkedSecretStoreKind) => Promise<boolean>;
  readonly isValidReference: (kind: LinkedSecretStoreKind, reference: string) => boolean;
  /** Fetches the value now. Fails closed when the store is not linked. */
  readonly read: (kind: LinkedSecretStoreKind, reference: string) => Promise<LinkedSecretRead>;
  /** Proves a reference resolves without returning the value. */
  readonly check: (kind: LinkedSecretStoreKind, reference: string) => Promise<LinkedSecretCheck>;
}

// ---------------------------------------------------------------------------
// The pointer kept in the credential store.

const MATERIAL_PREFIX = "octant-linked-secret:v1:";

export interface LinkedSecretPointer {
  readonly store: LinkedSecretStoreKind;
  readonly reference: string;
}

export function encodeLinkedSecretPointer(pointer: LinkedSecretPointer): string {
  return `${MATERIAL_PREFIX}${JSON.stringify({ store: pointer.store, reference: pointer.reference })}`;
}

/** True for a stored value that is a pointer, so no route returns it as a key. */
export function isLinkedSecretMaterial(value: string): boolean {
  return value.startsWith(MATERIAL_PREFIX);
}

/** The pointer a stored value holds; undefined when it is not one or is malformed. */
export function decodeLinkedSecretPointer(value: string): LinkedSecretPointer | undefined {
  if (!isLinkedSecretMaterial(value)) return undefined;
  try {
    const parsed: unknown = JSON.parse(value.slice(MATERIAL_PREFIX.length));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).length !== 2) return undefined;
    const { store, reference } = record;
    if (!isLinkedSecretStoreKind(store) || typeof reference !== "string") return undefined;
    if (!isPlainReference(reference)) return undefined;
    return { store, reference };
  } catch {
    return undefined;
  }
}

function isPlainReference(reference: string): boolean {
  return (
    reference.length > 0 &&
    reference.length <= MAX_LINKED_SECRET_REFERENCE_LENGTH &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(reference)
  );
}

// ---------------------------------------------------------------------------
// 1Password CLI adapter.

export interface CommandResult {
  readonly kind: "exited";
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandOutcome =
  | CommandResult
  | { readonly kind: "not-found" }
  | { readonly kind: "failed" };

export type CommandRunner = (
  file: string,
  args: ReadonlyArray<string>,
  options: { readonly timeoutMs: number; readonly env: NodeJS.ProcessEnv },
) => Promise<CommandOutcome>;

/** `execFile` without a shell: the reference is one argument and is never interpreted. */
export const runCommand: CommandRunner = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        timeout: options.timeoutMs,
        env: options.env,
        maxBuffer: 4 * MAX_LINKED_SECRET_VALUE_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ kind: "exited", exitCode: 0, stdout, stderr });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EACCES") {
          resolve({ kind: "not-found" });
          return;
        }
        if (typeof code === "number") {
          resolve({ kind: "exited", exitCode: code, stdout, stderr });
          return;
        }
        resolve({ kind: "failed" });
      },
    );
  });

const ONE_PASSWORD_REFERENCE = /^op:\/\/[^/\s][^/]*\/[^/]+(\/[^/]+){1,2}$/;
const ONE_PASSWORD_LOCATIONS = [
  "/opt/homebrew/bin/op",
  "/usr/local/bin/op",
  "/usr/bin/op",
  "/snap/bin/op",
] as const;
const LOCKED_TEXT = /not signed in|sign in|signed out|locked|unlock|authoriz|authenticat/i;
const MISSING_TEXT =
  /isn't an item|isn't a vault|isn't a field|isn't a section|could not be found|does not exist/i;

export interface OnePasswordAdapterOptions {
  /** A fixed path to `op`; otherwise the usual install locations and PATH are searched. */
  readonly executablePath?: string;
  readonly run?: CommandRunner;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

export function makeOnePasswordAdapter(
  options: OnePasswordAdapterOptions = {},
): LinkedSecretStoreAdapter {
  const run = options.run ?? runCommand;
  const timeoutMs = options.timeoutMs ?? 45_000;
  const environment = (): NodeJS.ProcessEnv => {
    const source = options.env ?? process.env;
    // The tool needs the person's own environment (HOME, its session
    // variables); Octant's own variables are none of its business.
    return Object.fromEntries(
      Object.entries(source).filter(([name]) => !name.toUpperCase().startsWith("OCTANT_")),
    );
  };
  const executable = async (): Promise<string | undefined> => {
    if (options.executablePath !== undefined) return options.executablePath;
    const candidates = [
      ...ONE_PASSWORD_LOCATIONS,
      ...((options.env ?? process.env).PATH?.split(process.platform === "win32" ? ";" : ":")
        .filter((directory) => directory.startsWith("/"))
        .map((directory) => join(directory, "op")) ?? []),
    ];
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Try the next location.
      }
    }
    return undefined;
  };
  const classify = (outcome: CommandOutcome): "ok" | "locked" | "missing" | "unavailable" => {
    if (outcome.kind !== "exited") return "unavailable";
    if (outcome.exitCode === 0) return "ok";
    // Only the wording is read, and it is dropped here: it is never kept or
    // passed on, so nothing the tool prints can reach a log or a response.
    // The tool echoes the item and vault names, which a person can name
    // "Locked", so the specific missing-item wording is read first.
    if (MISSING_TEXT.test(outcome.stderr)) return "missing";
    if (LOCKED_TEXT.test(outcome.stderr)) return "locked";
    return "unavailable";
  };

  return {
    kind: "onepassword",
    label: "1Password",
    isValidReference: (reference) =>
      isPlainReference(reference) && ONE_PASSWORD_REFERENCE.test(reference),
    probe: async () => {
      const file = await executable();
      if (file === undefined) return "not-installed";
      const outcome = await run(file, ["whoami"], { timeoutMs, env: environment() });
      if (outcome.kind === "not-found") return "not-installed";
      const result = classify(outcome);
      return result === "ok" ? "ready" : result === "locked" ? "locked" : "unavailable";
    },
    read: async (reference) => {
      if (!ONE_PASSWORD_REFERENCE.test(reference) || !isPlainReference(reference)) {
        return { status: "invalid-reference" };
      }
      const file = await executable();
      if (file === undefined) return { status: "unavailable" };
      const outcome = await run(file, ["read", "--no-newline", reference], {
        timeoutMs,
        env: environment(),
      });
      const result = classify(outcome);
      if (result !== "ok") return { status: result };
      const value = outcome.kind === "exited" ? outcome.stdout : "";
      if (value.length === 0) return { status: "missing" };
      if (Buffer.byteLength(value, "utf8") > MAX_LINKED_SECRET_VALUE_BYTES) {
        return { status: "unavailable" };
      }
      return { status: "read", value };
    },
  };
}

// ---------------------------------------------------------------------------
// The registry of linked stores, and the service the broker uses.

export interface LinkedSecretStoresOptions {
  /** Where the linked-store record is kept (a small non-secret JSON file, mode 0600). */
  readonly statePath: string;
  readonly adapters?: ReadonlyArray<LinkedSecretStoreAdapter>;
  readonly now?: () => string;
}

interface LinkedState {
  readonly stores: Readonly<Partial<Record<LinkedSecretStoreKind, { readonly linkedAt: string }>>>;
}

export function linkedSecretStoresStatePath(dataDirectory: string): string {
  return join(dataDirectory, "secret-stores", "linked-secret-stores.json");
}

export function makeLinkedSecretStores(options: LinkedSecretStoresOptions): LinkedSecretStores {
  const adapters = options.adapters ?? [makeOnePasswordAdapter()];
  const now = options.now ?? (() => new Date().toISOString());
  const adapterFor = (kind: LinkedSecretStoreKind): LinkedSecretStoreAdapter | undefined =>
    adapters.find((adapter) => adapter.kind === kind);

  // A missing or unreadable record means nothing is linked: fail closed.
  const load = async (): Promise<LinkedState> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(options.statePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return { stores: {} };
      const stores = (parsed as { stores?: unknown }).stores;
      if (typeof stores !== "object" || stores === null) return { stores: {} };
      const result: Partial<Record<LinkedSecretStoreKind, { linkedAt: string }>> = {};
      for (const kind of LINKED_SECRET_STORE_KINDS) {
        const entry = (stores as Record<string, unknown>)[kind];
        const linkedAt =
          typeof entry === "object" && entry !== null
            ? (entry as { linkedAt?: unknown }).linkedAt
            : undefined;
        if (typeof linkedAt === "string") result[kind] = { linkedAt };
      }
      return { stores: result };
    } catch {
      return { stores: {} };
    }
  };
  let writes: Promise<unknown> = Promise.resolve();
  const save = (state: LinkedState): Promise<void> => {
    const run = writes.then(async () => {
      await mkdir(dirname(options.statePath), { recursive: true, mode: 0o700 });
      const staging = `${options.statePath}.${process.pid}.tmp`;
      await writeFile(staging, `${JSON.stringify({ version: 1, ...state })}\n`, { mode: 0o600 });
      await rename(staging, options.statePath);
    });
    writes = run.catch(() => undefined);
    return run;
  };

  return {
    status: async () => {
      const state = await load();
      return Promise.all(
        adapters.map(async (adapter) => {
          const entry = state.stores[adapter.kind];
          return {
            kind: adapter.kind,
            label: adapter.label,
            linked: entry !== undefined,
            ...(entry === undefined ? {} : { linkedAt: entry.linkedAt }),
            tool: await adapter.probe(),
          };
        }),
      );
    },
    link: async (kind) => {
      const adapter = adapterFor(kind);
      if (adapter === undefined) return { status: "unavailable" };
      // Linking is the person's decision, and it needs the store open now: a
      // locked or missing tool is reported and nothing is linked.
      const tool = await adapter.probe();
      if (tool !== "ready") return { status: tool };
      const state = await load();
      await save({ stores: { ...state.stores, [kind]: { linkedAt: now() } } });
      return { status: "linked" };
    },
    unlink: async (kind) => {
      const state = await load();
      const { [kind]: _removed, ...rest } = state.stores;
      await save({ stores: rest });
    },
    isLinked: async (kind) => (await load()).stores[kind] !== undefined,
    isValidReference: (kind, reference) => adapterFor(kind)?.isValidReference(reference) ?? false,
    read: async (kind, reference) => {
      const adapter = adapterFor(kind);
      if (adapter === undefined) return { status: "unavailable" };
      if (!adapter.isValidReference(reference)) return { status: "invalid-reference" };
      if ((await load()).stores[kind] === undefined) return { status: "not-linked" };
      return adapter.read(reference);
    },
    check: async (kind, reference) => {
      const adapter = adapterFor(kind);
      if (adapter === undefined) return { status: "unavailable" };
      if (!adapter.isValidReference(reference)) return { status: "invalid-reference" };
      if ((await load()).stores[kind] === undefined) return { status: "not-linked" };
      const result = await adapter.read(reference);
      return result.status === "read" ? { status: "found" } : result;
    },
  };
}
