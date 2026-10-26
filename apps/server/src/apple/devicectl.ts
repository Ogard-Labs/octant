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
// Control and bidirectional-override characters, which would let a device
// name reorder or hide the words of the confirmation that names it.
function isUnsafeNameCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
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
  /** Text the help must also contain, for an operation that is a flag of another. */
  readonly requires?: string;
}

export const DEVICECTL_PROBES: ReadonlyArray<DevicectlProbe> = [
  { operation: "list-devices", subcommand: ["list", "devices"] },
  { operation: "install-app", subcommand: ["device", "install", "app"] },
  { operation: "launch-app", subcommand: ["device", "process", "launch"] },
  { operation: "terminate-process", subcommand: ["device", "process", "terminate"] },
  { operation: "uninstall-app", subcommand: ["device", "uninstall", "app"] },
  { operation: "screenshot", subcommand: ["device", "screenshot"] },
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
