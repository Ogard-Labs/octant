import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Linking } from "react-native";
import type { MobileInboxRow } from "@octant/client-runtime";
import {
  captureMobileDeepLink,
  consumeMobileDeepLink,
  type MobileDeepLinkCaptureState,
} from "./mobileDeepLinkCaptureState";

export function MobileDeepLinkCapture(props: {
  readonly children: (
    pendingDeepLinkRow: MobileInboxRow | undefined,
    onDeepLinkConsumed: () => void,
  ) => ReactNode;
}) {
  const [state, setState] = useState<MobileDeepLinkCaptureState>({});
  const openUrl = useCallback((url: string | null) => {
    if (url === null) return;
    setState((current) => captureMobileDeepLink(current, url));
  }, []);

  useEffect(() => {
    const subscription = Linking.addEventListener("url", (event) => openUrl(event.url));
    void Linking.getInitialURL().then(openUrl);
    return () => subscription.remove();
  }, [openUrl]);

  return props.children(state.pendingDeepLinkRow, () => setState(consumeMobileDeepLink));
}
