import type { HostPlatform } from "@octant/contracts/host";
import { hostComputerName } from "@octant/domain";
import { createContext, useContext } from "react";

/**
 * The platform fields this renderer reads, typed structurally rather than taken
 * from `Navigator`: `userAgentData` is not in the DOM lib, and a plain object
 * lets a caller state the platform it means instead of mutating a global.
 */
export interface PlatformNavigator {
  readonly userAgentData?: { readonly platform?: string | undefined } | undefined;
  readonly platform?: string | undefined;
}

/**
 * Report whether this renderer runs on Apple hardware.
 *
 * Keyboard chords are why this exists. On macOS the `Ctrl` chords belong to
 * Cocoa text editing — `Ctrl+K` deletes to the end of the line in every text
 * field — so an app surface that claims one takes an editing command away from
 * the whole app. `Cmd` chords are the app's to claim there; `Ctrl` chords are
 * the app's to claim everywhere else.
 *
 * The global is read at call time, never at module load, so the answer follows
 * the environment the caller is actually running in.
 */
export function isApplePlatform(
  navigatorLike: PlatformNavigator | undefined = globalThis.navigator,
): boolean {
  return /^(mac|iphone|ipad|ipod)/i.test(reportedPlatform(navigatorLike));
}

/**
 * The platform the host this window drives reports for itself, or undefined
 * until the host's identity has been read (or when a host too old to report
 * one answered). Provided once at the shell root from the host's own report.
 */
export const HostPlatformContext = createContext<HostPlatform | undefined>(undefined);

export function useHostPlatform(): HostPlatform | undefined {
  return useContext(HostPlatformContext);
}

/**
 * How copy names the host's computer: "this Mac" when the host reports macOS,
 * "this computer" otherwise.
 *
 * It reads the host's platform, never the window's: a browser on a Mac can
 * drive a Linux host, and a phone runs on neither. Until the host has said,
 * copy uses the neutral name, which is never wrong, rather than borrowing the
 * window's platform, which is wrong exactly for a remote window.
 */
export function thisComputerName(
  hostPlatform: HostPlatform | undefined,
): "this Mac" | "this computer" {
  return hostComputerName(hostPlatform);
}

/**
 * How copy names where the host keeps a secret: the Keychain on macOS, and the
 * neutral "credential store" elsewhere (Secret Service on Linux) or before the
 * host has reported its platform.
 */
export function credentialStoreName(
  hostPlatform: HostPlatform | undefined,
): "Keychain" | "credential store" {
  return hostPlatform === "darwin" ? "Keychain" : "credential store";
}

/** "this Mac's Keychain" or "this computer's credential store". */
export function hostCredentialStore(hostPlatform: HostPlatform | undefined): string {
  return `${thisComputerName(hostPlatform)}'s ${credentialStoreName(hostPlatform)}`;
}

function reportedPlatform(navigatorLike: PlatformNavigator | undefined): string {
  // `userAgentData.platform` ("macOS") is the supported reading. `platform`
  // ("MacIntel") is deprecated but is what current WebKit still answers, and
  // this app ships in a WebKit-hosted window.
  const reported = navigatorLike?.userAgentData?.platform ?? "";
  if (reported.length > 0) return reported;
  return navigatorLike?.platform ?? "";
}
