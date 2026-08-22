import type { AutomationClient } from "@octant/client-runtime";
import type { CodeProjectPullRequestRow } from "@octant/contracts";
import type { AutomationNotificationClient } from "@octant/client-runtime/automation-notification-client";
import type { CodeClient } from "@octant/client-runtime/code-client";
import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import type { ArtifactLibraryEntry } from "@octant/contracts/artifact-library";
import type { OctantMode } from "@octant/contracts/modes";
import { ArtifactLibrarySurface } from "../artifacts/ArtifactLibrarySurface";
import { AutomationCenter } from "../automation/AutomationCenter";
import type {
  AutomationEditorCatalog,
  AutomationThreadTarget,
} from "../automation/automationCenterModel";
import { CodeProjectPullRequests } from "../code/CodeProjectPullRequests";
import { CodeThreadBoard, type CodeThreadOpenTarget } from "../code/CodeThreadBoard";
import type { CodeBoardProjectRef } from "../code/codeBoardGrouping";
import type { ThreadBoardProjectRef } from "../threadBoard/threadBoardGrouping";
import { WorkThreadBoard, type WorkThreadOpenTarget } from "../work/WorkThreadBoard";
import { ShellState } from "./ShellState";

export interface WorkspaceRailLayersProps {
  readonly railPlaceholder?: { readonly title: string; readonly message: string };
  readonly onDismissRailPlaceholder: () => void;
  readonly codeBoardOpen: boolean;
  readonly codePullRequestsOpen: boolean;
  readonly workBoardOpen: boolean;
  readonly activeMode: OctantMode;
  readonly codeClient: CodeClient;
  readonly workThreadClient: WorkThreadClient;
  readonly codeBoardProjects: ReadonlyArray<CodeBoardProjectRef>;
  readonly workBoardProjects: ReadonlyArray<ThreadBoardProjectRef>;
  readonly onCloseCodeBoard: () => void;
  readonly onCloseCodePullRequests: () => void;
  readonly onCloseWorkBoard: () => void;
  readonly onOpenCodeBoardThread: (target: CodeThreadOpenTarget) => void;
  readonly onOpenWorkBoardThread: (target: WorkThreadOpenTarget) => void;
  readonly onSelectProjectPullRequest?: (row: CodeProjectPullRequestRow) => void;
  readonly selectedProjectPullRequestKey?: string;
  readonly unreadThreadIds?: ReadonlySet<string>;
  readonly providerLabels?: ReadonlyMap<string, string>;
  readonly artifactLibraryOpen: boolean;
  readonly onCloseArtifactLibrary: () => void;
  readonly onCreateArtifact: () => void;
  readonly onOpenArtifact: (entry: ArtifactLibraryEntry) => void;
  readonly serverUrl: string;
  readonly windowCapability?: string;
  readonly automationCenterVisible: boolean;
  readonly automationEditorCatalog: AutomationEditorCatalog;
  readonly automationClient: AutomationClient;
  readonly environmentNames: ReadonlyMap<string, string>;
  readonly localHostId: string;
  readonly isNarrow: boolean;
  readonly notificationClient: AutomationNotificationClient;
  readonly onCloseAutomationCenter: () => void;
  readonly onOpenAutomationThread: (
    target: AutomationThreadTarget & { readonly title: string },
  ) => void;
}

export function WorkspaceRailLayers(props: WorkspaceRailLayersProps) {
  return (
    <>
      {props.railPlaceholder === undefined ? null : (
        <div className="rail-placeholder" role="status">
          <ShellState
            action={{
              label: "Back to workspace",
              onClick: props.onDismissRailPlaceholder,
            }}
            eyebrow="Sidebar"
            message={props.railPlaceholder.message}
            state="neutral"
            title={props.railPlaceholder.title}
          />
        </div>
      )}
      {props.codePullRequestsOpen && props.activeMode === "code" ? (
        <div className="code-board-layer">
          <CodeProjectPullRequests
            isNarrow={props.isNarrow}
            load={(query) => props.codeClient.queryProjectPullRequests(query)}
            onClose={props.onCloseCodePullRequests}
            refresh={(command) => props.codeClient.refreshProjectPullRequests(command)}
            {...(props.onSelectProjectPullRequest === undefined
              ? {}
              : { onSelectRow: props.onSelectProjectPullRequest })}
            {...(props.selectedProjectPullRequestKey === undefined
              ? {}
              : { selectedRowKey: props.selectedProjectPullRequestKey })}
          />
        </div>
      ) : null}
      {props.codeBoardOpen && props.activeMode === "code" ? (
        <div className="code-board-layer">
          <CodeThreadBoard
            isNarrow={props.isNarrow}
            loadBoard={(query) => props.codeClient.queryBoard(query)}
            projects={props.codeBoardProjects}
            onClose={props.onCloseCodeBoard}
            onOpenThread={props.onOpenCodeBoardThread}
            {...(props.unreadThreadIds === undefined
              ? {}
              : { unreadThreadIds: props.unreadThreadIds })}
            {...(props.providerLabels === undefined
              ? {}
              : { providerLabels: props.providerLabels })}
          />
        </div>
      ) : null}
      {props.workBoardOpen && props.activeMode === "work" ? (
        <div className="code-board-layer">
          <WorkThreadBoard
            isNarrow={props.isNarrow}
            loadBoard={(query) => props.workThreadClient.queryBoard(query)}
            projects={props.workBoardProjects}
            onClose={props.onCloseWorkBoard}
            onOpenThread={props.onOpenWorkBoardThread}
            {...(props.unreadThreadIds === undefined
              ? {}
              : { unreadThreadIds: props.unreadThreadIds })}
            {...(props.providerLabels === undefined
              ? {}
              : { providerLabels: props.providerLabels })}
          />
        </div>
      ) : null}
      {props.artifactLibraryOpen ? (
        <div className="artifact-library-layer">
          <ArtifactLibrarySurface
            onClose={props.onCloseArtifactLibrary}
            onCreate={props.onCreateArtifact}
            onOpen={props.onOpenArtifact}
            serverUrl={props.serverUrl}
            {...(props.windowCapability === undefined
              ? {}
              : { windowCapability: props.windowCapability })}
          />
        </div>
      ) : null}
      {props.automationCenterVisible ? (
        <div className="automation-center-layer">
          <AutomationCenter
            catalog={props.automationEditorCatalog}
            client={props.automationClient}
            // What each connected host is called, so a routine's row and
            // the environment filter never disagree about a name. The
            // host this window runs on is always "Local", whatever the
            // machine is called and whatever it runs.
            environmentNames={props.environmentNames}
            localHostId={props.localHostId}
            narrow={props.isNarrow}
            notificationClient={props.notificationClient}
            onClose={props.onCloseAutomationCenter}
            onOpenThread={props.onOpenAutomationThread}
          />
        </div>
      ) : null}
    </>
  );
}
