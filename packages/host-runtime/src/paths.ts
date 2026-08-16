import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve, sep } from "node:path";

const MAX_SOCKET_PATH_BYTES = 103;

export type HostRuntimePathErrorCode =
  | "invalid-path"
  | "unsupported-platform"
  | "unsafe-symlink"
  | "unsafe-owner"
  | "unsafe-mode"
  | "socket-path-too-long";

export class HostRuntimePathError extends Error {
  readonly code: HostRuntimePathErrorCode;
  readonly path: string | undefined;

  constructor(code: HostRuntimePathErrorCode, message: string, path?: string) {
    super(message);
    this.name = "HostRuntimePathError";
    this.code = code;
    this.path = path;
  }
}

export interface HostRuntimePathInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly temporaryDirectory: string;
  readonly uid: number;
}

export interface HostRuntimePaths {
  readonly platform: "darwin" | "linux";
  readonly uid: number;
  readonly dataDirectory: string;
  readonly configDirectory: string;
  readonly stateDirectory: string;
  readonly logsDirectory: string;
  readonly runtimeDirectory: string;
  readonly runtimeBaseDirectory: string;
  readonly runtimeBaseIsExternal: boolean;
  readonly socketPath: string;
  readonly ownerReceiptPath: string;
  readonly controlSecretPath: string;
  readonly bridgeSecretPath: string;
  readonly hostInfoPath: string;
  readonly servicePolicyPath: string;
  readonly serviceLogPath: string;
}

export function resolveHostRuntimePaths(input: HostRuntimePathInput): HostRuntimePaths {
  if (input.platform !== "darwin" && input.platform !== "linux") {
    throw new HostRuntimePathError(
      "unsupported-platform",
      `Octant host runtime does not support ${input.platform}.`,
    );
  }
  if (!Number.isSafeInteger(input.uid) || input.uid < 0) {
    throw new HostRuntimePathError("unsafe-owner", "Octant requires a valid user id.");
  }
  const home = requiredAbsolutePath("home", input.home, input.platform);
  requiredAbsolutePath("temporary runtime directory", input.temporaryDirectory, input.platform);
  const explicitData = optionalAbsolutePath(
    "OCTANT_DATA_DIR",
    input.env.OCTANT_DATA_DIR,
    input.platform,
  );
  const requestedDataDirectory =
    explicitData ??
    (input.platform === "darwin"
      ? join(home, "Library", "Application Support", "Octant")
      : join(
          optionalAbsolutePath("XDG_DATA_HOME", input.env.XDG_DATA_HOME, input.platform) ??
            join(home, ".local", "share"),
          "octant",
        ));
  const createCanonicalDataDirectory = explicitData !== undefined || isCurrentMacHome(home);
  const dataDirectory = canonicalDataDirectory(
    requestedDataDirectory,
    input.platform,
    createCanonicalDataDirectory,
  );

  const configDirectory =
    explicitData !== undefined
      ? join(dataDirectory, "config")
      : input.platform === "darwin"
        ? join(dataDirectory, "config")
        : join(
            optionalAbsolutePath("XDG_CONFIG_HOME", input.env.XDG_CONFIG_HOME, input.platform) ??
              join(home, ".config"),
            "octant",
          );
  const stateDirectory =
    explicitData !== undefined
      ? join(dataDirectory, "state")
      : input.platform === "darwin"
        ? dataDirectory
        : join(
            optionalAbsolutePath("XDG_STATE_HOME", input.env.XDG_STATE_HOME, input.platform) ??
              join(home, ".local", "state"),
            "octant",
          );
  const logsDirectory =
    input.platform === "darwin"
      ? join(home, "Library", "Logs", "Octant")
      : join(stateDirectory, "logs");

  // Ownership cannot depend on caller-specific TMPDIR/XDG_RUNTIME_DIR values:
  // desktop, CLI, and service entry points may inherit different environments.
  // One fixed, preflighted per-user root keeps the socket boundary unique for
  // every data-directory identity while remaining below sockaddr_un limits.
  const runtimeBaseDirectory = input.platform === "darwin" ? "/private/tmp" : "/tmp";
  const runtimeDirectory = join(runtimeBaseDirectory, `octant-${input.uid}`);
  const identity = createHash("sha256")
    .update("octant.host-runtime.socket.v1\0")
    .update(String(input.uid))
    .update("\0")
    .update(dataDirectory)
    .digest("hex")
    .slice(0, 20);
  const socketPath = join(runtimeDirectory, `${identity}.sock`);
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new HostRuntimePathError(
      "socket-path-too-long",
      "Octant control socket path exceeds the safe platform limit.",
      socketPath,
    );
  }

  return Object.freeze({
    platform: input.platform,
    uid: input.uid,
    dataDirectory,
    configDirectory,
    stateDirectory,
    logsDirectory,
    runtimeDirectory,
    runtimeBaseDirectory,
    runtimeBaseIsExternal: false,
    socketPath,
    ownerReceiptPath: join(dataDirectory, "run", "owner.json"),
    controlSecretPath: join(runtimeDirectory, `${identity}.secret`),
    bridgeSecretPath: join(dataDirectory, "octant-bridge-secret"),
    hostInfoPath: join(dataDirectory, "octant-host.json"),
    servicePolicyPath: join(configDirectory, "service-policy.json"),
    serviceLogPath: join(logsDirectory, "service.log"),
  });
}

function canonicalDataDirectory(
  path: string,
  platform: NodeJS.Platform,
  createWhenMissing: boolean,
): string {
  if (platform !== "darwin" || process.platform !== "darwin") return path;
  try {
    if (createWhenMissing) {
      assertNoExistingSymlinkComponentsSync(path);
      mkdirSync(path, { recursive: true, mode: 0o700 });
    } else {
      lstatSync(path);
    }
    assertNoSymlinkComponentsSync(path);
    return realpathSync.native(path);
  } catch (error) {
    if (isMissing(error)) return path;
    if (error instanceof HostRuntimePathError) throw error;
    throw new HostRuntimePathError(
      "invalid-path",
      `Octant could not canonicalize its data directory: ${safeError(error)}`,
      path,
    );
  }
}

function isCurrentMacHome(home: string): boolean {
  if (process.platform !== "darwin") return false;
  try {
    return realpathSync.native(home) === realpathSync.native(homedir());
  } catch {
    return false;
  }
}

function assertNoExistingSymlinkComponentsSync(path: string): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink()) {
        throw new HostRuntimePathError(
          "unsafe-symlink",
          "Octant refuses paths containing symbolic links.",
          current,
        );
      }
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }
}

function assertNoSymlinkComponentsSync(path: string): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) {
      throw new HostRuntimePathError(
        "unsafe-symlink",
        "Octant refuses paths containing symbolic links.",
        current,
      );
    }
  }
}

export async function prepareHostRuntimePaths(paths: HostRuntimePaths): Promise<void> {
  if (paths.runtimeBaseIsExternal) {
    await assertPrivateDirectory(paths.runtimeBaseDirectory, paths.uid, false);
  }
  const directories = new Set([
    paths.dataDirectory,
    paths.configDirectory,
    paths.stateDirectory,
    paths.logsDirectory,
    paths.runtimeDirectory,
    resolve(paths.ownerReceiptPath, ".."),
  ]);
  for (const directory of directories) {
    await ensurePrivateDirectory(directory, paths.uid);
  }
}

export function deriveHostRuntimeHostId(dataDirectory: string): string {
  const digest = createHash("sha256")
    .update("octant.preview-host.v1\0")
    .update(dataDirectory)
    .digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function optionalAbsolutePath(
  name: string,
  value: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  if (value === undefined) return undefined;
  return requiredAbsolutePath(name, value, platform);
}

function requiredAbsolutePath(name: string, value: string, platform: NodeJS.Platform): string {
  if (value === "" || value.trim() !== value || !isAbsolute(value)) {
    throw new HostRuntimePathError(
      "invalid-path",
      name === "OCTANT_DATA_DIR"
        ? "OCTANT_DATA_DIR must be an absolute path"
        : `${name} must be a non-empty absolute path without surrounding whitespace.`,
      value,
    );
  }
  const absolute = resolve(value);
  if (platform === "darwin") {
    if (absolute === "/tmp") return "/private/tmp";
    if (absolute.startsWith("/tmp/")) return `/private${absolute}`;
    if (absolute === "/var") return "/private/var";
    if (absolute.startsWith("/var/")) return `/private${absolute}`;
  }
  return absolute;
}

async function ensurePrivateDirectory(path: string, uid: number): Promise<void> {
  await assertNoSymlinkComponents(path);
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new HostRuntimePathError(
      "invalid-path",
      `Octant could not create runtime directory: ${safeError(error)}`,
      path,
    );
  }
  await assertNoSymlinkComponents(path);
  await assertPrivateDirectory(path, uid, true);
}

async function assertPrivateDirectory(
  path: string,
  uid: number,
  requireExactMode: boolean,
): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw new HostRuntimePathError(
      "invalid-path",
      `Octant runtime directory is unavailable: ${safeError(error)}`,
      path,
    );
  }
  if (metadata.isSymbolicLink()) {
    throw new HostRuntimePathError("unsafe-symlink", "Octant refuses symlinked paths.", path);
  }
  if (!metadata.isDirectory()) {
    throw new HostRuntimePathError("invalid-path", "Octant expected a directory.", path);
  }
  if (metadata.uid !== uid) {
    throw new HostRuntimePathError(
      "unsafe-owner",
      "Octant runtime paths must be owned by the current user.",
      path,
    );
  }
  const mode = metadata.mode & 0o777;
  if ((requireExactMode && mode !== 0o700) || (!requireExactMode && (mode & 0o077) !== 0)) {
    throw new HostRuntimePathError(
      "unsafe-mode",
      "Octant runtime paths must not be accessible to group or other users.",
      path,
    );
  }
}

async function assertNoSymlinkComponents(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new HostRuntimePathError(
          "unsafe-symlink",
          "Octant refuses paths containing symbolic links.",
          current,
        );
      }
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown filesystem failure";
}
