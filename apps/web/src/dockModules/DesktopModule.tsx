import { createDesktopPaneClient } from "@octant/client-runtime/desktop-pane-client";
import { useMemo } from "react";
import { DesktopPane } from "../desktop/DesktopPane";
import { unavailable } from "./moduleState";
import type { ThreadUtilityDockContentProps } from "../shell/dockModuleContext";

export type DesktopModuleProps = Pick<
  ThreadUtilityDockContentProps,
  "serverUrl" | "subject" | "windowCapability"
>;

export default function DesktopModule(props: DesktopModuleProps) {
  const { serverUrl, windowCapability } = props;
  // A base URL the client refuses (a remote host over plain HTTP) leaves the
  // tool unavailable rather than broken.
  const client = useMemo(() => {
    if (serverUrl === undefined || windowCapability === undefined) return undefined;
    try {
      return createDesktopPaneClient({
        baseUrl: serverUrl,
        fetch: globalThis.fetch,
        windowCapability,
      });
    } catch {
      return undefined;
    }
  }, [serverUrl, windowCapability]);
  if (props.subject.mode !== "code") {
    return unavailable("Desktop", "A disposable desktop opens from a Code thread.");
  }
  if (client === undefined) {
    return unavailable("Desktop", "This window has no connection to the host's desktops.");
  }
  return (
    <DesktopPane client={client} key={props.subject.threadId} threadId={props.subject.threadId} />
  );
}
