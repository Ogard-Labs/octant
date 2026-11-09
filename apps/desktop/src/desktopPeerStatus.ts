import { randomUUID } from "node:crypto";
import { lstat, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  DESKTOP_PEER_LINUX_FILENAME,
  DESKTOP_PEER_STATUS_FILENAME,
  DESKTOP_PEER_WINDOWS_FILENAME,
} from "./runtimePaths";

export type DesktopPeerRefusal =
  | "unsigned-build"
  | "invalid-peer"
  | "invalid-scope"
  | "unsupported-platform"
  | "not-running"
  | "not-installed"
  | "incompatible-host"
  | "deadline-exceeded"
  | "native-unavailable"
  | "invalid-receipt"
  /** Linux: no packaged Octant launch has recorded the AppImage to start. */
  | "no-launcher-record"
  /** Linux: Nightly's renderers would run without Chromium's sandbox. */
  | "unsandboxed-renderer";

export type DesktopPeerPreflight =
  | { readonly kind: "ready"; readonly protocol: 1; readonly version: string }
  | { readonly kind: "refused"; readonly reason: DesktopPeerRefusal };

export type DesktopPeerStart =
  | { readonly kind: "started" }
  | { readonly kind: "refused"; readonly reason: DesktopPeerRefusal };

export type DesktopPeerClose =
  | { readonly kind: "closed" }
  | { readonly kind: "failed"; readonly reason: "deadline-exceeded" | "native-unavailable" };

export interface NativeDesktopPeerStatus {
  readonly start: () => Promise<unknown>;
  readonly status: () => Promise<unknown>;
  readonly launchStableHost?: () => Promise<unknown>;
  /** Stable only: check a Nightly bundle at an exact path against Nightly's requirement. */
  readonly verifyNightly?: (path: string) => Promise<unknown>;
  /** Stable only: check that bundle again, then open it through Launch Services. */
  readonly openNightly?: (path: string) => Promise<unknown>;
  /** Stable only: whether an app with Nightly's bundle id is running. */
  readonly nightlyRunning?: () => Promise<unknown>;
  readonly close: () => Promise<unknown>;
}

function refusal(value: unknown): DesktopPeerRefusal | undefined {
  switch (value) {
    case "unsigned-build":
    case "invalid-peer":
    case "invalid-scope":
    case "unsupported-platform":
    case "not-running":
    case "not-installed":
    case "incompatible-host":
    case "deadline-exceeded":
    case "native-unavailable":
    case "invalid-receipt":
    case "no-launcher-record":
    case "unsandboxed-renderer":
      return value;
    default:
      return undefined;
  }
}

function refused(value: unknown): {
  readonly kind: "refused";
  readonly reason: DesktopPeerRefusal;
} {
  const reason =
    typeof value === "object" && value !== null && "reason" in value
      ? refusal(value.reason)
      : undefined;
  return { kind: "refused", reason: reason ?? "invalid-receipt" };
}

// The native worker checks its own deadline around Security/filesystem work.
// This bound also prevents a late result from changing the startup decision.
export async function boundedDesktopPeerOperation(
  operation: () => Promise<unknown>,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<unknown>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "refused", reason: "deadline-exceeded" }), 3_000);
      }),
    ]);
  } catch {
    return { kind: "refused", reason: "native-unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

export async function desktopPeerPreflight(
  native: Pick<NativeDesktopPeerStatus, "status">,
): Promise<DesktopPeerPreflight> {
  const value = await boundedDesktopPeerOperation(() => native.status());
  if (typeof value !== "object" || value === null || !("kind" in value)) return refused(value);
  if (value.kind === "refused") return refused(value);
  if (
    value.kind === "ready" &&
    "protocol" in value &&
    value.protocol === 1 &&
    "version" in value &&
    typeof value.version === "string" &&
    value.version.length <= 64 &&
    /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?$/.test(value.version)
  )
    return { kind: "ready", protocol: 1, version: value.version };
  return refused(undefined);
}

/** A launch receipt never replaces mutual authentication of the running host. */
export async function ensureNightlyHostReady(
  native: Pick<NativeDesktopPeerStatus, "status" | "launchStableHost">,
): Promise<DesktopPeerPreflight> {
  const initial = await desktopPeerPreflight(native);
  if (initial.kind !== "refused" || initial.reason !== "not-running") return initial;
  const launch = native.launchStableHost;
  if (launch === undefined) return { kind: "refused", reason: "incompatible-host" };
  const launched = await boundedDesktopPeerOperation(() => launch.call(native));
  if (
    typeof launched !== "object" ||
    launched === null ||
    !("kind" in launched) ||
    launched.kind !== "started"
  )
    return refused(launched);
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const current = await desktopPeerPreflight(native);
    if (performance.now() >= deadline) break;
    if (current.kind !== "refused" || current.reason !== "not-running") return current;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(250, Math.max(0, deadline - performance.now()))),
    );
  }
  return { kind: "refused", reason: "deadline-exceeded" };
}

export function ownDesktopPeerStatus(native: Pick<NativeDesktopPeerStatus, "start" | "close">): {
  readonly ready: Promise<DesktopPeerStart>;
  readonly close: () => Promise<DesktopPeerClose>;
} {
  const ready = boundedDesktopPeerOperation(() => native.start()).then(
    (value): DesktopPeerStart =>
      typeof value === "object" && value !== null && "kind" in value && value.kind === "started"
        ? { kind: "started" }
        : refused(value),
  );
  let closing: Promise<DesktopPeerClose> | undefined;
  return {
    ready,
    close: () => {
      closing ??= (async () => {
        await ready;
        // Always close, including a refused/expired acquisition: native close
        // revokes any acquisition that finishes after the startup deadline.
        return await closeDesktopPeerStatus(native);
      })();
      return closing;
    },
  };
}

export async function closeDesktopPeerStatus(
  native: Pick<NativeDesktopPeerStatus, "close">,
): Promise<DesktopPeerClose> {
  const value = await boundedDesktopPeerOperation(() => native.close());
  if (typeof value === "object" && value !== null && "kind" in value) {
    if (value.kind === "closed") return { kind: "closed" };
    if ("reason" in value && value.reason === "deadline-exceeded")
      return { kind: "failed", reason: "deadline-exceeded" };
  }
  return { kind: "failed", reason: "native-unavailable" };
}

/**
 * Linux only: where the binding listens or connects and the version a status
 * reply names. Both come from Octant's own host paths and package manifest,
 * never from a renderer or an environment variable.
 */
export interface LinuxDesktopPeerEndpoint {
  readonly windowsSocketPath: string;
  readonly launcherRecordPath: string;
  readonly version: string;
}

/**
 * Chromium's renderer sandbox is part of Linux client trust: a Nightly whose
 * renderers run unsandboxed registers no window with Octant.
 */
export function linuxRendererSandboxDisabled(input: {
  readonly hasSwitch: (name: string) => boolean;
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}): boolean {
  return (
    input.hasSwitch("no-sandbox") ||
    input.hasSwitch("disable-setuid-sandbox") ||
    input.argv.some((argument) => argument === "--no-sandbox") ||
    // Presence alone counts, empty included: refusing is the safe reading.
    input.env.ELECTRON_DISABLE_SANDBOX !== undefined
  );
}

export interface WindowsDesktopPeerEndpoint {
  /** The native private profile supplies its UUID; paths never identify peers. */
  readonly profileId: string;
  readonly version: string;
}

/** Only desktop main imports this fixed bundle resource. */
export function loadDesktopPeerStatus(input: {
  readonly packaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly resourcesPath: string;
  /** Required on Linux; a Linux load without it is unavailable. */
  readonly linux?: LinuxDesktopPeerEndpoint;
  readonly windows?: WindowsDesktopPeerEndpoint;
}): NativeDesktopPeerStatus | undefined {
  if (!input.packaged) return undefined;
  if (
    input.platform !== "darwin" &&
    !(input.platform === "linux" && input.linux !== undefined) &&
    !(input.platform === "win32" && input.windows !== undefined)
  )
    return undefined;
  try {
    const candidate: unknown = createRequire(import.meta.url)(
      resolve(
        input.resourcesPath,
        "native",
        input.platform === "darwin"
          ? DESKTOP_PEER_STATUS_FILENAME
          : input.platform === "win32"
            ? DESKTOP_PEER_WINDOWS_FILENAME
            : DESKTOP_PEER_LINUX_FILENAME,
      ),
    );
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("start" in candidate) ||
      typeof candidate.start !== "function" ||
      !("status" in candidate) ||
      typeof candidate.status !== "function" ||
      ("launchStableHost" in candidate && typeof candidate.launchStableHost !== "function") ||
      ("verifyNightly" in candidate && typeof candidate.verifyNightly !== "function") ||
      ("openNightly" in candidate && typeof candidate.openNightly !== "function") ||
      ("nightlyRunning" in candidate && typeof candidate.nightlyRunning !== "function") ||
      !("close" in candidate) ||
      typeof candidate.close !== "function"
    )
      return undefined;
    if (input.platform === "linux") {
      const endpoint = input.linux;
      // The binding accepts one endpoint per process and refuses a path
      // outside a private folder the person owns.
      if (
        endpoint === undefined ||
        !("bindEndpoint" in candidate) ||
        typeof candidate.bindEndpoint !== "function" ||
        candidate.bindEndpoint(
          endpoint.windowsSocketPath,
          endpoint.launcherRecordPath,
          endpoint.version,
        ) !== true
      )
        return undefined;
    }
    if (input.platform === "win32") {
      const endpoint = input.windows;
      if (
        endpoint === undefined ||
        !("bindEndpoint" in candidate) ||
        typeof candidate.bindEndpoint !== "function" ||
        candidate.bindEndpoint(endpoint.profileId, endpoint.version) !== true
      )
        return undefined;
    }
    return candidate as NativeDesktopPeerStatus;
  } catch {
    return undefined;
  }
}

/**
 * The one line a Linux Nightly reads to start a closed Octant: the AppImage
 * this packaged Octant launched from, with the device and inode it had. The
 * native binding refuses any other shape, so the field order is fixed.
 */
export function encodeLinuxLauncherRecord(input: {
  readonly appImage: string;
  readonly device: bigint;
  readonly inode: bigint;
}): string {
  return `{"schemaVersion":1,"appImage":${JSON.stringify(input.appImage)},"device":"${input.device}","inode":"${input.inode}"}\n`;
}

/**
 * Writes the launcher record for a packaged Linux Octant started from an
 * AppImage. Only an absolute path to a regular file is recorded; anything
 * else leaves no record, and Nightly then asks the person to open Octant.
 */
export async function writeLinuxLauncherRecord(input: {
  readonly recordPath: string;
  readonly appImage: string | undefined;
}): Promise<"written" | "skipped"> {
  const appImage = input.appImage;
  if (appImage === undefined || !isAbsolute(appImage) || appImage.includes("\0")) return "skipped";
  const metadata = await lstat(appImage, { bigint: true }).catch(() => undefined);
  if (metadata === undefined || !metadata.isFile()) return "skipped";
  const temporary = join(dirname(input.recordPath), `.launcher-${randomUUID()}.json`);
  try {
    await writeFile(
      temporary,
      encodeLinuxLauncherRecord({ appImage, device: metadata.dev, inode: metadata.ino }),
      { mode: 0o600, flag: "wx" },
    );
    await rename(temporary, input.recordPath);
    return "written";
  } finally {
    await rm(temporary, { force: true });
  }
}
