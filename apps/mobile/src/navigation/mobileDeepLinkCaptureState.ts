import type { MobileInboxRow } from "@octant/client-runtime";
import {
  parseMobileMovesDeepLink,
  type MobileMovesDeepLinkTarget,
} from "../notifications/deepLinks";
import { resolveDeepLinkToInboxRow } from "./deepLinkNavigation";

/** At most one link waits: the one the person followed last. */
export interface MobileDeepLinkCaptureState {
  readonly pendingDeepLinkRow?: MobileInboxRow | undefined;
  readonly pendingMovesLink?: MobileMovesDeepLinkTarget | undefined;
}

export function captureMobileDeepLink(
  state: MobileDeepLinkCaptureState,
  url: string,
): MobileDeepLinkCaptureState {
  const moves = parseMobileMovesDeepLink(url);
  if (moves !== undefined) return { pendingMovesLink: moves };
  const row = resolveDeepLinkToInboxRow(url);
  return row === undefined ? state : { pendingDeepLinkRow: row };
}

export function consumeMobileDeepLink(
  _state?: MobileDeepLinkCaptureState,
): MobileDeepLinkCaptureState {
  return {};
}
