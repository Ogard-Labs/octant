import type { DesktopIdentity } from "@octant/host-runtime";
import type { DesktopPeerPreflight } from "./desktopPeerStatus";
import { parseCodeDeepLink } from "./codeDeepLinks";

/** Until the typed client bridge exists, the host-owning module must never load in Nightly. */
export async function launchDesktopApplication(
  identity: DesktopIdentity,
  loadHostOwningDesktop: () => Promise<unknown>,
  readStatus?: () => Promise<DesktopPeerPreflight>,
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
        case "not-running":
          message =
            "Open a signed Octant that supports Nightly. Octant may be closed or too old to answer this status check.";
          break;
        case "invalid-scope":
          message = "Octant and Octant Nightly must run in the same macOS login session.";
          break;
        case "deadline-exceeded":
          message =
            "Octant did not finish its status check in time. Open Octant and try Nightly again.";
          break;
        default:
          message =
            "Octant Nightly could not authenticate the matching signed Octant app. A compatible signed release is required.";
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

export const DESKTOP_TERMINAL_SWITCH = "--octant-terminal-cli";

export type PackagedDesktopLaunch =
  | { readonly kind: "desktop" }
  | { readonly kind: "canvas" }
  | { readonly kind: "terminal"; readonly args: ReadonlyArray<string> }
  | { readonly kind: "refused"; readonly message: string };

/** Packaged Nightly never interprets a caller's script path or runtime options. */
export function resolvePackagedDesktopLaunch(
  identity: DesktopIdentity,
  args: ReadonlyArray<string>,
): PackagedDesktopLaunch {
  const refused: PackagedDesktopLaunch = {
    kind: "refused",
    message: `${identity.productName} refused unsupported launch arguments.`,
  };
  if (args.length > 64 || args.some((arg) => arg.length > 16_384 || arg.includes("\0")))
    return refused;
  if (
    identity.flavor === "stable" &&
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
