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

export const NIGHTLY_TERMINAL_SWITCH = "--octant-terminal-cli";

export type NightlyLaunch =
  | { readonly kind: "desktop" }
  | { readonly kind: "terminal"; readonly args: ReadonlyArray<string> }
  | { readonly kind: "refused"; readonly message: string };

/** Packaged Nightly never interprets a caller's script path or runtime options. */
export function resolveNightlyLaunch(args: ReadonlyArray<string>): NightlyLaunch {
  const refused: NightlyLaunch = {
    kind: "refused",
    message: "Octant Nightly refused unsupported launch arguments.",
  };
  if (args.length > 64 || args.some((arg) => arg.length > 16_384 || arg.includes("\0")))
    return refused;
  if (args[0] === NIGHTLY_TERMINAL_SWITCH) {
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
      parseCodeDeepLink(arg, "octant-nightly");
      deepLink = true;
    } catch {
      return refused;
    }
  }
  return { kind: "desktop" };
}
