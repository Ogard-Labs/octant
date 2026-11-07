import {
  decodeNightlyWindowBootstrap,
  type NightlyWindowBootstrap,
} from "@octant/contracts/nightly-browser";
import type { NativeWindowBroker } from "./nightlyBrowserLease";
import { boundedDesktopPeerOperation } from "./desktopPeerStatus";

export interface NativeDesktopWindows extends NativeWindowBroker {
  readonly openWindow: (clientHandle: string, generation: number) => Promise<unknown>;
  readonly renewWindow: (clientHandle: string, generation: number) => Promise<unknown>;
  readonly revokeWindow: (clientHandle: string, generation: number) => Promise<unknown>;
}

export function desktopWindowProtocol(native: unknown): NativeDesktopWindows | undefined {
  if (
    typeof native !== "object" ||
    native === null ||
    !("listenWindows" in native) ||
    typeof native.listenWindows !== "function" ||
    !("replyWindow" in native) ||
    typeof native.replyWindow !== "function" ||
    !("stopWindows" in native) ||
    typeof native.stopWindows !== "function" ||
    !("openWindow" in native) ||
    typeof native.openWindow !== "function" ||
    !("renewWindow" in native) ||
    typeof native.renewWindow !== "function" ||
    !("revokeWindow" in native) ||
    typeof native.revokeWindow !== "function"
  )
    return undefined;
  return native as NativeDesktopWindows;
}

export async function registerNightlyWindow(
  native: NativeDesktopWindows,
  handle: string,
  generation: number,
): Promise<
  | { readonly kind: "registered"; readonly bootstrap: NightlyWindowBootstrap }
  | { readonly kind: "refused"; readonly reason: string }
> {
  const value = await boundedDesktopPeerOperation(() => native.openWindow(handle, generation));
  try {
    const bootstrap = decodeNightlyWindowBootstrap(value);
    if (bootstrap.generation !== generation) return { kind: "refused", reason: "invalid-receipt" };
    return { kind: "registered", bootstrap };
  } catch {
    const reason =
      typeof value === "object" &&
      value !== null &&
      "reason" in value &&
      typeof value.reason === "string"
        ? value.reason
        : "invalid-receipt";
    return { kind: "refused", reason };
  }
}
