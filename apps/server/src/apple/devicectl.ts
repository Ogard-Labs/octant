import type { AppleDeviceConnection, AppleDeviceToolingOperation } from "@octant/contracts";

/**
 * A paired iPhone or iPad as `xcrun devicectl list devices` reports it, before
 * the host gives it an Octant id. It keeps the CoreDevice identifier the host
 * addresses the device by and nothing else that identifies the hardware: the
 * UDID, serial number, and ECID in the same listing are never read.
 */
export interface DevicectlDevice {
  readonly coreDeviceIdentifier: string;
  readonly name: string;
  readonly model: string;
  readonly osVersion: string;
  readonly connection: AppleDeviceConnection;
  /**
   * What the listing alone says. A `reachable` device still needs its lock
   * state read before the host may call it connected.
   */
  readonly listedState: "reachable" | "untrusted" | "developer-mode-off" | "unavailable";
}

export type DevicectlListing =
  | { readonly kind: "listed"; readonly devices: ReadonlyArray<DevicectlDevice> }
  | { readonly kind: "unreadable" };

export type DevicectlLockState = "locked" | "unlocked" | "unknown";

/** The most devices one listing is read for; a Mac pairs with far fewer. */
const MAX_LISTED_DEVICES = 64;
/** The shape of a CoreDevice identifier the host will address a device by. */
export const CORE_DEVICE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Control, line-separator, and bidirectional-formatting characters, which
// would let a device name break the confirmation that names it into lines of
// its own or reorder and hide its words.
function isUnsafeNameCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Reads the `--json-output` document of `devicectl list devices`. Only
 * physical iPhones and iPads are destinations; every other paired device is
 * left out. A document that is not a successful listing is unreadable, never
 * an empty list, so a failed listing does not look like unplugged devices.
 */
export function parseDevicectlDeviceList(document: unknown): DevicectlListing {
  if (!isRecord(document) || !isRecord(document.info) || document.info.outcome !== "success") {
    return { kind: "unreadable" };
  }
  const result = document.result;
  if (!isRecord(result) || !Array.isArray(result.devices)) return { kind: "unreadable" };
  const devices: DevicectlDevice[] = [];
  for (const entry of result.devices.slice(0, MAX_LISTED_DEVICES)) {
    const device = destination(entry);
    if (device !== undefined) devices.push(device);
  }
  return { kind: "listed", devices };
}

function destination(entry: unknown): DevicectlDevice | undefined {
  if (!isRecord(entry)) return undefined;
  const hardware = isRecord(entry.hardwareProperties) ? entry.hardwareProperties : {};
  const properties = isRecord(entry.deviceProperties) ? entry.deviceProperties : {};
  const connection = isRecord(entry.connectionProperties) ? entry.connectionProperties : {};
  const deviceType = hardware.deviceType;
  if (deviceType !== "iPhone" && deviceType !== "iPad") return undefined;
  if (hardware.reality !== undefined && hardware.reality !== "physical") return undefined;
  const identifier = entry.identifier;
  if (typeof identifier !== "string" || !CORE_DEVICE_IDENTIFIER.test(identifier)) return undefined;
  const model = boundedText(hardware.marketingName, 128) ?? deviceType;
  return {
    coreDeviceIdentifier: identifier,
    name: boundedText(properties.name, 256) ?? model,
    model,
    osVersion: boundedText(properties.osVersionNumber, 64) ?? "Unknown",
    // A paired device that is not on a cable is reached over the network.
    connection: connection.transportType === "wired" ? "wired" : "network",
    listedState: listedState(connection, properties),
  };
}

function listedState(
  connection: Readonly<Record<string, unknown>>,
  properties: Readonly<Record<string, unknown>>,
): DevicectlDevice["listedState"] {
  const transport = connection.transportType;
  if (
    connection.tunnelState === "unavailable" ||
    (transport !== "wired" && transport !== "localNetwork")
  ) {
    return "unavailable";
  }
  if (connection.pairingState !== "paired") return "untrusted";
  // Only a status that says enabled counts: a device that does not report
  // one cannot be shown to accept a development build.
  if (properties.developerModeStatus !== "enabled") return "developer-mode-off";
  return "reachable";
}

/**
 * Reads the `--json-output` document of `devicectl device info lockState`. An
 * answer that does not say whether a passcode is needed is `unknown`, which
 * the host reports as unavailable rather than guessing the device is open.
 */
export function parseDevicectlLockState(document: unknown): DevicectlLockState {
  if (!isRecord(document) || !isRecord(document.info) || document.info.outcome !== "success") {
    return "unknown";
  }
  const result = document.result;
  if (!isRecord(result)) return "unknown";
  if (result.passcodeRequired === true) return "locked";
  if (result.passcodeRequired === false) return "unlocked";
  return "unknown";
}

/**
 * One `devicectl` subcommand the host probes for. `lock-state` is the host's
 * own read of whether a device is locked; it is not an operation a request
 * can name.
 */
export interface DevicectlProbe {
  readonly operation: AppleDeviceToolingOperation | "lock-state";
  readonly subcommand: ReadonlyArray<string>;
  /**
   * Text the help must also contain: the flag an operation is, or the option
   * the host passes it.
   */
  readonly requires?: string;
}

export const DEVICECTL_PROBES: ReadonlyArray<DevicectlProbe> = [
  { operation: "list-devices", subcommand: ["list", "devices"] },
  { operation: "install-app", subcommand: ["device", "install", "app"] },
  { operation: "launch-app", subcommand: ["device", "process", "launch"] },
  { operation: "terminate-process", subcommand: ["device", "process", "terminate"] },
  { operation: "uninstall-app", subcommand: ["device", "uninstall", "app"] },
  // A capture is written where the host says, so a help that does not take
  // that option cannot be driven the way the host drives it.
  { operation: "screenshot", subcommand: ["device", "screenshot"], requires: "--destination" },
  {
    operation: "console-logs",
    subcommand: ["device", "process", "launch"],
    requires: "--console",
  },
  { operation: "lock-state", subcommand: ["device", "info", "lockState"] },
];

/**
 * Whether a subcommand's `--help` shows the selected Xcode offers it. The help
 * must name that exact subcommand on its usage line: an argument parser that
 * does not know a subcommand can fall back to its parent's help and still
 * exit cleanly, which must not read as the operation being there.
 */
export function devicectlOffers(
  probe: DevicectlProbe,
  help: { readonly exitCode: number | null; readonly output: string },
): boolean {
  if (help.exitCode !== 0) return false;
  const usage = new RegExp(
    `USAGE:\\s*\\S*devicectl\\s+${probe.subcommand.map(escapeRegExp).join("\\s+")}(\\s|$)`,
  );
  if (!usage.test(help.output)) return false;
  return probe.requires === undefined || help.output.includes(probe.requires);
}

/**
 * What a `devicectl` subcommand's `--json-output` says happened. A failure
 * keeps only CoreDevice's error domain and code: the error's own words can
 * name the device by its UDID, serial number, or ECID, which never leave the
 * host.
 */
export type DevicectlOutcome =
  | { readonly kind: "succeeded"; readonly result: Readonly<Record<string, unknown>> }
  | { readonly kind: "failed"; readonly reason: string };

export function parseDevicectlOutcome(document: unknown): DevicectlOutcome {
  if (isRecord(document) && isRecord(document.info) && document.info.outcome === "success") {
    return { kind: "succeeded", result: isRecord(document.result) ? document.result : {} };
  }
  const error = isRecord(document) && isRecord(document.error) ? document.error : {};
  const domain =
    typeof error.domain === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(error.domain)
      ? error.domain
      : undefined;
  const code = typeof error.code === "number" && Number.isSafeInteger(error.code) ? error.code : 0;
  return {
    kind: "failed",
    reason: domain === undefined ? "no readable answer" : `${domain} ${code}`,
  };
}

/**
 * The bundle identifier `devicectl device install app` reports it installed.
 * The installation URL beside it names a per-install container and is not kept.
 */
export function parseDevicectlInstalledBundle(
  result: Readonly<Record<string, unknown>>,
): string | undefined {
  const installed = result.installedApplications;
  if (!Array.isArray(installed) || installed.length !== 1) return undefined;
  const [application] = installed;
  return isRecord(application) && typeof application.bundleID === "string"
    ? application.bundleID
    : undefined;
}

/**
 * Device-layer output kept as evidence, with every token shaped like a
 * hardware or CoreDevice identifier replaced: a UDID in either form, a UUID,
 * and an ECID. The device's serial number has no shape of its own, which is
 * why `devicectl`'s own words are never kept and only build output and the
 * app's console pass through here.
 */
export function withoutDeviceIdentifiers(text: string): string {
  return text
    .replace(
      /\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/g,
      "[ID]",
    )
    .replace(/\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}\b/g, "[ID]")
    .replace(/\b[0-9A-Fa-f]{40}\b/g, "[ID]")
    .replace(/\bECID\b\s*[:=]?\s*(?:0x[0-9A-Fa-f]+|\d+)/gi, "ECID [ID]");
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = Array.from(value, (character) =>
    isUnsafeNameCharacter(character) ? " " : character,
  )
    .join("")
    .trim()
    .slice(0, maximum)
    .trim();
  return text.length === 0 ? undefined : text;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
