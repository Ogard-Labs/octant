import type { ThreadUtilityDockContentProps } from "../shell/dockModuleContext";
import { unavailable } from "./moduleState";
import { DockDocumentTool } from "../shell/DockDocumentTool";
import { decodeCodeThreadId } from "@octant/contracts";

type Props = Pick<
  ThreadUtilityDockContentProps,
  "codeController" | "serverUrl" | "subject" | "windowCapability" | "writtenDocumentPath"
>;

export default function DocumentModule(props: Props) {
  if (props.subject.mode !== "code" || props.codeController === undefined) {
    return unavailable("Document", "Document opens from a Code thread.");
  }
  if (props.writtenDocumentPath === undefined) {
    return unavailable("Document", "This thread has not written a document yet.");
  }
  return (
    <DockDocumentTool
      {...(props.subject.checkoutId === undefined ? {} : { checkoutId: props.subject.checkoutId })}
      client={props.codeController.client}
      path={props.writtenDocumentPath}
      {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
      threadId={decodeCodeThreadId(props.subject.threadId)}
      {...(props.windowCapability === undefined
        ? {}
        : { windowCapability: props.windowCapability })}
    />
  );
}
