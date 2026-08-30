import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import type { CodeCheckoutId, CodeRelativePath, CodeThreadId } from "@octant/contracts/code";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId } from "@octant/contracts/projects";
import { CodeSearchDialog } from "../code/CodeSearchDialog";
import { FirstRunOnboarding, type FirstRunOnboardingProps } from "../onboarding/FirstRunOnboarding";
import { CommandPalette } from "../palette/CommandPalette";
import { ProjectCreateDialog } from "../projects/ProjectCreateDialog";
import type { OctantHostBridge } from "./hostBridge";
import { visuallyHiddenStyle } from "./shellCommandWiring";
import { ThreadSearchOverlay, type ThreadSearchListingStatus } from "./ThreadSearchOverlay";
import type {
  ThreadSearchContentHit,
  ThreadSearchHit,
  ThreadSearchProject,
  ThreadSearchThread,
} from "./threadSearchViewModel";

export interface ShellDialogHostCodeThreadView {
  readonly checkout: { readonly id: CodeCheckoutId };
  readonly thread: { readonly id: CodeThreadId };
}

export interface ShellDialogHostProps {
  readonly createOpen: boolean;
  readonly folderBrowseClient: FolderBrowseClient;
  readonly hostId: string;
  readonly hostBridge?: OctantHostBridge;
  readonly mode: OctantMode;
  readonly onCloseCreate: () => void;
  readonly onCreateProject: (
    mode: OctantMode,
    name: string,
    receiptId?: string,
  ) => Promise<ProjectId | undefined>;
  readonly onCreatedProject: (projectId: ProjectId, mode: OctantMode, name: string) => void;
  readonly searchOpen: boolean;
  readonly searchThreads: ReadonlyArray<ThreadSearchThread>;
  readonly searchProjects: ReadonlyArray<ThreadSearchProject>;
  readonly searchListing: ThreadSearchListingStatus;
  readonly searchArchivedListing: ThreadSearchListingStatus;
  readonly searchContentHits?: ReadonlyArray<ThreadSearchContentHit>;
  readonly searchContentListing?: ThreadSearchListingStatus;
  readonly searchContentTruncated?: boolean;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onCloseSearch: () => void;
  readonly onNewSearchThread?: () => void;
  readonly onNewSearchProject?: () => void;
  readonly onOpenSearchSettings?: () => void;
  readonly onOpenSearchHit: (hit: ThreadSearchHit) => void;
  readonly zenActive: boolean;
  readonly activeCodeThreadView?: ShellDialogHostCodeThreadView;
  readonly onOpenCodeSearchFile: (relativePath: CodeRelativePath) => void;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly firstRun: FirstRunOnboardingProps;
  readonly announcement: string;
  readonly announcementSequence: number;
  readonly projectAnnouncement: string;
  readonly projectAnnouncementSequence: number;
}

export function ShellDialogHost(props: ShellDialogHostProps) {
  return (
    <>
      {props.createOpen ? (
        <ProjectCreateDialog
          folderBrowseClient={props.folderBrowseClient}
          hostId={props.hostId}
          {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
          mode={props.mode}
          onClose={props.onCloseCreate}
          onCreate={props.onCreateProject}
          onCreated={props.onCreatedProject}
        />
      ) : null}
      {props.searchOpen ? (
        <ThreadSearchOverlay
          mode={props.mode}
          threads={props.searchThreads}
          projects={props.searchProjects}
          unfiledLabel={props.mode === "chat" ? "Unfiled" : "Recents"}
          listing={props.searchListing}
          {...(props.mode === "chat"
            ? {
                archivedListing: props.searchArchivedListing,
                onQueryChange: props.onSearchQueryChange,
                ...(props.searchContentHits === undefined
                  ? {}
                  : { contentHits: props.searchContentHits }),
                ...(props.searchContentListing === undefined
                  ? {}
                  : { contentListing: props.searchContentListing }),
                ...(props.searchContentTruncated === undefined
                  ? {}
                  : { contentTruncated: props.searchContentTruncated }),
              }
            : {})}
          onClose={props.onCloseSearch}
          {...(props.onNewSearchThread === undefined
            ? {}
            : { onNewThread: props.onNewSearchThread })}
          {...(props.onNewSearchProject === undefined
            ? {}
            : { onNewProject: props.onNewSearchProject })}
          {...(props.onOpenSearchSettings === undefined
            ? {}
            : { onOpenSettings: props.onOpenSearchSettings })}
          onOpenThread={props.onOpenSearchHit}
        />
      ) : null}
      {/* One palette for the window. Zen is a deliberate full-surface focus
          mode, so the chord stays inert while it is active. */}
      {props.zenActive ? null : <CommandPalette />}
      {/* One quick-open for the window, scoped to the Code thread currently
          in view. Mounting it per tab would make one chord open a dialog for
          every split pane at once. */}
      {props.zenActive || props.activeCodeThreadView === undefined ? null : (
        <CodeSearchDialog
          checkoutId={props.activeCodeThreadView.checkout.id}
          onOpenFile={props.onOpenCodeSearchFile}
          {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
          {...(props.windowCapability === undefined
            ? {}
            : { windowCapability: props.windowCapability })}
          threadId={props.activeCodeThreadView.thread.id}
        />
      )}
      <FirstRunOnboarding {...props.firstRun} />
      <p
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        data-announcement-sequence={props.announcementSequence}
        style={visuallyHiddenStyle}
      >
        {props.announcement}
        {props.announcementSequence > 0 ? (
          <span
            style={{
              clip: "rect(0 0 0 0)",
              clipPath: "inset(50%)",
              height: 1,
              overflow: "hidden",
              position: "absolute",
              whiteSpace: "nowrap",
              width: 1,
            }}
          >
            {" "}
            Event {props.announcementSequence}.
          </span>
        ) : null}
      </p>
      <p
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        data-project-announcement-sequence={props.projectAnnouncementSequence}
      >
        {props.projectAnnouncement}
      </p>
    </>
  );
}
