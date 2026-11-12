import type { DesktopHostRole, DesktopIdentity } from "@octant/host-runtime";
import type { DesktopPeerPreflight } from "./desktopPeerStatus";
import { parseCodeDeepLink } from "./codeDeepLinks";

/** Until the typed client bridge exists, the host-owning module must never load in Nightly. */
export async function launchDesktopApplication(
  identity: DesktopIdentity,
  loadHostOwningDesktop: () => Promise<unknown>,
  readStatus?: () => Promise<DesktopPeerPreflight>,
  openClient?: () => Promise<
    { readonly kind: "started" } | { readonly kind: "refused"; readonly message: string }
  >,
): Promise<
  | { readonly kind: "started" }
  | { readonly kind: "client-bridge-required"; readonly message: string }
> {
  if (!identity.mayStartHost) {
    let status: DesktopPeerPreflight | undefined;
    try {
      status = await readStatus?.();
    } catch {
      status = { kind: "refused", reason: "native-unavailable" };
    }
    if (status?.kind === "ready" && openClient !== undefined) {
      try {
        const client = await openClient();
        if (client.kind === "started") return client;
        return { kind: "client-bridge-required", message: client.message };
      } catch {
        return {
          kind: "client-bridge-required",
          message: "Octant Nightly could not register its window with Octant.",
        };
      }
    }
    let message =
      "Needs a newer Octant. The stable desktop client bridge is not available in this build of Octant Nightly.";
    if (status?.kind === "ready")
      message = `Octant ${status.version} authenticated this status check. The desktop client bridge is not available in this build of Octant Nightly.`;
    else if (status?.kind === "refused") {
      switch (status.reason) {
        case "unsigned-build":
          message =
            "This development build cannot connect to Octant. A signed release build is required.";
          break;
        case "incompatible-host":
          message =
            "Needs a newer Octant. The installed app does not support this Nightly connection or host-only launch.";
          break;
        case "not-installed":
          message =
            "Install Octant before opening Octant Nightly. Nightly uses Octant's host and never starts its own.";
          break;
        case "not-running":
          message =
            "Open Octant that supports Nightly. Octant may be closed or too old to answer this status check.";
          break;
        case "invalid-scope":
          message =
            "Octant and Octant Nightly must run as the same person in the same login session, outside any container or app sandbox.";
          break;
        case "no-launcher-record":
          message = "Open Octant, then try again.";
          break;
        case "unsandboxed-renderer":
          message =
            "Octant Nightly connects to Octant only while Chromium's sandbox protects its windows. Start it without --no-sandbox or ELECTRON_DISABLE_SANDBOX.";
          break;
        case "deadline-exceeded":
          message =
            "Octant did not finish its status check in time. Open Octant and try Nightly again.";
          break;
        default:
          message =
            "Octant Nightly could not authenticate the matching Octant app. Open a compatible Octant and try again.";
      }
    }
    return {
      kind: "client-bridge-required",
      message,
    };
  }
  await loadHostOwningDesktop();
  return { kind: "started" };
}

export const DESKTOP_HOST_ONLY_SWITCH = "--octant-host-only";

/**
 * Added by the per-user background service to its host-only launch. A Nightly
 * client's host-only launch stops once no Nightly window is left; the service's
 * host has no client to wait for and runs until an explicit quit, so it must
 * not inherit that grace.
 */
export const DESKTOP_BACKGROUND_SERVICE_SWITCH = "--octant-background-service";

export const DESKTOP_TERMINAL_SWITCH = "--octant-terminal-cli";

export type PackagedDesktopLaunch =
  | { readonly kind: "desktop" }
  | { readonly kind: "host-only"; readonly backgroundService?: true }
  | { readonly kind: "canvas" }
  | { readonly kind: "terminal"; readonly args: ReadonlyArray<string> }
  | { readonly kind: "refused"; readonly message: string };

/**
 * The Chromium features a Linux desktop may name in `--enable-features` or
 * `--disable-features`: Wayland windowing, text input and fractional scaling,
 * and hardware video decoding. Nothing here weakens a sandbox or opens a
 * debugging or loader path.
 */
export const LINUX_DISPLAY_FEATURES = [
  "UseOzonePlatform",
  "WaylandWindowDecorations",
  "WaylandTextInputV3",
  "WaylandFractionalScaleV1",
  "VaapiVideoDecoder",
] as const;

const OZONE_PLATFORMS = new Set(["wayland", "x11", "auto"]);

/**
 * One closed display flag a Linux desktop entry or launcher may add, by its
 * exact name and a small set of values. `--use-gl` is not listed: current
 * Chromium chooses GL through ANGLE, and its values could not be confirmed
 * for the pinned Electron.
 */
function linuxDisplayFlagName(arg: string): string | undefined {
  const [name, ...rest] = arg.split("=");
  const value = rest.length === 0 ? undefined : rest.join("=");
  switch (name) {
    case "--ozone-platform":
    case "--ozone-platform-hint":
      return value !== undefined && OZONE_PLATFORMS.has(value) ? name : undefined;
    case "--enable-features":
    case "--disable-features": {
      if (value === undefined || value === "") return undefined;
      const features = value.split(",");
      return new Set(features).size === features.length &&
        features.every((feature) =>
          (LINUX_DISPLAY_FEATURES as ReadonlyArray<string>).includes(feature),
        )
        ? name
        : undefined;
    }
    case "--wayland-text-input-version":
      return value === "1" || value === "3" ? name : undefined;
    case "--force-device-scale-factor": {
      if (value === undefined || !/^[0-9](?:\.[0-9]{1,3})?$/.test(value)) return undefined;
      const factor = Number(value);
      return factor > 0 && factor <= 4 ? name : undefined;
    }
    case "--enable-wayland-ime":
    case "--disable-gpu":
    case "--disable-gpu-compositing":
      return value === undefined ? name : undefined;
    default:
      return undefined;
  }
}

/**
 * Splits a Linux launch into its closed display flags and the rest, each
 * flag at most once. Undefined when a display-like flag is malformed or
 * repeated; anything unknown stays in the rest and refuses there.
 */
export function separateLinuxDisplayFlags(
  args: ReadonlyArray<string>,
): ReadonlyArray<string> | undefined {
  const seen = new Set<string>();
  const rest: string[] = [];
  for (const arg of args) {
    const name = linuxDisplayFlagName(arg);
    if (name === undefined) {
      rest.push(arg);
      continue;
    }
    if (seen.has(name)) return undefined;
    seen.add(name);
  }
  return rest;
}

/** Packaged Nightly never interprets a caller's script path or runtime options. */
export function resolvePackagedDesktopLaunch(
  identity: DesktopIdentity,
  launchArgs: ReadonlyArray<string>,
  /** Nightly's role from its stored Data choice; Octant's is always its own host. */
  hostRole: DesktopHostRole = { kind: "octant-host" },
  platform: NodeJS.Platform = process.platform,
): PackagedDesktopLaunch {
  const refused: PackagedDesktopLaunch = {
    kind: "refused",
    message: `${identity.productName} refused unsupported launch arguments.`,
  };
  if (launchArgs.length > 64 || launchArgs.some((arg) => arg.length > 16_384 || arg.includes("\0")))
    return refused;
  // Linux desktops may add display flags to the launch; nothing else passes.
  const separated = platform === "linux" ? separateLinuxDisplayFlags(launchArgs) : launchArgs;
  if (separated === undefined) return refused;
  const args = separated;
  if (
    identity.flavor === "stable" &&
    args.includes(DESKTOP_HOST_ONLY_SWITCH) &&
    args.filter((arg) => arg === DESKTOP_HOST_ONLY_SWITCH).length === 1 &&
    args.filter((arg) => arg === DESKTOP_BACKGROUND_SERVICE_SWITCH).length <= 1 &&
    args.filter((arg) => /^-psn_[0-9]+_[0-9]+$/.test(arg)).length <= 1 &&
    args.every(
      (arg) =>
        arg === DESKTOP_HOST_ONLY_SWITCH ||
        arg === DESKTOP_BACKGROUND_SERVICE_SWITCH ||
        /^-psn_[0-9]+_[0-9]+$/.test(arg),
    )
  )
    return args.includes(DESKTOP_BACKGROUND_SERVICE_SWITCH)
      ? { kind: "host-only", backgroundService: true }
      : { kind: "host-only" };
  // The Canvas prototype host is a child the host-owning desktop starts. Nightly
  // runs that desktop only as its own test host, never as a client of Octant.
  if (
    (identity.flavor === "stable" || hostRole.kind === "test-host") &&
    args.length === 1 &&
    args[0] === "--octant-canvas-prototype-host"
  )
    return { kind: "canvas" };
  if (args[0] === DESKTOP_TERMINAL_SWITCH) {
    const terminalArgs = args.slice(1);
    if (
      (terminalArgs.length === 1 && terminalArgs[0] === "--help") ||
      (terminalArgs[0] === "mcp" &&
        (terminalArgs.length === 1 || (terminalArgs.length === 2 && terminalArgs[1] === "--help")))
    ) {
      return { kind: "terminal", args: terminalArgs };
    }
    return refused;
  }
  let launchServicesToken = false;
  let deepLink = false;
  for (const arg of args) {
    if (!launchServicesToken && /^-psn_[0-9]+_[0-9]+$/.test(arg)) {
      launchServicesToken = true;
      continue;
    }
    if (deepLink) return refused;
    try {
      parseCodeDeepLink(arg, identity.scheme);
      deepLink = true;
    } catch {
      return refused;
    }
  }
  return { kind: "desktop" };
}
