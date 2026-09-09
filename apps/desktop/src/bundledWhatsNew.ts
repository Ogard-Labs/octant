import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Local notes for the running desktop build.
 *
 * Packaged next to the binary and read from disk. Opening What's new never
 * contacts a network; a missing or unreadable file is an empty state, not a
 * fetch (`docs/decisions/0061`).
 */
export const BUNDLED_WHATS_NEW_FILENAME = "whats-new.txt" as const;
export const WHATS_NEW_STATE_FILENAME = "octant-whats-new.json" as const;

/**
 * Larger than the signed-feed summary, still small enough that a swapped
 * giant file cannot be treated as notes.
 */
export const MAX_BUNDLED_WHATS_NEW_CHARS = 32_768;

export type WhatsNewDocument =
  | { readonly kind: "notes"; readonly text: string }
  | { readonly kind: "empty" };

export type BundledWhatsNew =
  | {
      readonly kind: "notes";
      readonly version: string;
      readonly text: string;
      readonly showAfterApply: boolean;
    }
  | {
      readonly kind: "empty";
      readonly version: string;
      readonly showAfterApply: false;
    };

export function resolveBundledWhatsNewPath(options: {
  readonly packaged: boolean;
  readonly appPath: string;
  readonly moduleUrl: string;
}): string {
  return options.packaged
    ? resolve(options.appPath, "apps/desktop/resources", BUNDLED_WHATS_NEW_FILENAME)
    : resolve(
        dirname(fileURLToPath(options.moduleUrl)),
        "../resources",
        BUNDLED_WHATS_NEW_FILENAME,
      );
}

export function resolveWhatsNewStatePath(userDataDirectory: string): string {
  return join(userDataDirectory, WHATS_NEW_STATE_FILENAME);
}

export function parseWhatsNewDocument(raw: string): WhatsNewDocument {
  const text = raw.trim();
  if (text === "" || text.length > MAX_BUNDLED_WHATS_NEW_CHARS) return { kind: "empty" };
  return { kind: "notes", text };
}

export function parseLastShownVersion(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("schemaVersion" in parsed) ||
      parsed.schemaVersion !== 1 ||
      !("lastShownVersion" in parsed) ||
      typeof parsed.lastShownVersion !== "string" ||
      parsed.lastShownVersion.length === 0 ||
      parsed.lastShownVersion.length > 64
    ) {
      return undefined;
    }
    return parsed.lastShownVersion;
  } catch {
    return undefined;
  }
}

export function encodeLastShownVersion(version: string): string {
  return `${JSON.stringify({ schemaVersion: 1, lastShownVersion: version })}\n`;
}

/**
 * Whether this launch should open What's new after an applied update.
 *
 * First launch of an install records the running version and stays quiet —
 * first-run setup is not a release blog. A later version with bundled notes
 * is what the person chose to install.
 */
export function decideWhatsNewPresentation(input: {
  readonly currentVersion: string;
  readonly lastShownVersion: string | undefined;
  readonly document: WhatsNewDocument;
}): {
  readonly showAfterApply: boolean;
  readonly recordOnRead: boolean;
} {
  if (input.lastShownVersion === undefined) {
    return { showAfterApply: false, recordOnRead: true };
  }
  if (input.lastShownVersion === input.currentVersion) {
    return { showAfterApply: false, recordOnRead: false };
  }
  return {
    showAfterApply: input.document.kind === "notes",
    recordOnRead: false,
  };
}

export async function loadBundledWhatsNew(options: {
  readonly currentVersion: string;
  readonly notesPath: string;
  readonly statePath: string;
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, contents: string) => Promise<void>;
}): Promise<BundledWhatsNew> {
  const document = await readDocument(options.notesPath, options.readFile);
  const lastShownVersion = await readLastShown(options.statePath, options.readFile);
  const decision = decideWhatsNewPresentation({
    currentVersion: options.currentVersion,
    lastShownVersion,
    document,
  });
  if (decision.recordOnRead) {
    try {
      await options.writeFile(options.statePath, encodeLastShownVersion(options.currentVersion));
    } catch {
      // Remembering the version is best-effort. Failing the read would either
      // skip notes or turn every launch into a prompt.
    }
  }
  if (document.kind === "empty") {
    return { kind: "empty", version: options.currentVersion, showAfterApply: false };
  }
  return {
    kind: "notes",
    version: options.currentVersion,
    text: document.text,
    showAfterApply: decision.showAfterApply,
  };
}

export async function acknowledgeWhatsNew(options: {
  readonly currentVersion: string;
  readonly statePath: string;
  readonly writeFile: (path: string, contents: string) => Promise<void>;
}): Promise<void> {
  await options.writeFile(options.statePath, encodeLastShownVersion(options.currentVersion));
}

async function readDocument(
  path: string,
  readFile: (path: string) => Promise<string>,
): Promise<WhatsNewDocument> {
  try {
    return parseWhatsNewDocument(await readFile(path));
  } catch {
    return { kind: "empty" };
  }
}

async function readLastShown(
  path: string,
  readFile: (path: string) => Promise<string>,
): Promise<string | undefined> {
  try {
    return parseLastShownVersion(await readFile(path));
  } catch {
    return undefined;
  }
}
