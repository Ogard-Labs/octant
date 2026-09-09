import type { ThreadUtilityDockContentProps } from "../shell/dockModuleContext";
import { unavailable } from "./moduleState";
import { ReviewWorkspace } from "../gitHistory/ReviewWorkspace";
import { decodeCodeThreadId } from "@octant/contracts";
import { Suspense } from "react";
import { ShellState } from "../shell/ShellState";

type Props = Pick<
  ThreadUtilityDockContentProps,
  "codeController" | "hostBridge" | "onOpenFile" | "serverUrl" | "subject" | "windowCapability"
>;

export default function ReviewModule(props: Props) {
  if (props.subject.mode !== "code") {
    return unavailable("Review", "Review opens from a Code thread.");
  }
  return (
    <Suspense fallback={<ShellState state="loading" title="Loading Review" />}>
      <ReviewWorkspace
        {...(props.codeController === undefined ? {} : { controller: props.codeController })}
        threadId={decodeCodeThreadId(props.subject.threadId)}
        {...(props.subject.checkoutId === undefined
          ? {}
          : { checkoutId: props.subject.checkoutId })}
        {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
        onOpenFile={props.onOpenFile}
        {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
        {...(props.windowCapability === undefined
          ? {}
          : { windowCapability: props.windowCapability })}
      />
    </Suspense>
  );
}
