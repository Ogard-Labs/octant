import type { ThreadUtilityDockContentProps } from "../shell/dockModuleContext";
import { unavailable } from "./moduleState";
import { WorkFilesPanel } from "../work/WorkFilesPanel";
import { CodeFileExplorerPanel } from "../code/CodeFileExplorerPanel";
import { decodeCodeThreadId, decodeWorkThreadId } from "@octant/contracts";
import { Suspense } from "react";
import { ShellState } from "../shell/ShellState";

type Props = Pick<
  ThreadUtilityDockContentProps,
  "onOpenFile" | "serverUrl" | "subject" | "windowCapability" | "workFileListingClient"
>;

export default function FilesModule(props: Props) {
  if (props.subject.mode === "work") {
    return (
      <WorkFilesPanel
        {...(props.workFileListingClient === undefined
          ? {}
          : { client: props.workFileListingClient })}
        {...(props.subject.projectId === undefined ? {} : { projectId: props.subject.projectId })}
        {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
        threadId={decodeWorkThreadId(props.subject.threadId)}
        {...(props.windowCapability === undefined
          ? {}
          : { windowCapability: props.windowCapability })}
      />
    );
  }
  if (props.subject.mode !== "code") {
    return unavailable("Files", "Files opens from a Code thread.");
  }
  return (
    <Suspense fallback={<ShellState state="loading" title="Loading Files" />}>
      <CodeFileExplorerPanel
        {...(props.subject.checkoutId === undefined
          ? {}
          : { checkoutId: props.subject.checkoutId })}
        onOpenFile={(entry) => props.onOpenFile(entry.path)}
        {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
        threadId={decodeCodeThreadId(props.subject.threadId)}
        {...(props.windowCapability === undefined
          ? {}
          : { windowCapability: props.windowCapability })}
      />
    </Suspense>
  );
}
