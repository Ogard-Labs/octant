import { createRequire } from "node:module";
import { resolve } from "node:path";
import { NIGHTLY_INSTALLATION_FILENAME } from "./runtimePaths";

export const MAX_NIGHTLY_INSTALLATION_ARCHIVE_BYTES = 512 * 1024 * 1024;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?$/;

export type NightlyInstallationRefusalReason =
  | "unsupported-platform"
  | "unsigned-build"
  | "invalid-peer"
  | "native-unavailable"
  | "invalid-artifact"
  | "incompatible-build"
  | "not-installed"
  | "already-installed"
  | "running"
  | "ambiguous-application"
  | "unwritable-location"
  | "busy"
  | "cancelled"
  | "deadline-exceeded"
  | "closed";
export type NightlyInstallationRefusal = {
  readonly kind: "refused";
  readonly reason: NightlyInstallationRefusalReason;
};
export type InstalledNightly = {
  readonly kind: "installed";
  readonly version: string;
  readonly running: boolean;
};
export type NightlyInstallationInspection =
  | { readonly kind: "absent" }
  | InstalledNightly
  | NightlyInstallationRefusal;
export type FailedNightlyInstallationClose = {
  readonly kind: "failed";
  readonly reason: "deadline-exceeded" | "native-unavailable";
};
export interface NativeNightlyInstallation {
  readonly inspect: () => Promise<NightlyInstallationInspection>;
  readonly prepareInstall: (
    bytes: Uint8Array,
    version: string,
  ) => Promise<{ readonly kind: "prepared" } | NightlyInstallationRefusal>;
  readonly commitInstall: () => Promise<InstalledNightly | NightlyInstallationRefusal>;
  readonly open: () => Promise<{ readonly kind: "opened" } | NightlyInstallationRefusal>;
  readonly remove: () => Promise<{ readonly kind: "removed" } | NightlyInstallationRefusal>;
  readonly cancel: () => Promise<{ readonly kind: "cancelled" } | FailedNightlyInstallationClose>;
  readonly close: () => Promise<{ readonly kind: "closed" } | FailedNightlyInstallationClose>;
}
interface NativeBinding {
  readonly inspect: () => Promise<unknown>;
  readonly prepareInstall: (bytes: Uint8Array, version: string) => Promise<unknown>;
  readonly commitInstall: () => Promise<unknown>;
  readonly open: () => Promise<unknown>;
  readonly remove: () => Promise<unknown>;
  readonly cancel: () => Promise<unknown>;
  readonly close: () => Promise<unknown>;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function refusal(value: unknown): NightlyInstallationRefusal {
  const record = object(value);
  switch (record?.reason) {
    case "unsupported-platform":
    case "unsigned-build":
    case "invalid-peer":
    case "native-unavailable":
    case "invalid-artifact":
    case "incompatible-build":
    case "not-installed":
    case "already-installed":
    case "running":
    case "ambiguous-application":
    case "unwritable-location":
    case "busy":
    case "cancelled":
    case "deadline-exceeded":
    case "closed":
      return { kind: "refused", reason: record.reason };
    default:
      return { kind: "refused", reason: "native-unavailable" };
  }
}
function installed(value: unknown): InstalledNightly | undefined {
  const record = object(value);
  return record?.kind === "installed" &&
    typeof record.version === "string" &&
    record.version.length <= 64 &&
    VERSION.test(record.version) &&
    typeof record.running === "boolean"
    ? { kind: "installed", version: record.version, running: record.running }
    : undefined;
}
async function read(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch {
    return undefined;
  }
}

/** Native owns deadlines and actual completion; no JS timeout can invent drained work. */
export function ownNightlyInstallationNative(raw: NativeBinding): NativeNightlyInstallation {
  let closed = false;
  let closing: Promise<{ readonly kind: "closed" } | FailedNightlyInstallationClose> | undefined;
  const admitted = async (operation: () => Promise<unknown>) =>
    closed ? { kind: "refused", reason: "closed" } : read(operation);
  const single = async <K extends "prepared" | "opened" | "removed">(
    kind: K,
    operation: () => Promise<unknown>,
  ): Promise<{ readonly kind: K } | NightlyInstallationRefusal> => {
    const value = await admitted(operation);
    return object(value)?.kind === kind ? { kind } : refusal(value);
  };
  const cleanup = async <K extends "closed" | "cancelled">(
    kind: K,
    operation: () => Promise<unknown>,
  ): Promise<{ readonly kind: K } | FailedNightlyInstallationClose> => {
    const value = await read(operation);
    return object(value)?.kind === kind
      ? { kind }
      : {
          kind: "failed",
          reason:
            object(value)?.reason === "deadline-exceeded"
              ? "deadline-exceeded"
              : "native-unavailable",
        };
  };
  return {
    inspect: async () => {
      const value = await admitted(() => raw.inspect());
      return object(value)?.kind === "absent"
        ? { kind: "absent" }
        : (installed(value) ?? refusal(value));
    },
    prepareInstall: async (bytes, version) => {
      if (
        bytes.byteLength === 0 ||
        bytes.byteLength > MAX_NIGHTLY_INSTALLATION_ARCHIVE_BYTES ||
        version.length > 64 ||
        !VERSION.test(version)
      )
        return { kind: "refused", reason: "invalid-artifact" };
      return single("prepared", () => raw.prepareInstall(bytes, version));
    },
    commitInstall: async () => {
      const value = await admitted(() => raw.commitInstall());
      return installed(value) ?? refusal(value);
    },
    open: () => single("opened", () => raw.open()),
    remove: () => single("removed", () => raw.remove()),
    cancel: () => cleanup("cancelled", () => raw.cancel()),
    close: () => {
      closed = true;
      closing ??= cleanup("closed", () => raw.close());
      return closing;
    },
  };
}

/** The resource path is host-owned; native independently proves signed Stable main. */
export function loadNightlyInstallationNative(): NativeNightlyInstallation {
  const reason = process.platform !== "darwin" ? "unsupported-platform" : "native-unavailable";
  if (process.platform === "darwin" && typeof process.resourcesPath === "string") {
    try {
      const candidate: unknown = createRequire(import.meta.url)(
        resolve(process.resourcesPath, "native", NIGHTLY_INSTALLATION_FILENAME),
      );
      const record = object(candidate);
      if (
        record !== undefined &&
        ["inspect", "prepareInstall", "commitInstall", "open", "remove", "cancel", "close"].every(
          (key) => typeof record[key] === "function",
        )
      )
        return ownNightlyInstallationNative(candidate as NativeBinding);
    } catch {
      /* Missing or incompatible native code supplies no installation authority. */
    }
  }
  return ownNightlyInstallationNative({
    inspect: async () => ({ kind: "refused", reason }),
    prepareInstall: async () => ({ kind: "refused", reason }),
    commitInstall: async () => ({ kind: "refused", reason }),
    open: async () => ({ kind: "refused", reason }),
    remove: async () => ({ kind: "refused", reason }),
    cancel: async () => ({ kind: "cancelled" }),
    close: async () => ({ kind: "closed" }),
  });
}
