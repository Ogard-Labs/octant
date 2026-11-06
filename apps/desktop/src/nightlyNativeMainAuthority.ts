import {
  NATIVE_MAIN_AUTHORITY_HEADER,
  NIGHTLY_HOST_FEATURES,
  type NightlyHostFeature,
  type NightlyWindowBootstrap,
} from "@octant/contracts/nightly-browser";

const WINDOW_CAPABILITY_HEADER = "x-octant-window-capability";

interface NativeMainWindow {
  readonly capability: string;
  readonly token: string;
  readonly features: ReadonlySet<NightlyHostFeature>;
}

/**
 * Holds each Nightly window's main-only host token in this process's memory.
 * It is never written to disk, logged, or handed to a renderer; callers in
 * main ask for the headers of the one window they act for.
 */
export function createNativeMainAuthority() {
  const windows = new Map<number, NativeMainWindow>();
  return Object.freeze({
    remember: (webContentsId: number, bootstrap: NightlyWindowBootstrap): void => {
      if (bootstrap.nativeMainToken === undefined) {
        windows.delete(webContentsId);
        return;
      }
      const known = new Set<string>(NIGHTLY_HOST_FEATURES);
      windows.set(webContentsId, {
        capability: bootstrap.capability,
        token: bootstrap.nativeMainToken,
        features: new Set(
          (bootstrap.hostFeatures ?? []).filter((feature): feature is NightlyHostFeature =>
            known.has(feature),
          ),
        ),
      });
    },
    forget: (webContentsId: number): void => {
      windows.delete(webContentsId);
    },
    /** Whether the window's host brokers this feature for a native main. */
    supports: (webContentsId: number, feature: NightlyHostFeature): boolean =>
      windows.get(webContentsId)?.features.has(feature) ?? false,
    /** Headers for a brokered host request on behalf of exactly this window. */
    headers: (webContentsId: number): Readonly<Record<string, string>> | undefined => {
      const window = windows.get(webContentsId);
      if (window === undefined) return undefined;
      return Object.freeze({
        [WINDOW_CAPABILITY_HEADER]: window.capability,
        [NATIVE_MAIN_AUTHORITY_HEADER]: window.token,
      });
    },
  });
}

export type NativeMainAuthority = ReturnType<typeof createNativeMainAuthority>;
