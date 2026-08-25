import { randomBytes as secureRandomBytes } from "node:crypto";
import { basename } from "node:path";

export type BoundProjectType = "work" | "code";

export type ProjectRootPickerResult =
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "selected"; receiptId: string; displayName: string }>;

export class ProjectRootPickerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectRootPickerError";
  }
}

/**
 * Marks a failure whose message is a fixed sentence about host state and holds
 * no capability material, so the person at the screen may read it. Anything
 * else that refuses a Project window keeps its message to itself: a rejection
 * raised while handling a capability can carry that capability in its text.
 */
export interface NamesItsCause {
  readonly namesItsCause: true;
}

export function namesItsCause(error: unknown): error is Error & NamesItsCause {
  return error instanceof Error && "namesItsCause" in error && error.namesItsCause === true;
}

/** The server has paused window-authority issuance until host time recovers. */
export class ProjectWindowAuthorityUnavailableError
  extends ProjectRootPickerError
  implements NamesItsCause
{
  readonly namesItsCause = true;

  constructor() {
    super("Octant cannot authorize this Project window while host time recovery is required.");
    this.name = "ProjectWindowAuthorityUnavailableError";
  }
}

interface OwnedWindowPort {
  readonly isDestroyed: () => boolean;
}

interface PickerEventPort {
  readonly sender: unknown;
}

interface DialogPort<TWindow extends OwnedWindowPort> {
  readonly showOpenDialog: (
    window: TWindow,
    options: { readonly properties: readonly ["openDirectory", "dontAddToRecent"] },
  ) => Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>;
}

interface FetchPort {
  (input: string, init: RequestInit): Promise<Response>;
}

interface ProjectRootPickerOptions<TWindow extends OwnedWindowPort> {
  readonly desktopBridgeSecret: string;
  readonly dialog: DialogPort<TWindow>;
  readonly fetch?: FetchPort;
  readonly resolveOwnedWindow: (sender: unknown) => TWindow | undefined;
  readonly serverUrl: string;
  readonly windowId: string;
}

export function createProjectRootPicker<TWindow extends OwnedWindowPort>(
  options: ProjectRootPickerOptions<TWindow>,
) {
  const fetch = options.fetch ?? globalThis.fetch;
  return async (event: PickerEventPort, projectType: unknown): Promise<ProjectRootPickerResult> => {
    if (projectType !== "work" && projectType !== "code") {
      throw new ProjectRootPickerError("Octant rejected an invalid Project root request.");
    }
    const window = options.resolveOwnedWindow(event.sender);
    if (window === undefined || window.isDestroyed()) {
      throw new ProjectRootPickerError("Octant rejected an unauthorized Project root request.");
    }

    let selection: { readonly canceled: boolean; readonly filePaths: readonly string[] };
    try {
      selection = await options.dialog.showOpenDialog(window, {
        properties: ["openDirectory", "dontAddToRecent"],
      });
    } catch {
      throw new ProjectRootPickerError("Octant could not open the Project root picker.");
    }
    if (selection.canceled) return Object.freeze({ kind: "cancelled" });
    const path = selection.filePaths.length === 1 ? selection.filePaths[0] : undefined;
    if (path === undefined || path.length === 0) {
      throw new ProjectRootPickerError("Octant did not receive a valid Project root selection.");
    }

    const response = await safeFetch(fetch, receiptUrl(options.serverUrl), {
      method: "POST",
      headers: desktopHeaders(options.desktopBridgeSecret),
      body: JSON.stringify({ windowId: options.windowId, projectType, path }),
    });
    if (await isRejectedProjectRoot(response)) {
      throw new ProjectRootPickerError("Choose an accessible directory.");
    }
    if (response.status !== 201) {
      throw new ProjectRootPickerError("Octant could not validate the selected Project root.");
    }
    const receiptId = await decodeReceiptResponse(response, projectType);
    const displayName = basename(path);
    return Object.freeze({ kind: "selected", receiptId, displayName });
  };
}

interface ProjectWindowAuthorityOptions {
  readonly desktopBridgeSecret: string;
  readonly fetch?: FetchPort;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly rendererIdentity?: string;
  readonly serverUrl: string;
  readonly windowId: string;
}

export function generateProjectBridgeToken(
  randomBytes: (size: number) => Uint8Array = secureRandomBytes,
): string {
  return Buffer.from(randomBytes(32)).toString("base64url");
}

export async function createProjectWindowAuthority(
  options: ProjectWindowAuthorityOptions,
): Promise<{
  readonly capability: string;
  readonly rendererIdentity: string;
  readonly revoke: () => Promise<void>;
}> {
  const fetch = options.fetch ?? globalThis.fetch;
  const capability = generateProjectBridgeToken(options.randomBytes);
  const rendererIdentity =
    options.rendererIdentity ?? generateProjectBridgeToken(options.randomBytes);
  const url = authorityUrl(options.serverUrl);
  const headers = desktopHeaders(options.desktopBridgeSecret);
  const response = await safeFetch(fetch, url, {
    method: "POST",
    headers,
    body: JSON.stringify({ windowId: options.windowId, capability, rendererIdentity }),
  });
  if (response.status === 503) {
    throw new ProjectWindowAuthorityUnavailableError();
  }
  if (response.status !== 204) {
    throw new ProjectRootPickerError("Octant could not authorize this Project window.");
  }
  return Object.freeze({
    capability,
    rendererIdentity,
    revoke: async () => {
      const revokeResponse = await safeFetch(fetch, url, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ windowId: options.windowId }),
      });
      if (revokeResponse.status !== 204) {
        throw new ProjectRootPickerError("Octant could not revoke this Project window.");
      }
    },
  });
}

async function safeFetch(fetch: FetchPort, input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new ProjectRootPickerError("Octant could not reach its Project authority service.");
  }
}

async function decodeReceiptResponse(
  response: Response,
  projectType: BoundProjectType,
): Promise<string> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ProjectRootPickerError("Octant returned an invalid Project root receipt.");
  }
  if (!isRecord(value) || !hasExactKeys(value, ["expiresAt", "projectType", "receiptId"])) {
    throw new ProjectRootPickerError("Octant returned an invalid Project root receipt.");
  }
  if (
    value.projectType !== projectType ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt) ||
    typeof value.receiptId !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.receiptId)
  ) {
    throw new ProjectRootPickerError("Octant returned an invalid Project root receipt.");
  }
  return value.receiptId;
}

async function isRejectedProjectRoot(response: Response): Promise<boolean> {
  if (response.status !== 400 && response.status !== 503) return false;
  try {
    const value: unknown = await response.clone().json();
    return (
      isRecord(value) &&
      value.category === "unavailable" &&
      value.message === "The selected Project root is unavailable."
    );
  } catch {
    return false;
  }
}

function desktopHeaders(secret: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-octant-desktop-secret": secret,
  };
}

function authorityUrl(serverUrl: string): string {
  return new URL("/api/desktop/window-authorities", serverUrl).toString();
}

function receiptUrl(serverUrl: string): string {
  return new URL("/api/desktop/project-binding-receipts", serverUrl).toString();
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
