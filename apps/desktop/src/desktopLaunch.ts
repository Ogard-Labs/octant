import type { DesktopIdentity } from "@octant/host-runtime";
import { parseCodeDeepLink } from "./codeDeepLinks";

/** Until the typed client bridge exists, the host-owning module must never load in Nightly. */
export async function launchDesktopApplication(
  identity: DesktopIdentity,
  loadHostOwningDesktop: () => Promise<unknown>,
): Promise<
  | { readonly kind: "started" }
  | { readonly kind: "client-bridge-required"; readonly message: string }
> {
  if (!identity.mayStartHost) {
    return {
      kind: "client-bridge-required",
      message:
        "Needs a newer Octant. The stable desktop client bridge is not available in this build of Octant Nightly.",
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
