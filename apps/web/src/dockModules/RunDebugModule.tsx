import { createCodeDebugClient } from "@octant/client-runtime/code-debug-client";
import { decodeCodeThreadId } from "@octant/contracts/code";
import { useMemo } from "react";
import { RunDebugPanel } from "../debug/RunDebugPanel";
import { unavailable } from "./moduleState";
import type { ThreadUtilityDockContentProps } from "../shell/dockModuleContext";

export type RunDebugModuleProps = Pick<
  ThreadUtilityDockContentProps,
  "onOpenFile" | "serverUrl" | "subject" | "windowCapability" | "codeClient" | "codeThreadView"
>;

export default function RunDebugModule(props: RunDebugModuleProps) {
  const { serverUrl, windowCapability } = props;
  // A base URL the client refuses (a remote host over plain HTTP) leaves the
  // tool unavailable rather than broken.
  const client = useMemo(() => {
    if (serverUrl === undefined || windowCapability === undefined) return undefined;
    try {
      return createCodeDebugClient({
        baseUrl: serverUrl,
        fetch: globalThis.fetch,
        windowCapability,
      });
    } catch {
      return undefined;
    }
  }, [serverUrl, windowCapability]);
  const threadId = useMemo(() => {
    try {
      return decodeCodeThreadId(props.subject.threadId);
    } catch {
      return undefined;
    }
  }, [props.subject.threadId]);
  const { checkoutId } = props.subject;
  const view = props.codeThreadView;
  const currentProject =
    view !== undefined &&
    String(view.thread.id) === props.subject.threadId &&
    String(view.checkout.id) === String(checkoutId) &&
    String(view.thread.projectId) === String(props.subject.projectId) &&
    view.checkout.availability === "available" &&
    view.checkout.kind !== "remote-root"
      ? view.thread.projectId
      : undefined;
  if (props.subject.mode !== "code" || threadId === undefined) {
    return unavailable("Run and debug", "A program is debugged from a Code thread.");
  }
  if (checkoutId === undefined) {
    return unavailable("Run and debug", "This thread has no checkout to debug in yet.");
  }
  if (client === undefined) {
    return unavailable("Run and debug", "This window has no connection to the host.");
  }
  return (
    <RunDebugPanel
      checkoutId={checkoutId}
      client={client}
      {...(props.codeClient === undefined || currentProject === undefined
        ? {}
        : { fileClient: props.codeClient, projectId: currentProject })}
      key={`${serverUrl}:${String(currentProject)}:${String(threadId)}:${String(checkoutId)}`}
      onOpenFile={props.onOpenFile}
      threadId={threadId}
    />
  );
}
