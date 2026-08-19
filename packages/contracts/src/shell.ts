import { Schema } from "effect";
import { AppleProjectPath } from "./appleToolchain";
import { ChatThreadId } from "./chat";
import { CodeRelativePath, CodeTerminalId, CodeTestRunId, CodeThreadId } from "./code";
import { WorkThreadId } from "./workThreads";
import { BrowserContextId, BrowserThreadId } from "./browserAutomation";
import { AggregateVersion } from "./events";
import { HostId, LOCAL_HOST_ID } from "./host";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";
import { CanvasId } from "./canvas";
import {
  PreviewDisplayName,
  PreviewHostId,
  PreviewOpaqueRef,
  PreviewTargetId,
  PreviewTargetKind,
  PreviewViewerState,
} from "./previews";
import { MentionableThreadId } from "./threadMention";
import { NavigatorAssistantSettings } from "./navigatorAssistant";
import { DEFAULT_AVATAR_ACCENT, DEFAULT_USER_AVATAR, UserProfile } from "./userProfile";
import { SidebarBackground, DEFAULT_SIDEBAR_BACKGROUND } from "./theme";

export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 420;
export const MIN_CONTEXT_SIDEBAR_WIDTH = 280;
export const MAX_CONTEXT_SIDEBAR_WIDTH = 640;
export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;

export const MAX_STOWED_WORKSPACE_LAYOUTS = 12;

const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const WindowId = brandedUuid("WindowId");
export type WindowId = typeof WindowId.Type;
export const LayoutNodeId = brandedUuid("LayoutNodeId");
export type LayoutNodeId = typeof LayoutNodeId.Type;
export const TabGroupId = brandedUuid("TabGroupId");
export type TabGroupId = typeof TabGroupId.Type;
export const WorkspaceTabId = brandedUuid("WorkspaceTabId");
export type WorkspaceTabId = typeof WorkspaceTabId.Type;

export { HostId, LOCAL_HOST_ID };

export const WorkspaceContextKey = Schema.Struct({
  host: HostId,
  mode: OctantMode,
  projectId: Schema.NullOr(ProjectId),
  boundRoot: Schema.NullOr(Schema.NonEmptyTrimmedString),
}).annotations(strict);
export type WorkspaceContextKey = typeof WorkspaceContextKey.Type;

export const WorkspaceSurfaceKind = Schema.Literal(
  "thread",
  "browser",
  "terminal",
  "files",
  "diff",
  "git-review",
  "side-chat",
);
export type WorkspaceSurfaceKind = typeof WorkspaceSurfaceKind.Type;

export const WorkspaceSurfaceDescriptor = Schema.Struct({
  kind: WorkspaceSurfaceKind,
  label: Schema.NonEmptyTrimmedString,
  available: Schema.Boolean,
  unavailableReason: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations(strict);
export type WorkspaceSurfaceDescriptor = typeof WorkspaceSurfaceDescriptor.Type;

export const WorkspaceSurfaceCatalog = Schema.Struct({
  chat: Schema.Array(WorkspaceSurfaceDescriptor),
  work: Schema.Array(WorkspaceSurfaceDescriptor),
  code: Schema.Array(WorkspaceSurfaceDescriptor),
}).annotations(strict);
export type WorkspaceSurfaceCatalog = typeof WorkspaceSurfaceCatalog.Type;

export const SidebarWidth = Schema.Number.pipe(
  Schema.greaterThanOrEqualTo(MIN_SIDEBAR_WIDTH),
  Schema.lessThanOrEqualTo(MAX_SIDEBAR_WIDTH),
);
export type SidebarWidth = typeof SidebarWidth.Type;

export const ContextSurfaceId = Schema.Literal(
  "context",
  "project-memory",
  "code-environment",
  "navigator",
);
export type ContextSurfaceId = typeof ContextSurfaceId.Type;

export const ContextSidebarWidth = Schema.Number.pipe(
  Schema.greaterThanOrEqualTo(MIN_CONTEXT_SIDEBAR_WIDTH),
  Schema.lessThanOrEqualTo(MAX_CONTEXT_SIDEBAR_WIDTH),
);
export type ContextSidebarWidth = typeof ContextSidebarWidth.Type;

export const SplitRatio = Schema.Number.pipe(
  Schema.greaterThanOrEqualTo(MIN_SPLIT_RATIO),
  Schema.lessThanOrEqualTo(MAX_SPLIT_RATIO),
);
export type SplitRatio = typeof SplitRatio.Type;

export const ModeSwitcherPresentation = Schema.Literal("buttons", "dropdown");
export type ModeSwitcherPresentation = typeof ModeSwitcherPresentation.Type;

/** How the Code sidebar offers its saved project views: a dropdown or inline icon buttons. */
export const ProjectViewSwitcherPresentation = Schema.Literal("dropdown", "inline");
export type ProjectViewSwitcherPresentation = typeof ProjectViewSwitcherPresentation.Type;

export const EnvironmentPresentation = Schema.Literal("floating", "pinned", "hidden");
export type EnvironmentPresentation = typeof EnvironmentPresentation.Type;

export const MIN_ENVIRONMENT_PINNED_WIDTH = 240;
export const MAX_ENVIRONMENT_PINNED_WIDTH = 640;

export const EnvironmentPinnedWidth = Schema.Number.pipe(
  Schema.greaterThanOrEqualTo(MIN_ENVIRONMENT_PINNED_WIDTH),
  Schema.lessThanOrEqualTo(MAX_ENVIRONMENT_PINNED_WIDTH),
);
export type EnvironmentPinnedWidth = typeof EnvironmentPinnedWidth.Type;

export const EnvironmentTabPresentation = Schema.Struct({
  tabId: WorkspaceTabId,
  presentation: EnvironmentPresentation,
  pinnedWidth: Schema.optionalWith(EnvironmentPinnedWidth, { default: () => 360 }),
}).annotations(strict);
export type EnvironmentTabPresentation = typeof EnvironmentTabPresentation.Type;

export const EnvironmentPresentationByMode = Schema.Struct({
  chat: EnvironmentPresentation,
  work: EnvironmentPresentation,
  code: EnvironmentPresentation,
}).annotations(strict);
export type EnvironmentPresentationByMode = typeof EnvironmentPresentationByMode.Type;

export const EnvironmentPresentationState = Schema.Struct({
  byTab: Schema.Array(EnvironmentTabPresentation),
  byMode: EnvironmentPresentationByMode,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (state) => new Set(state.byTab.map((entry) => entry.tabId)).size === state.byTab.length,
    ),
  );
export type EnvironmentPresentationState = typeof EnvironmentPresentationState.Type;

export const DEFAULT_ENVIRONMENT_PRESENTATION_BY_MODE: EnvironmentPresentationByMode = {
  chat: "hidden",
  work: "floating",
  code: "pinned",
};

export const EnvironmentCompactStatus = Schema.Literal(
  "available",
  "unavailable",
  "stale",
  "disconnected",
  "recovery",
);
export type EnvironmentCompactStatus = typeof EnvironmentCompactStatus.Type;

export const EnvironmentCompactIdentity = Schema.Struct({
  host: HostId,
  label: Schema.NonEmptyTrimmedString,
  detail: Schema.NonEmptyTrimmedString,
  status: EnvironmentCompactStatus,
}).annotations(strict);
export type EnvironmentCompactIdentity = typeof EnvironmentCompactIdentity.Type;

export const EnvironmentSectionId = Schema.Literal(
  "project-context",
  "memory",
  "attachments",
  "sources",
  "recap",
  "git",
  "changes",
  "checkout",
  "branch",
  "commit-readiness",
  "local-servers",
  "repository",
  "editor-handoff",
  "notepad",
  "project-instructions",
  "browser-sessions",
  "confined-root",
  "artifacts",
  "approvals",
);
export type EnvironmentSectionId = typeof EnvironmentSectionId.Type;

export const EnvironmentSectionDescriptor = Schema.Struct({
  id: EnvironmentSectionId,
  label: Schema.NonEmptyTrimmedString,
  available: Schema.Boolean,
  unavailableReason: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations(strict);
export type EnvironmentSectionDescriptor = typeof EnvironmentSectionDescriptor.Type;

/**
 * Host-owned first-run state (`BOOT-01`).
 *
 * `pending` is the only state a clean store can produce, so a first run is
 * detected from projected host state rather than from renderer storage. The
 * resolved states stay distinct because completing the walkthrough and
 * deliberately skipping it are different facts about the same host.
 */
export const FirstRunOnboardingStatus = Schema.Literal("pending", "completed", "skipped");
export type FirstRunOnboardingStatus = typeof FirstRunOnboardingStatus.Type;

export const ShellSettings = Schema.Struct({
  chatEnabled: Schema.Boolean,
  workEnabled: Schema.Boolean,
  sidebarWidth: SidebarWidth,
  contextSidebarWidth: ContextSidebarWidth,
  lastContextSurface: Schema.NullOr(ContextSurfaceId),
  sidebarMaterial: Schema.Literal("system", "opaque"),
  modeSwitcherPresentation: ModeSwitcherPresentation,
  projectViewSwitcherPresentation: Schema.optionalWith(ProjectViewSwitcherPresentation, {
    default: () => "dropdown" as const,
  }),
  sidebarBackground: Schema.optionalWith(SidebarBackground, {
    default: () => DEFAULT_SIDEBAR_BACKGROUND,
  }),
  environmentPresentationByMode: Schema.optionalWith(EnvironmentPresentationByMode, {
    default: () => DEFAULT_ENVIRONMENT_PRESENTATION_BY_MODE,
  }),
  firstRunOnboarding: Schema.optionalWith(FirstRunOnboardingStatus, {
    default: () => "pending" as const,
  }),
  // Navigator settings section. A store persisted before Navigator shipped
  // decodes to the empty section — both roles absent — which the snapshot
  // reports as `unconfigured` rather than inventing a default model.
  navigatorAssistant: Schema.optionalWith(NavigatorAssistantSettings, {
    default: () => ({}),
  }),
  // Who is using this host. A store persisted before profiles shipped decodes
  // to the empty profile rather than a name guessed from the OS account: the
  // host was never asked, and saying so is the honest reading.
  userProfile: Schema.optionalWith(UserProfile, {
    default: () => ({ accent: DEFAULT_AVATAR_ACCENT, avatar: DEFAULT_USER_AVATAR }),
  }),
}).annotations(strict);
export type ShellSettings = typeof ShellSettings.Type;

const WelcomeWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("welcome"),
  id: WorkspaceTabId,
  mode: OctantMode,
  title: Schema.NonEmptyTrimmedString,
}).annotations(strict);

const DraftThreadWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("draft-thread"),
  id: WorkspaceTabId,
  mode: OctantMode,
  title: Schema.NonEmptyTrimmedString,
  projectId: Schema.optional(ProjectId),
}).annotations(strict);

const SettingsWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("settings"),
  id: WorkspaceTabId,
  title: Schema.NonEmptyTrimmedString,
}).annotations(strict);

const UnavailableWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("unavailable"),
  id: WorkspaceTabId,
  title: Schema.NonEmptyTrimmedString,
  reason: Schema.NonEmptyTrimmedString,
}).annotations(strict);

const ProjectWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("project"),
  id: WorkspaceTabId,
  projectId: ProjectId,
  mode: OctantMode,
  title: Schema.NonEmptyTrimmedString,
}).annotations(strict);

const ChatThreadWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("chat-thread"),
  id: WorkspaceTabId,
  threadId: ChatThreadId,
  mode: Schema.Literal("chat"),
  title: Schema.NonEmptyTrimmedString,
}).annotations(strict);

const WorkThreadWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("work-thread"),
  id: WorkspaceTabId,
  threadId: WorkThreadId,
  mode: Schema.Literal("work"),
  title: Schema.NonEmptyTrimmedString,
  hostId: Schema.optional(HostId),
}).annotations(strict);

const CodeWorkspaceTabFields = {
  id: WorkspaceTabId,
  threadId: CodeThreadId,
  mode: Schema.Literal("code"),
  title: Schema.NonEmptyTrimmedString,
  hostId: Schema.optional(HostId),
} as const;

const CodeOverviewWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("code-overview"),
  ...CodeWorkspaceTabFields,
}).annotations(strict);

const CodeFileWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("code-file"),
  ...CodeWorkspaceTabFields,
  relativePath: CodeRelativePath,
}).annotations(strict);

const CodeDiffWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("code-diff"),
  ...CodeWorkspaceTabFields,
  relativePath: Schema.optional(CodeRelativePath),
}).annotations(strict);

const codeThreadSurface = <K extends string>(kind: K) =>
  Schema.Struct({ kind: Schema.Literal(kind), ...CodeWorkspaceTabFields }).annotations(strict);

const CodeTerminalWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("code-terminal"),
  ...CodeWorkspaceTabFields,
  /**
   * The one terminal process this tab shows. Each tab carries its own identity
   * so a second terminal is a second shell rather than a second view of the
   * first. Absent for a tab journaled before terminals had identities of their
   * own, which stays bound to the thread's original terminal.
   */
  terminalId: Schema.optional(CodeTerminalId),
}).annotations(strict);
const CodeTestWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("code-test"),
  ...CodeWorkspaceTabFields,
  testRunId: Schema.optional(CodeTestRunId),
}).annotations(strict);
const CodeGitWorkspaceTab = codeThreadSurface("code-git");
const CodePrWorkspaceTab = codeThreadSurface("code-pr");
const CodeLocalReviewWorkspaceTab = codeThreadSurface("code-local-review");
const AppleWorkbenchWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("apple-workbench"),
  ...CodeWorkspaceTabFields,
  projectPath: AppleProjectPath,
}).annotations(strict);

const BoundMode = Schema.Literal("work", "code");

const BrowserWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("browser"),
  id: WorkspaceTabId,
  mode: BoundMode,
  title: Schema.NonEmptyTrimmedString,
  threadId: Schema.optional(BrowserThreadId),
  /**
   * The one host-owned context this tab shows, when it was opened for a
   * specific one. A Local servers Open creates a context per server,
   * so the tab carries that identity and a second Open lands in its own tab
   * instead of taking over the first server's session. Absent for the ordinary
   * Browser surface, which stays one shared tab per thread.
   */
  contextId: Schema.optional(BrowserContextId),
}).annotations(strict);

const FilesWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("files"),
  id: WorkspaceTabId,
  mode: BoundMode,
  title: Schema.NonEmptyTrimmedString,
}).annotations(strict);

/**
 * The Side Chat tab: the ask-about lane for exactly one source thread.
 *
 * `sourceThreadId` is the tab's identity. The host's sidecar registry is keyed
 * by source thread, so persisting that id is what lets a restored tab reopen
 * the same sidecar instead of guessing which conversation it was.
 *
 * `sidecarThreadId` records which sidecar the tab was actually showing. It is
 * absent only until the host has answered the first open; once present, a
 * restore whose sidecar the host no longer knows can say so instead of
 * silently swapping in a fresh, empty conversation. The tab carries no
 * transcript, provider, or authority of its own: the sidecar is an ordinary
 * Chat thread and the host owns everything else about it.
 */
const SideChatWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("side-chat"),
  id: WorkspaceTabId,
  mode: OctantMode,
  title: Schema.NonEmptyTrimmedString,
  sourceThreadId: MentionableThreadId,
  sidecarThreadId: Schema.optional(ChatThreadId),
}).annotations(strict);

/**
 * A persistent preview tab. Carries only the opaque target identity the
 * renderer already received from the host preview service plus an optional
 * bounded viewer state for restoration. It never stores source bodies, raw
 * host paths, credentials, or authority tokens. On restore the host
 * reauthorizes the target against the active Project/mode/host and reopens
 * through the existing preview contracts; a missing, changed, revoked, or
 * offline source restores as an honest unavailable/stale placeholder.
 *
 * `boundCodeThreadId` carries the optional Code thread binding so the pure
 * authority policy can fail closed across worktrees within the same Code
 * Project; the host still enforces worktree containment.
 */
const PreviewWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("preview"),
  id: WorkspaceTabId,
  mode: OctantMode,
  title: Schema.NonEmptyTrimmedString,
  targetId: PreviewTargetId,
  projectId: ProjectId,
  hostId: PreviewHostId,
  targetKind: PreviewTargetKind,
  opaqueRef: PreviewOpaqueRef,
  displayName: PreviewDisplayName,
  viewerState: Schema.optional(PreviewViewerState),
  boundCodeThreadId: Schema.optional(CodeThreadId),
}).annotations(strict);

const CanvasWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("canvas"),
  id: WorkspaceTabId,
  mode: OctantMode,
  title: Schema.NonEmptyTrimmedString,
  canvasId: CanvasId,
  projectId: ProjectId,
  pinned: Schema.optional(Schema.Literal(true)),
}).annotations(strict);

export const WorkspaceTab = Schema.Union(
  WelcomeWorkspaceTab,
  DraftThreadWorkspaceTab,
  SettingsWorkspaceTab,
  UnavailableWorkspaceTab,
  ProjectWorkspaceTab,
  ChatThreadWorkspaceTab,
  WorkThreadWorkspaceTab,
  CodeOverviewWorkspaceTab,
  CodeFileWorkspaceTab,
  CodeDiffWorkspaceTab,
  CodeTerminalWorkspaceTab,
  CodeTestWorkspaceTab,
  CodeGitWorkspaceTab,
  CodePrWorkspaceTab,
  CodeLocalReviewWorkspaceTab,
  AppleWorkbenchWorkspaceTab,
  BrowserWorkspaceTab,
  FilesWorkspaceTab,
  SideChatWorkspaceTab,
  PreviewWorkspaceTab,
  CanvasWorkspaceTab,
);
export type WorkspaceTab = typeof WorkspaceTab.Type;

export interface WorkspaceTabGroup {
  readonly kind: "group";
  readonly nodeId: LayoutNodeId;
  readonly groupId: TabGroupId;
  readonly tabs: ReadonlyArray<WorkspaceTab>;
  readonly activeTabId: WorkspaceTabId;
}

export interface WorkspaceSplit {
  readonly kind: "split";
  readonly nodeId: LayoutNodeId;
  readonly orientation: "horizontal" | "vertical";
  readonly ratio: SplitRatio;
  readonly first: WorkspaceLayoutNode;
  readonly second: WorkspaceLayoutNode;
}

export type WorkspaceLayoutNode = WorkspaceTabGroup | WorkspaceSplit;

interface EncodedWorkspaceTabGroup {
  readonly kind: "group";
  readonly nodeId: string;
  readonly groupId: string;
  readonly tabs: ReadonlyArray<typeof WorkspaceTab.Encoded>;
  readonly activeTabId: string;
}

interface EncodedWorkspaceSplit {
  readonly kind: "split";
  readonly nodeId: string;
  readonly orientation: "horizontal" | "vertical";
  readonly ratio: number;
  readonly first: EncodedWorkspaceLayoutNode;
  readonly second: EncodedWorkspaceLayoutNode;
}

type EncodedWorkspaceLayoutNode = EncodedWorkspaceTabGroup | EncodedWorkspaceSplit;

export const WorkspaceLayoutNode: Schema.Schema<WorkspaceLayoutNode, EncodedWorkspaceLayoutNode> =
  Schema.suspend(() =>
    Schema.Union(
      Schema.Struct({
        kind: Schema.Literal("group"),
        nodeId: LayoutNodeId,
        groupId: TabGroupId,
        tabs: Schema.Array(WorkspaceTab),
        activeTabId: WorkspaceTabId,
      }).annotations(strict),
      Schema.Struct({
        kind: Schema.Literal("split"),
        nodeId: LayoutNodeId,
        orientation: Schema.Literal("horizontal", "vertical"),
        ratio: SplitRatio,
        first: WorkspaceLayoutNode,
        second: WorkspaceLayoutNode,
      }).annotations(strict),
    ),
  );

export const StowedWorkspaceLayout = Schema.Struct({
  context: WorkspaceContextKey,
  layout: WorkspaceLayoutNode,
  activeGroupId: TabGroupId,
}).annotations(strict);
export type StowedWorkspaceLayout = typeof StowedWorkspaceLayout.Type;

export const WindowWorkspace = Schema.Struct({
  windowId: WindowId,
  activeMode: OctantMode,
  layouts: Schema.Struct({
    chat: WorkspaceLayoutNode,
    work: WorkspaceLayoutNode,
    code: WorkspaceLayoutNode,
  }).annotations(strict),
  activeGroupIds: Schema.Struct({
    chat: TabGroupId,
    work: TabGroupId,
    code: TabGroupId,
  }).annotations(strict),
  contextByMode: Schema.Struct({
    chat: WorkspaceContextKey,
    work: WorkspaceContextKey,
    code: WorkspaceContextKey,
  }).annotations(strict),
  stowedLayouts: Schema.optionalWith(
    Schema.Array(StowedWorkspaceLayout).pipe(Schema.maxItems(MAX_STOWED_WORKSPACE_LAYOUTS)),
    { default: () => [] },
  ),
  focusedGroupId: Schema.optional(TabGroupId),
  version: AggregateVersion,
}).annotations(strict);
export type WindowWorkspace = typeof WindowWorkspace.Type;

export const ShellBootstrap = Schema.Struct({
  settings: ShellSettings,
  workspace: WindowWorkspace,
  availableSurfaces: WorkspaceSurfaceCatalog,
  environmentPresentation: EnvironmentPresentationState,
  connectionStatus: Schema.Literal("connected"),
  settingsVersion: AggregateVersion,
  workspaceVersion: AggregateVersion,
  presentationVersion: AggregateVersion,
}).annotations(strict);
export type ShellBootstrap = typeof ShellBootstrap.Type;

const ModeOperationFields = { mode: OctantMode } as const;

export const WorkspaceOperation = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("open-tab"),
    ...ModeOperationFields,
    groupId: TabGroupId,
    tab: WorkspaceTab,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("switch-project-tab"),
    ...ModeOperationFields,
    tab: WorkspaceTab,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("activate-tab"),
    ...ModeOperationFields,
    groupId: TabGroupId,
    tabId: WorkspaceTabId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("close-tab"),
    ...ModeOperationFields,
    groupId: TabGroupId,
    tabId: WorkspaceTabId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("reorder-tab"),
    ...ModeOperationFields,
    groupId: TabGroupId,
    tabId: WorkspaceTabId,
    index: Schema.Int.pipe(Schema.nonNegative()),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("split-group"),
    ...ModeOperationFields,
    groupId: TabGroupId,
    tabId: WorkspaceTabId,
    splitNodeId: LayoutNodeId,
    newGroupNodeId: LayoutNodeId,
    newGroupId: TabGroupId,
    orientation: Schema.Literal("horizontal", "vertical"),
    placement: Schema.Literal("before", "after"),
    ratio: SplitRatio,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("move-tab"),
    ...ModeOperationFields,
    fromGroupId: TabGroupId,
    toGroupId: TabGroupId,
    tabId: WorkspaceTabId,
    index: Schema.Int.pipe(Schema.nonNegative()),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("dock-tab"),
    ...ModeOperationFields,
    fromGroupId: TabGroupId,
    targetGroupId: TabGroupId,
    tabId: WorkspaceTabId,
    splitNodeId: LayoutNodeId,
    newGroupNodeId: LayoutNodeId,
    newGroupId: TabGroupId,
    orientation: Schema.Literal("horizontal", "vertical"),
    placement: Schema.Literal("before", "after"),
    ratio: SplitRatio,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("resize-split"),
    ...ModeOperationFields,
    splitNodeId: LayoutNodeId,
    ratio: SplitRatio,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("focus-group"),
    ...ModeOperationFields,
    groupId: TabGroupId,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("unfocus-group"), ...ModeOperationFields }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("reset-mode"), ...ModeOperationFields }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("set-active-mode"), ...ModeOperationFields }).annotations(
    strict,
  ),
  Schema.Struct({
    kind: Schema.Literal("set-canvas-tab-pin"),
    ...ModeOperationFields,
    groupId: TabGroupId,
    tabId: WorkspaceTabId,
    pinned: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("set-side-chat-sidecar"),
    ...ModeOperationFields,
    groupId: TabGroupId,
    tabId: WorkspaceTabId,
    sidecarThreadId: ChatThreadId,
  }).annotations(strict),
);
export type WorkspaceOperation = typeof WorkspaceOperation.Type;

export const ShellCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("replace-settings"),
    windowId: WindowId,
    expectedVersion: AggregateVersion,
    settings: ShellSettings,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("apply-workspace-operation"),
    windowId: WindowId,
    expectedVersion: AggregateVersion,
    operation: WorkspaceOperation,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("set-environment-presentation"),
    windowId: WindowId,
    expectedVersion: AggregateVersion,
    presentation: EnvironmentPresentationState,
  }).annotations(strict),
);
export type ShellCommand = typeof ShellCommand.Type;

export const ShellCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("settings-replaced"),
    settings: ShellSettings,
    version: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("workspace-replaced"),
    workspace: WindowWorkspace,
    version: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("environment-presentation-replaced"),
    presentation: EnvironmentPresentationState,
    version: AggregateVersion,
  }).annotations(strict),
);
export type ShellCommandResult = typeof ShellCommandResult.Type;

const FailureMessage = Schema.NonEmptyTrimmedString;
export const ShellFailure = Schema.Union(
  Schema.Struct({ category: Schema.Literal("invalid"), message: FailureMessage }).annotations(
    strict,
  ),
  Schema.Struct({ category: Schema.Literal("unsupported"), message: FailureMessage }).annotations(
    strict,
  ),
  Schema.Struct({
    category: Schema.Literal("conflict"),
    message: FailureMessage,
    expectedVersion: AggregateVersion,
    actualVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({ category: Schema.Literal("unavailable"), message: FailureMessage }).annotations(
    strict,
  ),
  Schema.Struct({
    category: Schema.Literal("cross-context"),
    message: FailureMessage,
    offerNewWindow: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("recovery-required"),
    message: FailureMessage,
  }).annotations(strict),
);
export type ShellFailure = typeof ShellFailure.Type;

export const ShellSettingsReplaced = Schema.Struct({ settings: ShellSettings }).annotations(strict);
export type ShellSettingsReplaced = typeof ShellSettingsReplaced.Type;

export const WorkspaceLayoutReplaced = Schema.Struct({ workspace: WindowWorkspace }).annotations(
  strict,
);
export type WorkspaceLayoutReplaced = typeof WorkspaceLayoutReplaced.Type;

export const EnvironmentPresentationReplaced = Schema.Struct({
  presentation: EnvironmentPresentationState,
}).annotations(strict);
export type EnvironmentPresentationReplaced = typeof EnvironmentPresentationReplaced.Type;

export const decodeWindowId = Schema.decodeUnknownSync(WindowId);
export const decodeLayoutNodeId = Schema.decodeUnknownSync(LayoutNodeId);
export const decodeTabGroupId = Schema.decodeUnknownSync(TabGroupId);
export const decodeWorkspaceTabId = Schema.decodeUnknownSync(WorkspaceTabId);
export const decodeWorkspaceContextKey = Schema.decodeUnknownSync(WorkspaceContextKey);
export const decodeWorkspaceSurfaceDescriptor = Schema.decodeUnknownSync(
  WorkspaceSurfaceDescriptor,
);
export const decodeWorkspaceSurfaceCatalog = Schema.decodeUnknownSync(WorkspaceSurfaceCatalog);
export const decodeShellSettings = Schema.decodeUnknownSync(ShellSettings);
export const decodeWorkspaceTab = Schema.decodeUnknownSync(WorkspaceTab);
export const decodeWorkspaceLayoutNode = Schema.decodeUnknownSync(WorkspaceLayoutNode);
export const decodeWindowWorkspace = Schema.decodeUnknownSync(WindowWorkspace);
export const decodeShellBootstrap = Schema.decodeUnknownSync(ShellBootstrap);
export const decodeWorkspaceOperation = Schema.decodeUnknownSync(WorkspaceOperation);
export const decodeShellCommand = Schema.decodeUnknownSync(ShellCommand);
export const decodeShellCommandResult = Schema.decodeUnknownSync(ShellCommandResult);
export const decodeShellFailure = Schema.decodeUnknownSync(ShellFailure);
export const decodeShellSettingsReplaced = Schema.decodeUnknownSync(ShellSettingsReplaced);
export const decodeWorkspaceLayoutReplaced = Schema.decodeUnknownSync(WorkspaceLayoutReplaced);
export const decodeEnvironmentPresentation = Schema.decodeUnknownSync(EnvironmentPresentation);
export const decodeEnvironmentPinnedWidth = Schema.decodeUnknownSync(EnvironmentPinnedWidth);
export const decodeEnvironmentTabPresentation = Schema.decodeUnknownSync(
  EnvironmentTabPresentation,
);
export const decodeEnvironmentPresentationByMode = Schema.decodeUnknownSync(
  EnvironmentPresentationByMode,
);
export const decodeEnvironmentPresentationState = Schema.decodeUnknownSync(
  EnvironmentPresentationState,
);
export const decodeEnvironmentCompactIdentity = Schema.decodeUnknownSync(
  EnvironmentCompactIdentity,
);
export const decodeEnvironmentSectionDescriptor = Schema.decodeUnknownSync(
  EnvironmentSectionDescriptor,
);
export const decodeEnvironmentPresentationReplaced = Schema.decodeUnknownSync(
  EnvironmentPresentationReplaced,
);
