import type { MobileInboxRow } from "@octant/client-runtime";
import {
  parseMobileMovesDeepLink,
  parseMobileNewDevicesDeepLink,
  type MobileComputersDeepLinkTarget,
} from "../notifications/deepLinks";
import { resolveDeepLinkToInboxRow } from "./deepLinkNavigation";

/** At most one link waits: the one the person followed last. */
export interface MobileDeepLinkCaptureState {
  readonly pendingDeepLinkRow?: MobileInboxRow | undefined;
  readonly pendingComputersLink?: MobileComputersDeepLinkTarget | undefined;
}

export function captureMobileDeepLink(
  state: MobileDeepLinkCaptureState,
  url: string,
): MobileDeepLinkCaptureState {
  const computers = parseMobileMovesDeepLink(url) ?? parseMobileNewDevicesDeepLink(url);
  if (computers !== undefined) return { pendingComputersLink: computers };
  const row = resolveDeepLinkToInboxRow(url);
  return row === undefined ? state : { pendingDeepLinkRow: row };
}

export function consumeMobileDeepLink(
  _state?: MobileDeepLinkCaptureState,
): MobileDeepLinkCaptureState {
  return {};
}
