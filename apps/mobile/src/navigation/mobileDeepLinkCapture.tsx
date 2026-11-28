import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Linking } from "react-native";
import type { MobileInboxRow } from "@octant/client-runtime";
import type { MobileComputersDeepLinkTarget } from "../notifications/deepLinks";
import {
  captureMobileDeepLink,
  consumeMobileDeepLink,
  consumeMobileShareSignal,
  type MobileDeepLinkCaptureState,
} from "./mobileDeepLinkCaptureState";

export function MobileDeepLinkCapture(props: {
  readonly children: (
    pendingDeepLinkRow: MobileInboxRow | undefined,
    onDeepLinkConsumed: () => void,
    pendingComputersLink: MobileComputersDeepLinkTarget | undefined,
    pendingShareSignal: number | undefined,
    onShareSignalConsumed: () => void,
  ) => ReactNode;
}) {
  const [state, setState] = useState<MobileDeepLinkCaptureState>({});
  const openUrl = useCallback((url: string | null | undefined) => {
    if (url === null || url === undefined) return;
    setState((current) => captureMobileDeepLink(current, url));
  }, []);

  useEffect(() => {
    const subscription = Linking.addEventListener("url", (event) => openUrl(event.url));
    void Linking.getInitialURL().then(openUrl);
    return () => subscription.remove();
  }, [openUrl]);

  const onDeepLinkConsumed = useCallback(() => setState(consumeMobileDeepLink), []);
  const onShareSignalConsumed = useCallback(() => setState(consumeMobileShareSignal), []);

  return props.children(
    state.pendingDeepLinkRow,
    onDeepLinkConsumed,
    state.pendingComputersLink,
    state.pendingShareSignal,
    onShareSignalConsumed,
  );
}
