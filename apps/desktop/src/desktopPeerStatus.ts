import { createRequire } from "node:module";
import { resolve } from "node:path";
import { DESKTOP_PEER_STATUS_FILENAME } from "./runtimePaths";

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
  | "invalid-receipt";

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

/** Only desktop main imports this fixed signed bundle resource. */
export function loadDesktopPeerStatus(input: {
  readonly packaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly resourcesPath: string;
}): NativeDesktopPeerStatus | undefined {
  if (!input.packaged || input.platform !== "darwin") return undefined;
  try {
    const candidate: unknown = createRequire(import.meta.url)(
      resolve(input.resourcesPath, "native", DESKTOP_PEER_STATUS_FILENAME),
    );
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("start" in candidate) ||
      typeof candidate.start !== "function" ||
      !("status" in candidate) ||
      typeof candidate.status !== "function" ||
      ("launchStableHost" in candidate && typeof candidate.launchStableHost !== "function") ||
      !("close" in candidate) ||
      typeof candidate.close !== "function"
    )
      return undefined;
    return candidate as NativeDesktopPeerStatus;
  } catch {
    return undefined;
  }
}
