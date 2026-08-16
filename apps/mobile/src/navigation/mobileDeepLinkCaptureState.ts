import type { MobileInboxRow } from "@octant/client-runtime";
import { resolveDeepLinkToInboxRow } from "./deepLinkNavigation";

export interface MobileDeepLinkCaptureState {
  readonly pendingDeepLinkRow?: MobileInboxRow | undefined;
}

export function captureMobileDeepLink(
  state: MobileDeepLinkCaptureState,
  url: string,
): MobileDeepLinkCaptureState {
  const row = resolveDeepLinkToInboxRow(url);
  return row === undefined ? state : { pendingDeepLinkRow: row };
}

export function consumeMobileDeepLink(
  _state?: MobileDeepLinkCaptureState,
): MobileDeepLinkCaptureState {
  return {};
}
