import type { AutomationClient } from "@octant/client-runtime";
import type { IntegrationClient } from "@octant/client-runtime/integration-client";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type {
  CodeProjectPullRequestRow,
  ProjectId,
  ThreadBoardPullRequestIdentity,
} from "@octant/contracts";
import type { AutomationNotificationClient } from "@octant/client-runtime/automation-notification-client";
import type { ChatClient } from "@octant/client-runtime/chat-client";
import type { CodeClient } from "@octant/client-runtime/code-client";
import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import type { ArtifactLibraryEntry } from "@octant/contracts/artifact-library";
import type { OctantMode } from "@octant/contracts/modes";
import type { ImageGenerationClient } from "@octant/client-runtime/image-generation-client";
import type { ImageGenerationProfileView } from "@octant/contracts";
import { ImageLibraryView } from "../image/ImageLibraryView";
import { lazy, Suspense, type ReactNode } from "react";
import type { AgentsCenterThreadTarget } from "../agents/agentsCenterModel";
import type {
  AutomationEditorCatalog,
  AutomationThreadTarget,
} from "../automation/automationCenterModel";
import type { CodeThreadOpenTarget } from "../code/CodeThreadBoard";
import type { CodeBoardProjectRef } from "../code/codeBoardGrouping";
import type { GithubCatalogueReadResponse } from "@octant/contracts";
import type { AssignedLinearIssuesList } from "../inbox/loadAssignedLinearIssues";
import type { InboxAttentionItem } from "../inbox/inboxModel";
import type { ThreadAttentionSignal } from "../notifications/threadAttention";
import type { ThreadBoardProjectRef } from "../threadBoard/threadBoardGrouping";
import type { WorkThreadOpenTarget } from "../work/WorkThreadBoard";
import type { ArchivedThreadEntry, ArchiveProject } from "./ArchiveView";
import { ShellState } from "./ShellState";

const ArchiveView = lazy(() =>
  import("./ArchiveView").then((module) => ({ default: module.ArchiveView })),
);
const ArtifactLibrarySurface = lazy(() =>
  import("../artifacts/ArtifactLibrarySurface").then((module) => ({
    default: module.ArtifactLibrarySurface,
  })),
);
const AutomationCenter = lazy(() =>
  import("../automation/AutomationCenter").then((module) => ({
    default: module.AutomationCenter,
  })),
);
const AgentsCenter = lazy(() =>
  import("../agents/AgentsCenter").then((module) => ({ default: module.AgentsCenter })),
);
const CodeProjectPullRequests = lazy(() =>
  import("../code/CodeProjectPullRequests").then((module) => ({
    default: module.CodeProjectPullRequests,
  })),
);
const GitHubIssueBrowser = lazy(() =>
  import("../github/GitHubIssueBrowser").then((module) => ({
    default: module.GitHubIssueBrowser,
  })),
);
const InboxView = lazy(() =>
  import("../inbox/InboxView").then((module) => ({ default: module.InboxView })),
);
const LinearIssueBrowser = lazy(() =>
  import("../linear/LinearIssueBrowser").then((module) => ({
    default: module.LinearIssueBrowser,
  })),
);
const CodeThreadBoard = lazy(() =>
  import("../code/CodeThreadBoard").then((module) => ({ default: module.CodeThreadBoard })),
);
const WorkThreadBoard = lazy(() =>
  import("../work/WorkThreadBoard").then((module) => ({ default: module.WorkThreadBoard })),
);

export interface WorkspaceRailLayersProps {
  readonly railPlaceholder?: { readonly title: string; readonly message: string };
  readonly onDismissRailPlaceholder: () => void;
  readonly codeBoardOpen: boolean;
  readonly codePullRequestsOpen: boolean;
  readonly githubIssuesOpen: boolean;
  readonly githubClient: GithubClient;
  readonly linearIssuesOpen: boolean;
  readonly linearClient: IntegrationClient;
  readonly onCloseLinearIssues: () => void;
  readonly workBoardOpen: boolean;
  readonly activeMode: OctantMode;
  readonly codeClient: CodeClient;
  readonly workThreadClient: WorkThreadClient;
  readonly codeBoardProjects: ReadonlyArray<CodeBoardProjectRef>;
  readonly workBoardProjects: ReadonlyArray<ThreadBoardProjectRef>;
  readonly onCloseCodeBoard: () => void;
  readonly onCloseCodePullRequests: () => void;
  readonly onCloseGithubIssues: () => void;
  readonly onCloseWorkBoard: () => void;
  readonly onOpenCodeBoardThread: (target: CodeThreadOpenTarget) => void;
  readonly onOpenWorkBoardThread: (target: WorkThreadOpenTarget) => void;
  readonly onSelectProjectPullRequest?: (row: CodeProjectPullRequestRow) => void;
  readonly pullRequestBackgroundRefresh?: {
    readonly enabledFor: (projectId: ProjectId) => boolean;
    readonly setEnabled: (projectId: ProjectId, enabled: boolean) => Promise<boolean>;
  };
  readonly onSelectBoardPullRequest?: (identity: ThreadBoardPullRequestIdentity) => void;
  readonly selectedProjectPullRequestKey?: string;
  readonly unreadThreadIds?: ReadonlySet<string>;
  readonly providerLabels?: ReadonlyMap<string, string>;
  readonly archiveOpen?: boolean;
  readonly archiveChatClient?: ChatClient;
  readonly archiveEntries?: ReadonlyArray<ArchivedThreadEntry>;
  readonly archiveProjects?: ReadonlyArray<ArchiveProject>;
  readonly onCloseArchive?: () => void;
  readonly onOpenArchivedThread?: (entry: ArchivedThreadEntry) => void;
  readonly artifactLibraryOpen: boolean;
  readonly onCloseArtifactLibrary: () => void;
  readonly imageLibraryOpen: boolean;
  readonly onCloseImageLibrary: () => void;
  readonly imageGenerationClient?: ImageGenerationClient;
  readonly imageProfiles: ReadonlyArray<ImageGenerationProfileView>;
  readonly onOpenImageSettings?: () => void;
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
  readonly agentsCenterVisible: boolean;
  readonly agentRunClient: AgentRunClient;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly onCloseAgentsCenter: () => void;
  readonly onOpenAgentsThread: (
    target: AgentsCenterThreadTarget & { readonly title: string },
  ) => void;
  /** The Inbox is mode-independent: what waits on the user spans every mode. */
  readonly inboxOpen: boolean;
  readonly onCloseInbox: () => void;
  readonly inboxAttentionItems: ReadonlyArray<InboxAttentionItem>;
  readonly onOpenInboxThread: (signal: ThreadAttentionSignal) => void;
  readonly loadAssignedGithubWork?: () => Promise<GithubCatalogueReadResponse>;
  readonly loadAssignedLinearIssues?: () => Promise<AssignedLinearIssuesList>;
  readonly onOpenLinearIssues?: () => void;
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
      {props.inboxOpen ? (
        <div className="inbox-layer">
          <LazyRailSurface label="Inbox">
            <InboxView
              attentionItems={props.inboxAttentionItems}
              onClose={props.onCloseInbox}
              onOpenThread={props.onOpenInboxThread}
              {...(props.loadAssignedGithubWork === undefined
                ? {}
                : { loadAssignedGithubWork: props.loadAssignedGithubWork })}
              {...(props.loadAssignedLinearIssues === undefined
                ? {}
                : { loadAssignedLinearIssues: props.loadAssignedLinearIssues })}
              {...(props.onOpenLinearIssues === undefined
                ? {}
                : { onOpenLinearIssues: props.onOpenLinearIssues })}
            />
          </LazyRailSurface>
        </div>
      ) : null}
      {props.githubIssuesOpen && props.activeMode === "code" ? (
        <div className="code-board-layer">
          <LazyRailSurface label="GitHub issues">
            <GitHubIssueBrowser client={props.githubClient} onClose={props.onCloseGithubIssues} />
          </LazyRailSurface>
        </div>
      ) : null}
      {props.linearIssuesOpen && props.activeMode === "code" ? (
        <div className="code-board-layer">
          <LazyRailSurface label="Linear">
            <LinearIssueBrowser
              getIssue={(input) => props.linearClient.getIssue(input)}
              isNarrow={props.isNarrow}
              listIssueFilters={() => props.linearClient.listIssueFilters()}
              listIssues={(input) => props.linearClient.listIssues(input)}
              onClose={props.onCloseLinearIssues}
            />
          </LazyRailSurface>
        </div>
      ) : null}
      {props.codePullRequestsOpen && props.activeMode === "code" ? (
        <div className="code-board-layer">
          <LazyRailSurface label="Pull requests">
            <CodeProjectPullRequests
              isNarrow={props.isNarrow}
              load={(query) => props.codeClient.queryProjectPullRequests(query)}
              onClose={props.onCloseCodePullRequests}
              refresh={(command) => props.codeClient.refreshProjectPullRequests(command)}
              {...(props.pullRequestBackgroundRefresh === undefined
                ? {}
                : { backgroundRefresh: props.pullRequestBackgroundRefresh })}
              {...(props.onSelectProjectPullRequest === undefined
                ? {}
                : { onSelectRow: props.onSelectProjectPullRequest })}
              {...(props.selectedProjectPullRequestKey === undefined
                ? {}
                : { selectedRowKey: props.selectedProjectPullRequestKey })}
            />
          </LazyRailSurface>
        </div>
      ) : null}
      {props.codeBoardOpen && props.activeMode === "code" ? (
        <div className="code-board-layer">
          <LazyRailSurface label="Code Thread Board">
            <CodeThreadBoard
              isNarrow={props.isNarrow}
              loadBoard={(query) => props.codeClient.queryBoard(query)}
              projects={props.codeBoardProjects}
              onClose={props.onCloseCodeBoard}
              onOpenThread={props.onOpenCodeBoardThread}
              {...(props.onSelectBoardPullRequest === undefined
                ? {}
                : { onSelectPullRequest: props.onSelectBoardPullRequest })}
              {...(props.unreadThreadIds === undefined
                ? {}
                : { unreadThreadIds: props.unreadThreadIds })}
              {...(props.providerLabels === undefined
                ? {}
                : { providerLabels: props.providerLabels })}
            />
          </LazyRailSurface>
        </div>
      ) : null}
      {props.workBoardOpen && props.activeMode === "work" ? (
        <div className="code-board-layer">
          <LazyRailSurface label="Work Thread Board">
            <WorkThreadBoard
              isNarrow={props.isNarrow}
              loadBoard={(query) => props.workThreadClient.queryBoard(query)}
              projects={props.workBoardProjects}
              onClose={props.onCloseWorkBoard}
              onOpenThread={props.onOpenWorkBoardThread}
              {...(props.onSelectBoardPullRequest === undefined
                ? {}
                : { onSelectPullRequest: props.onSelectBoardPullRequest })}
              {...(props.unreadThreadIds === undefined
                ? {}
                : { unreadThreadIds: props.unreadThreadIds })}
              {...(props.providerLabels === undefined
                ? {}
                : { providerLabels: props.providerLabels })}
            />
          </LazyRailSurface>
        </div>
      ) : null}
      {props.archiveOpen === true &&
      props.archiveEntries !== undefined &&
      props.archiveProjects !== undefined &&
      props.onCloseArchive !== undefined &&
      props.onOpenArchivedThread !== undefined ? (
        <div className="archive-layer">
          <LazyRailSurface label="Archive">
            <ArchiveView
              {...(props.archiveChatClient === undefined
                ? {}
                : { chatClient: props.archiveChatClient })}
              entries={props.archiveEntries}
              onClose={props.onCloseArchive}
              onOpenThread={props.onOpenArchivedThread}
              projects={props.archiveProjects}
            />
          </LazyRailSurface>
        </div>
      ) : null}
      {props.imageLibraryOpen && props.imageGenerationClient !== undefined ? (
        <div className="artifact-library-layer">
          <LazyRailSurface label="Image generator">
            <ImageLibraryView
              client={props.imageGenerationClient}
              onClose={props.onCloseImageLibrary}
              {...(props.onOpenImageSettings === undefined
                ? {}
                : { onOpenSettings: props.onOpenImageSettings })}
              profiles={props.imageProfiles}
            />
          </LazyRailSurface>
        </div>
      ) : null}
      {props.artifactLibraryOpen ? (
        <div className="artifact-library-layer">
          <LazyRailSurface label="Artifacts">
            <ArtifactLibrarySurface
              onClose={props.onCloseArtifactLibrary}
              onCreate={props.onCreateArtifact}
              onOpen={props.onOpenArtifact}
              serverUrl={props.serverUrl}
              {...(props.windowCapability === undefined
                ? {}
                : { windowCapability: props.windowCapability })}
            />
          </LazyRailSurface>
        </div>
      ) : null}
      {props.automationCenterVisible ? (
        <div className="automation-center-layer">
          <LazyRailSurface label="Automation Center">
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
          </LazyRailSurface>
        </div>
      ) : null}
      {props.agentsCenterVisible ? (
        <div className="agents-center-layer">
          <LazyRailSurface label="Agents Center">
            <AgentsCenter
              client={props.agentRunClient}
              narrow={props.isNarrow}
              onClose={props.onCloseAgentsCenter}
              onOpenThread={props.onOpenAgentsThread}
              projectNames={props.projectNames}
              {...(props.providerLabels === undefined
                ? {}
                : { providerLabels: props.providerLabels })}
            />
          </LazyRailSurface>
        </div>
      ) : null}
    </>
  );
}

function LazyRailSurface(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div aria-label={`Opening ${props.label}`} className="workspace-rail-loading" role="status">
          Opening {props.label}…
        </div>
      }
    >
      {props.children}
    </Suspense>
  );
}
