import { decodeCodeThreadId } from "@octant/contracts";
import { AndroidEmulatorPane } from "../android/AndroidEmulatorPane";
import { nativeCodeWorkspaceApprovals } from "../code/codeWorkspaceApprovals";
import { loading, unavailable } from "./moduleState";
import type { ThreadUtilityDockContentProps } from "../shell/dockModuleContext";

export type AndroidEmulatorModuleProps = Pick<
  ThreadUtilityDockContentProps,
  "androidToolchainClient" | "codeController" | "hostBridge" | "subject" | "windowCapability"
>;

export default function AndroidEmulatorModule(props: AndroidEmulatorModuleProps) {
  if (props.subject.mode !== "code")
    return unavailable("Android emulator", "Android emulator opens from a Code thread.");
  const controller = props.codeController;
  const threadId = decodeCodeThreadId(props.subject.threadId);
  if (
    controller?.activeView === undefined ||
    String(controller.activeView.thread.id) !== String(threadId)
  ) {
    return loading("Android emulator");
  }
  if (props.androidToolchainClient === undefined) {
    return unavailable(
      "Android emulator",
      "This window has no Android toolchain connection.",
    );
  }
  const view = controller.activeView;
  const approvals = nativeCodeWorkspaceApprovals(props.hostBridge, view);
  return (
    <AndroidEmulatorPane
      client={props.androidToolchainClient}
      createUuid={() => globalThis.crypto.randomUUID()}
      {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
      {...(approvals?.android === undefined ? {} : { requestApproval: approvals.android })}
      thread={view.thread}
      checkoutId={view.checkout.id}
    />
  );
}
