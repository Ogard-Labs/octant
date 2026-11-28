import type { MobileInboxRow } from "@octant/client-runtime";
import {
  parseMobileMovesDeepLink,
  parseMobileNewDevicesDeepLink,
  parseMobileShareDeepLink,
  type MobileComputersDeepLinkTarget,
} from "../notifications/deepLinks";
import { resolveDeepLinkToInboxRow } from "./deepLinkNavigation";

/** At most one navigation link waits, plus a counter for bare `octant://share` signals. */
export interface MobileDeepLinkCaptureState {
  readonly pendingDeepLinkRow?: MobileInboxRow | undefined;
  readonly pendingComputersLink?: MobileComputersDeepLinkTarget | undefined;
  readonly pendingShareSignal?: number | undefined;
}

export function captureMobileDeepLink(
  state: MobileDeepLinkCaptureState,
  url: string,
): MobileDeepLinkCaptureState {
  if (parseMobileShareDeepLink(url)) {
    return {
      ...state,
      pendingShareSignal: (state.pendingShareSignal ?? 0) + 1,
    };
  }
  const computers = parseMobileMovesDeepLink(url) ?? parseMobileNewDevicesDeepLink(url);
  if (computers !== undefined) {
    return {
      ...(state.pendingShareSignal === undefined
        ? {}
        : { pendingShareSignal: state.pendingShareSignal }),
      pendingComputersLink: computers,
    };
  }
  const row = resolveDeepLinkToInboxRow(url);
  return row === undefined
    ? state
    : {
        ...(state.pendingShareSignal === undefined
          ? {}
          : { pendingShareSignal: state.pendingShareSignal }),
        pendingDeepLinkRow: row,
      };
}

export function consumeMobileDeepLink(
  state?: MobileDeepLinkCaptureState,
): MobileDeepLinkCaptureState {
  return state?.pendingShareSignal === undefined
    ? {}
    : { pendingShareSignal: state.pendingShareSignal };
}

export function consumeMobileShareSignal(
  state: MobileDeepLinkCaptureState,
): MobileDeepLinkCaptureState {
  const { pendingShareSignal: _consumed, ...rest } = state;
  return rest;
}
