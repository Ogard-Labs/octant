import { Effect, Schema, SchemaTransformation } from "effect";
import { NonEmptyTrimmedString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AppReleaseRing } from "./appUpdates";

import { AppleProjectPath } from "./appleToolchain";
import { AgentRunId, AgentRunParentThreadId } from "./agentRun";
import { ChatThreadId } from "./chat";
import { CodeProjectFilePath, CodeTerminalId, CodeTestRunId, CodeThreadId } from "./code";
import { WorkThreadId } from "./workThreads";
import {
  BrowserContextId,
  BrowserThreadId,
  DEFAULT_BROWSER_TRANSFER_FILE_LIMIT_MEGABYTES,
  MAX_BROWSER_HELD_DOWNLOADS,
  MAX_BROWSER_HELD_DOWNLOAD_LIMIT,
  MAX_BROWSER_UPLOAD_FILES,
  MAX_BROWSER_UPLOAD_FILE_COUNT_LIMIT,
  MAX_BROWSER_TRANSFER_FILE_LIMIT_MEGABYTES,
  DEFAULT_BROWSER_WAIT_LIMIT_MINUTES,
  MAX_BROWSER_WAIT_LIMIT_MINUTES_SETTING,
} from "./browserAutomation";
import {
  DEFAULT_BROWSER_CAPTURES_PER_THREAD,
  MAX_BROWSER_CAPTURES_PER_THREAD,
} from "./browserCapture";
import { StoredBrowserProfile } from "./browserProfiles";
import { HomeActivityCustomization } from "./codeHomeActivity";
import {
  CODE_PROJECT_PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS,
  CODE_PROJECT_PULL_REQUEST_WATCH_LIFETIME_DAYS,
  CODE_PROJECT_PULL_REQUEST_WATCH_MAX_WAKES,
  DEFAULT_CHILD_RUN_WAIT_LIMIT_SECONDS,
  DEFAULT_FOLLOW_UP_LATENESS_LIMIT_HOURS,
  DEFAULT_SHIELD_DENIALS_IN_A_ROW,
  DEFAULT_SHIELD_DENIALS_PER_THREAD,
  DEFAULT_TOOLING_COMMAND_CONFIRM_MINUTES,
  MAX_FOLLOW_UP_LATENESS_LIMIT_HOURS_SETTING,
  MAX_SHIELD_DENIALS_IN_A_ROW_SETTING,
  MAX_SHIELD_DENIALS_PER_THREAD_SETTING,
  MAX_TOOLING_COMMAND_CONFIRM_MINUTES_SETTING,
  DEFAULT_COORDINATOR_ROUNDS,
  DEFAULT_COORDINATOR_WAKES_PER_HOUR,
  DEFAULT_SIBLING_THREAD_READS_PER_TURN,
  DEFAULT_SIBLING_THREAD_WAITS_PER_TURN,
  DEFAULT_THREAD_MESSAGES_PER_TURN,
  DEFAULT_THREAD_WAKEUPS_WAITING,
  MAX_CHILD_RUN_WAIT_LIMIT_SECONDS_SETTING,
  MAX_CODE_PROJECT_PULL_REQUEST_AUTO_FIX_ATTEMPTS_SETTING,
  MAX_CODE_PROJECT_PULL_REQUEST_WATCH_DAYS_SETTING,
  MAX_CODE_PROJECT_PULL_REQUEST_WATCH_WAKES_SETTING,
  MAX_COORDINATOR_ROUNDS,
  MAX_COORDINATOR_WAKES_PER_HOUR,
  MAX_COORDINATORS_PER_PROJECT,
  MAX_COORDINATORS_PER_PROJECT_SETTING,
  MAX_SIBLING_THREAD_READS_PER_TURN_SETTING,
  MAX_SIBLING_THREAD_WAITS_PER_TURN_SETTING,
  MAX_THREAD_MESSAGES_PER_TURN_SETTING,
  MAX_THREAD_WAKEUPS_WAITING_SETTING,
} from "./octantLimits";
import {
  DEFAULT_RUNTIME_TURNS_PER_TURN,
  DEFAULT_THREAD_TOOL_STEPS_PER_TURN,
  MAX_RUNTIME_TURNS_PER_TURN_SETTING,
  MAX_THREAD_TOOL_STEPS_SETTING,
} from "./threadToolSteps";
import { AggregateVersion, EventActor, UtcTimestamp } from "./events";
import { DEFAULT_PAIRED_DEVICE_LIFETIME, PairedDeviceLifetime } from "./remoteAccess";
import { HostId, LOCAL_HOST_ID } from "./host";
import { OctantMode } from "./modes";
import { ProviderInstanceId, ProviderModelId } from "./providers";
import { ProjectId } from "./projects";
import { ThreadBoardPullRequestIdentity } from "./threadBoardPullRequests";
import { CanvasId } from "./canvas";
import {
  AutoCompactIdleMinutes,
  AutoCompactLimitPercent,
  AutoCompactWindowPercent,
} from "./context";
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
import { VoiceSettings } from "./speech";
import { ImageGenerationSettings } from "./imageGeneration";
import { VideoGenerationSettings } from "./videoGeneration";
import { ComputerUseSettings } from "./computerUseSettings";
import { DEFAULT_AVATAR_ACCENT, DEFAULT_USER_AVATAR, UserProfile } from "./userProfile";
import { SidebarBackground, DEFAULT_SIDEBAR_BACKGROUND } from "./theme";

export const AppUpdateChannel = Schema.Literals(["stable", "preview", "nightly"]);
export type AppUpdateChannel = typeof AppUpdateChannel.Type;

/** Native menu contributions carry presentation and opaque action IDs only. */
export type NativeMenuEntry =
  | { readonly kind: "separator" }
  | {
      readonly kind: "item" | "checkbox" | "radio";
      readonly id: string;
      readonly label: string;
      readonly enabled: boolean;
      readonly checked?: boolean;
      readonly description?: string;
    }
  | {
      readonly kind: "submenu";
      readonly label: string;
      readonly enabled: boolean;
      readonly items: ReadonlyArray<NativeMenuEntry>;
    };

export interface NativeMenuRequest {
  readonly placement?: "above";
  readonly x: number;
  readonly y: number;
  readonly items: ReadonlyArray<NativeMenuEntry>;
}

export type NativeMenuOutcome =
  | { readonly kind: "selected"; readonly id: string }
  | { readonly kind: "dismissed" }
  | { readonly kind: "refused" };

export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 420;
export const MIN_CONTEXT_SIDEBAR_WIDTH = 280;
export const MAX_CONTEXT_SIDEBAR_WIDTH = 960;
/**
 * Height of the top strip the renderer keeps as a plain window-drag target
 * under macOS `hiddenInset`, which does not make the transparent top edge
 * draggable on its own. Remote/web clients have no native inset and keep the
 * zero-offset presentation.
 *
 * This strip is a drag affordance inside AppKit's default hiddenInset
 * container. A custom `trafficLightPosition` must not be set: Electron's
 * WindowButtonsProxy then resizes `NSTitlebarContainerView` to
 * `buttonHeight + 2 * y`, stacking a native overlay above the renderer that
 * eats clicks in the compact title row. CSS `z-index` cannot beat that overlay.
 */
export const NATIVE_HIDDEN_INSET_TITLEBAR_HEIGHT = 24;

/**
 * Horizontal reserve for macOS traffic lights in the native leading row.
 * Shared by the sidebar and the collapsed-sidebar chrome so Show sidebar sits
 * where Hide sidebar was, rather than jumping after a wider spacer.
 */
export const NATIVE_TRAFFIC_LIGHT_LEADING_WIDTH = 74;
export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;

export const MAX_STOWED_WORKSPACE_LAYOUTS = 12;

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));

export const WindowId = brandedUuid("WindowId");
export type WindowId = typeof WindowId.Type;
export const LayoutNodeId = brandedUuid("LayoutNodeId");
export type LayoutNodeId = typeof LayoutNodeId.Type;
export const PaneId = brandedUuid("PaneId");
export type PaneId = typeof PaneId.Type;
export const WorkspaceTabId = brandedUuid("WorkspaceTabId");
export type WorkspaceTabId = typeof WorkspaceTabId.Type;

export { HostId, LOCAL_HOST_ID };

export const WorkspaceContextKey = Schema.Struct({
  host: HostId,
  mode: OctantMode,
  projectId: Schema.NullOr(ProjectId),
  boundRoot: Schema.NullOr(NonEmptyTrimmedString),
});
export type WorkspaceContextKey = typeof WorkspaceContextKey.Type;

export const WorkspaceSurfaceKind = Schema.Literals([
  "thread",
  "browser",
  "terminal",
  "files",
  "diff",
  "git-review",
  "side-chat",
]);
export type WorkspaceSurfaceKind = typeof WorkspaceSurfaceKind.Type;

export const WorkspaceSurfaceDescriptor = Schema.Struct({
  kind: WorkspaceSurfaceKind,
  label: NonEmptyTrimmedString,
  available: Schema.Boolean,
  unavailableReason: Schema.optional(NonEmptyTrimmedString),
});
export type WorkspaceSurfaceDescriptor = typeof WorkspaceSurfaceDescriptor.Type;

export const WorkspaceSurfaceCatalog = Schema.Struct({
  chat: Schema.Array(WorkspaceSurfaceDescriptor),
  work: Schema.Array(WorkspaceSurfaceDescriptor),
  code: Schema.Array(WorkspaceSurfaceDescriptor),
});
export type WorkspaceSurfaceCatalog = typeof WorkspaceSurfaceCatalog.Type;

export const SidebarWidth = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(MIN_SIDEBAR_WIDTH),
  Schema.isLessThanOrEqualTo(MAX_SIDEBAR_WIDTH),
);
export type SidebarWidth = typeof SidebarWidth.Type;

/**
 * A panel the right utility dock can remember as the last one shown. Retired
 * ids — Context, Project memory, Navigator, and earlier Environment/Plan
 * placements — stay in the literal so a stored preference still decodes; the
 * renderer refuses one it no longer offers and simply opens nothing.
 */
export const ContextSurfaceId = Schema.Literals([
  "context",
  "project-memory",
  "code-environment",
  "navigator",
  "plan",
  "thread",
]);
export type ContextSurfaceId = typeof ContextSurfaceId.Type;

export const ContextSidebarWidth = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(MIN_CONTEXT_SIDEBAR_WIDTH),
  Schema.isLessThanOrEqualTo(MAX_CONTEXT_SIDEBAR_WIDTH),
);
export type ContextSidebarWidth = typeof ContextSidebarWidth.Type;

export const SplitRatio = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(MIN_SPLIT_RATIO),
  Schema.isLessThanOrEqualTo(MAX_SPLIT_RATIO),
);
export type SplitRatio = typeof SplitRatio.Type;

export const ModeSwitcherPresentation = Schema.Literals(["buttons", "dropdown"]);
export type ModeSwitcherPresentation = typeof ModeSwitcherPresentation.Type;

/** How the sidebar offers its thread filter: behind an icon, or always shown. */
export const SidebarSearchPresentation = Schema.Literals(["icon", "field"]);
export type SidebarSearchPresentation = typeof SidebarSearchPresentation.Type;

/** What a collapsed sidebar becomes: an icon rail, or hidden outright. */
/**
 * Where the icon rail shows: beside the open sidebar and in its place when it
 * is hidden (`always`), only in place of a hidden sidebar (`rail`), or never
 * (`hidden`). The rail beside the sidebar carries the destinations and counts,
 * so the sidebar itself is left to threads and Projects.
 */
export const SidebarCollapsedPresentation = Schema.Literals(["always", "rail", "hidden"]);
export type SidebarCollapsedPresentation = typeof SidebarCollapsedPresentation.Type;

/**
 * A destination the sidebar can offer, named for what the person using the
 * shell wants rather than for the per-mode row that renders it: one
 * "new-thread" destination covers the Chat, Work, and Code creators.
 */
export const SidebarDestinationId = Schema.Literals([
  "new-thread",
  "inbox",
  "todos",
  "board",
  "pull-requests",
  "github-issues",
  "linear-issues",
  "projects",
  "agents",
  "automations",
  "artifact-library",
  "image-library",
  "plugins",
]);
export type SidebarDestinationId = typeof SidebarDestinationId.Type;

export const SidebarDestinationVisibility = Schema.Literals(["shown", "hidden"]);
export type SidebarDestinationVisibility = typeof SidebarDestinationVisibility.Type;

export const SidebarDestinationPreference = Schema.Struct({
  id: SidebarDestinationId,
  visibility: SidebarDestinationVisibility,
});
export type SidebarDestinationPreference = typeof SidebarDestinationPreference.Type;

/**
 * How the person reordered and hid sidebar destinations. `order` lists
 * destinations in the requested row order; unlisted destinations follow the
 * shell's canonical order. A visibility entry exists only where the person
 * moved away from the default placement: primary rows show until hidden, and
 * workspace destinations stay in the account menu until promoted.
 */
export const SidebarDestinationCustomization = Schema.Struct({
  order: Schema.Array(SidebarDestinationId),
  visibility: Schema.Array(SidebarDestinationPreference),
}).check(
  Schema.makeFilter(
    (customization) =>
      new Set(customization.order).size === customization.order.length &&
      new Set(customization.visibility.map((entry) => entry.id)).size ===
        customization.visibility.length,
  ),
);
export type SidebarDestinationCustomization = typeof SidebarDestinationCustomization.Type;

/**
 * A card on the Work and Code start screens. An open vocabulary on purpose:
 * the renderer's card registry owns which cards exist, so adding a card never
 * touches this contract, and a card an older client does not know is simply
 * ignored by it.
 */
export const HomeCardId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]*$/),
  Schema.isMaxLength(48),
);
export type HomeCardId = typeof HomeCardId.Type;

export const HomeCardPreference = Schema.Struct({
  id: HomeCardId,
  visible: Schema.Boolean,
});
export type HomeCardPreference = typeof HomeCardPreference.Type;

/** More than any registry will hold; keeps a hostile or corrupt store bounded. */
export const MAX_HOME_CARDS = 32;

/**
 * How the person reordered and switched the start-screen cards. `order` lists
 * cards in the requested order; cards it does not name follow in the
 * registry's own order. A visibility entry exists only where the person moved
 * away from a card's default, so a card shipped later arrives with its own
 * default instead of being switched off by an old choice.
 */
export const HomeCardCustomization = Schema.Struct({
  order: Schema.Array(HomeCardId).check(Schema.isMaxLength(MAX_HOME_CARDS)),
  visibility: Schema.Array(HomeCardPreference).check(Schema.isMaxLength(MAX_HOME_CARDS)),
  /**
   * The activity cards' own choices — shared timeframe, source and pinned
   * ranges. Absent on stores written before the cards shipped; readers use
   * the domain's effective defaults rather than rewriting the record. The
   * four cards keep the home card ids `activity-prs-merged`,
   * `activity-issues-closed`, `activity-releases-published` and
   * `activity-runs` inside `order`/`visibility` like any other card.
   */
  activity: Schema.optional(HomeActivityCustomization),
}).check(
  Schema.makeFilter(
    (customization) =>
      new Set(customization.order).size === customization.order.length &&
      new Set(customization.visibility.map((entry) => entry.id)).size ===
        customization.visibility.length,
  ),
);
export type HomeCardCustomization = typeof HomeCardCustomization.Type;

/**
 * Which of the facts a sidebar thread row can carry beside its title are
 * shown, for one sidebar view.
 *
 * The choice is appearance, not authority: it changes what the same rows show
 * on every window and every client that reads this host, so it travels with
 * the shell defaults rather than living in one renderer's storage.
 */
export const SidebarRowPropertyVisibility = Schema.Struct({
  project: Schema.Boolean,
  branch: Schema.Boolean,
  pullRequest: Schema.Boolean,
  lastUpdated: Schema.Boolean,
  status: Schema.Boolean,
});
export type SidebarRowPropertyVisibility = typeof SidebarRowPropertyVisibility.Type;

/**
 * The two sidebar views answer different questions — where a thread lives
 * versus what happened lately — so each keeps its own record and quieting one
 * never strips the other.
 */
export const SidebarRowProperties = Schema.Struct({
  projects: SidebarRowPropertyVisibility,
  activity: SidebarRowPropertyVisibility,
});
export type SidebarRowProperties = typeof SidebarRowProperties.Type;

/**
 * Each view starts showing a short age beside the title: Activity is the view
 * that answers what happened lately, so it carries the age too. A saved choice
 * always wins over these defaults.
 */
export const DEFAULT_SIDEBAR_ROW_PROPERTIES: SidebarRowProperties = {
  projects: { project: false, branch: true, pullRequest: true, lastUpdated: true, status: true },
  activity: { project: true, branch: false, pullRequest: false, lastUpdated: true, status: true },
};

/** How the Code sidebar offers its saved project views: a dropdown or inline icon buttons. */
export const ProjectViewSwitcherPresentation = Schema.Literals(["dropdown", "inline"]);
export type ProjectViewSwitcherPresentation = typeof ProjectViewSwitcherPresentation.Type;

/**
 * How a thread tab presents its environment panel. The panel floats over the
 * thread or is hidden behind a reveal control; it never docks into the row.
 * A docked panel took width from the surface being read and presented live
 * status as shell chrome, which is not what the panel is for.
 */
export const EnvironmentPresentation = Schema.Literals(["floating", "hidden"]);
export type EnvironmentPresentation = typeof EnvironmentPresentation.Type;

export const EnvironmentTabPresentation = Schema.Struct({
  tabId: WorkspaceTabId,
  presentation: EnvironmentPresentation,
});
export type EnvironmentTabPresentation = typeof EnvironmentTabPresentation.Type;

export const EnvironmentPresentationByMode = Schema.Struct({
  chat: EnvironmentPresentation,
  work: EnvironmentPresentation,
  code: EnvironmentPresentation,
});
export type EnvironmentPresentationByMode = typeof EnvironmentPresentationByMode.Type;

export const EnvironmentPresentationState = Schema.Struct({
  byTab: Schema.Array(EnvironmentTabPresentation),
  byMode: EnvironmentPresentationByMode,
}).check(
  Schema.makeFilter(
    (state) => new Set(state.byTab.map((entry) => entry.tabId)).size === state.byTab.length,
  ),
);
export type EnvironmentPresentationState = typeof EnvironmentPresentationState.Type;

export const DEFAULT_ENVIRONMENT_PRESENTATION_BY_MODE: EnvironmentPresentationByMode = {
  chat: "hidden",
  work: "floating",
  code: "floating",
};

export const EnvironmentCompactStatus = Schema.Literals([
  "available",
  "unavailable",
  "stale",
  "disconnected",
  "recovery",
]);
export type EnvironmentCompactStatus = typeof EnvironmentCompactStatus.Type;

export const EnvironmentCompactIdentity = Schema.Struct({
  host: HostId,
  label: NonEmptyTrimmedString,
  detail: NonEmptyTrimmedString,
  status: EnvironmentCompactStatus,
});
export type EnvironmentCompactIdentity = typeof EnvironmentCompactIdentity.Type;

export const EnvironmentSectionId = Schema.Literals([
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
]);
export type EnvironmentSectionId = typeof EnvironmentSectionId.Type;

export const EnvironmentSectionDescriptor = Schema.Struct({
  id: EnvironmentSectionId,
  label: NonEmptyTrimmedString,
  available: Schema.Boolean,
  unavailableReason: Schema.optional(NonEmptyTrimmedString),
});
export type EnvironmentSectionDescriptor = typeof EnvironmentSectionDescriptor.Type;

/**
 * Host-owned first-run state.
 *
 * `pending` is the only state a clean store can produce, so a first run is
 * detected from projected host state rather than from renderer storage. The
 * resolved states stay distinct because completing the walkthrough and
 * deliberately skipping it are different facts about the same host.
 */
export const FirstRunOnboardingStatus = Schema.Literals(["pending", "completed", "skipped"]);
export type FirstRunOnboardingStatus = typeof FirstRunOnboardingStatus.Type;

export const OpenInApplicationId = Schema.Literals([
  "vscode",
  "cursor",
  "zed",
  "finder",
  "terminal",
  "ghostty",
  "xcode",
]);
export type OpenInApplicationId = typeof OpenInApplicationId.Type;

export const DEFAULT_OPEN_IN_APPLICATIONS: ReadonlyArray<OpenInApplicationId> = [
  "vscode",
  "cursor",
  "zed",
  "finder",
  "terminal",
  "ghostty",
  "xcode",
];

export const OpenInApplicationOrder = Schema.Array(OpenInApplicationId).check(
  Schema.makeFilter(
    (applications) =>
      applications.length <= DEFAULT_OPEN_IN_APPLICATIONS.length &&
      new Set(applications).size === applications.length,
  ),
);
export type OpenInApplicationOrder = typeof OpenInApplicationOrder.Type;

export const TranscriptTextSize = Schema.Literals(["small", "medium", "large"]);
export type TranscriptTextSize = typeof TranscriptTextSize.Type;
export const TranscriptWidth = Schema.Literals(["narrow", "medium", "wide"]);
export type TranscriptWidth = typeof TranscriptWidth.Type;
/** Retired: how the plan-usage meters drew their bar; stays so old rows decode. */
export const UsageBarStyle = Schema.Literals(["smooth", "pixelated"]);
export type UsageBarStyle = typeof UsageBarStyle.Type;
/**
 * How much of an agent's work a transcript shows open. Presentation only: it
 * never changes what is asked of a model or what a client fetches. Answers
 * only and Failures only sit below Low and hide steps rather than fold them.
 */
export const REPLY_DETAIL_LEVEL_VALUES = ["answers", "failures", "low", "medium", "high"] as const;
export const ReplyDetailLevel = Schema.Literals(REPLY_DETAIL_LEVEL_VALUES);
export type ReplyDetailLevel = typeof ReplyDetailLevel.Type;

/** One thread's own Reply detail level, which wins over the default. */
export const ThreadReplyDetail = Schema.Struct({
  mode: OctantMode,
  threadId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  level: ReplyDetailLevel,
});
export type ThreadReplyDetail = typeof ThreadReplyDetail.Type;

/**
 * How many threads may carry their own level. When the list is full, setting
 * one more drops the longest-standing choice, so the settings document stays
 * bounded however many threads a host has had.
 */
export const MAX_THREAD_REPLY_DETAILS = 500;
export const ThreadReplyDetails = Schema.Array(ThreadReplyDetail).check(
  Schema.isMaxLength(MAX_THREAD_REPLY_DETAILS),
  Schema.makeFilter(
    (entries) =>
      new Set(entries.map((entry) => `${entry.mode}:${entry.threadId}`)).size === entries.length,
    { message: "A thread carries at most one Reply detail level." },
  ),
);
export type ThreadReplyDetails = typeof ThreadReplyDetails.Type;

/**
 * The read a paired device makes to draw a thread at the person's level: the
 * default and the threads that chose their own. Presentation only; it is the
 * whole of what this route discloses from the host's shell settings.
 */
export const REPLY_DETAIL_PATH = "/api/reply-detail";

/**
 * A level as a device reads it: one this version does not know, such as a
 * level added after the device was built, reads as Low, the quiet level every
 * reader draws, instead of failing the whole answer and every thread's level
 * with it. The host's own settings stay strict.
 */
const ReadReplyDetailLevel = Schema.String.pipe(
  Schema.decodeTo(
    ReplyDetailLevel,
    SchemaTransformation.transform({
      decode: (value) => (Schema.is(ReplyDetailLevel)(value) ? value : "low"),
      encode: (level) => level,
    }),
  ),
);

export const ReplyDetailReading = Schema.Struct({
  defaultLevel: ReadReplyDetailLevel,
  threads: Schema.Array(
    Schema.Struct({ ...ThreadReplyDetail.fields, level: ReadReplyDetailLevel }),
  ).check(Schema.isMaxLength(MAX_THREAD_REPLY_DETAILS)),
});
export type ReplyDetailReading = typeof ReplyDetailReading.Type;
export const decodeReplyDetailReading = Schema.decodeUnknownSync(
  ReplyDetailReading,
  STRICT_DECODE_OPTIONS,
);

export const MIN_COMPLETED_THREAD_ARCHIVE_DAYS = 1;
export const MAX_COMPLETED_THREAD_ARCHIVE_DAYS = 365;
export const CompletedThreadArchiveAfterDays = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_COMPLETED_THREAD_ARCHIVE_DAYS,
    maximum: MAX_COMPLETED_THREAD_ARCHIVE_DAYS,
  }),
);
export type CompletedThreadArchiveAfterDays = typeof CompletedThreadArchiveAfterDays.Type;
export const DEFAULT_COMPLETED_THREAD_ARCHIVE_AFTER_DAYS: CompletedThreadArchiveAfterDays = 7;

/**
 * How long a turn may go without a provider event before the host cuts it
 * off. The floor keeps a slow first token or a long silent tool-call write
 * from ending a healthy turn; the ceiling is one working day.
 */
export const MIN_STALLED_TURN_LIMIT_MINUTES = 5;
export const MAX_STALLED_TURN_LIMIT_MINUTES = 480;
export const StalledTurnLimitMinutes = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_STALLED_TURN_LIMIT_MINUTES,
    maximum: MAX_STALLED_TURN_LIMIT_MINUTES,
  }),
);
export type StalledTurnLimitMinutes = typeof StalledTurnLimitMinutes.Type;
export const DEFAULT_STALLED_TURN_LIMIT_MINUTES: StalledTurnLimitMinutes = 30;

/**
 * The longest one provider tool call may pause the stalled-turn clock. A
 * runtime that reports a start and never the finish would otherwise hold its
 * turn open until the person stops it. The floor matches the stalled-turn
 * limit's; the ceiling is one day, past which Off is the honest choice.
 */
export const MIN_PROVIDER_TOOL_CALL_PAUSE_LIMIT_MINUTES = 5;
export const MAX_PROVIDER_TOOL_CALL_PAUSE_LIMIT_MINUTES = 1440;
export const ProviderToolCallPauseLimitMinutes = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_PROVIDER_TOOL_CALL_PAUSE_LIMIT_MINUTES,
    maximum: MAX_PROVIDER_TOOL_CALL_PAUSE_LIMIT_MINUTES,
  }),
);
export type ProviderToolCallPauseLimitMinutes = typeof ProviderToolCallPauseLimitMinutes.Type;
export const DEFAULT_PROVIDER_TOOL_CALL_PAUSE_LIMIT_MINUTES: ProviderToolCallPauseLimitMinutes = 120;

/**
 * How long a provider session may run only background work (a dev server, a
 * watch) after its turn, with no turn in the thread, before the host stops it
 * and its tasks. The floor matches the stalled-turn limit's; the ceiling is
 * one day.
 */
export const MIN_BACKGROUND_SESSION_IDLE_LIMIT_MINUTES = 5;
export const MAX_BACKGROUND_SESSION_IDLE_LIMIT_MINUTES = 1440;
export const BackgroundSessionIdleLimitMinutes = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_BACKGROUND_SESSION_IDLE_LIMIT_MINUTES,
    maximum: MAX_BACKGROUND_SESSION_IDLE_LIMIT_MINUTES,
  }),
);
export type BackgroundSessionIdleLimitMinutes = typeof BackgroundSessionIdleLimitMinutes.Type;
export const DEFAULT_BACKGROUND_SESSION_IDLE_LIMIT_MINUTES: BackgroundSessionIdleLimitMinutes = 120;
export const DEFAULT_AUTO_COMPACT_OCTANT_WINDOW_PERCENT: AutoCompactWindowPercent = 85;
export {
  DEFAULT_CHILD_RUN_WAIT_LIMIT_SECONDS,
  DEFAULT_FOLLOW_UP_LATENESS_LIMIT_HOURS,
  DEFAULT_SHIELD_DENIALS_IN_A_ROW,
  DEFAULT_SHIELD_DENIALS_PER_THREAD,
  DEFAULT_TOOLING_COMMAND_CONFIRM_MINUTES,
  MAX_FOLLOW_UP_LATENESS_LIMIT_HOURS_SETTING,
  MAX_SHIELD_DENIALS_IN_A_ROW_SETTING,
  MAX_SHIELD_DENIALS_PER_THREAD_SETTING,
  MAX_TOOLING_COMMAND_CONFIRM_MINUTES_SETTING,
  DEFAULT_SIBLING_THREAD_READS_PER_TURN,
  DEFAULT_SIBLING_THREAD_WAITS_PER_TURN,
  DEFAULT_THREAD_MESSAGES_PER_TURN,
  MAX_CHILD_RUN_WAIT_LIMIT_SECONDS_SETTING,
  MAX_SIBLING_THREAD_READS_PER_TURN_SETTING,
  MAX_SIBLING_THREAD_WAITS_PER_TURN_SETTING,
  MAX_THREAD_MESSAGES_PER_TURN_SETTING,
};

/**
 * An absolute folder path as the host canonicalized it. Same shape the
 * artifact mirror accepts for a folder the person names.
 */
export const DefaultFolder = Schema.Trimmed.pipe(
  Schema.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(4_096),
    Schema.makeFilter(
      (value) => !value.includes("\0") && (value.startsWith("/") || /^[A-Za-z]:\\/.test(value)),
    ),
  ),
  Schema.brand("DefaultFolder"),
);
export type DefaultFolder = typeof DefaultFolder.Type;

export const StandaloneSkillActivationState = Schema.Struct({
  reviewed: Schema.Boolean,
  trusted: Schema.Boolean,
  desiredEnabled: Schema.Boolean,
  /**
   * When a person last turned this skill on by hand. Absent for a skill that
   * is on by default or by a file written before the field existed, so the
   * host can tell a person's choice from a default when two same-named skills
   * are both on.
   */
  chosenAt: Schema.optional(UtcTimestamp),
  /**
   * The Project's same-named skill the host turned this one off for. Kept
   * until a person next switches either, so the notice survives a restart.
   */
  gaveWayTo: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024))),
});
export type StandaloneSkillActivationState = typeof StandaloneSkillActivationState.Type;

export const StandaloneSkillActivationMap = Schema.Record(
  Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
  StandaloneSkillActivationState,
);
export type StandaloneSkillActivationMap = typeof StandaloneSkillActivationMap.Type;

/** The key providers whose own skill folder a person can turn on. */
export const SKILL_FOLDER_PROVIDERS = ["claude", "codex"] as const;
export const SkillFolderProvider = Schema.Literals(SKILL_FOLDER_PROVIDERS);
export type SkillFolderProvider = typeof SkillFolderProvider.Type;

/** An absolute folder path with no relative segment, as a person typed or picked it. */
export const SkillFolderPath = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(1024),
  Schema.makeFilter(
    (path) =>
      (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) &&
      !path.split(/[\\/]/).includes("..") &&
      !path.includes("\0"),
    { message: "A skill folder is an absolute path with no .. segment." },
  ),
);
export const MAX_ADDED_SKILL_FOLDERS = 32;
export const SkillFolderSettings = Schema.Struct({
  providers: Schema.Array(SkillFolderProvider).check(
    Schema.isMaxLength(SKILL_FOLDER_PROVIDERS.length),
  ),
  folders: Schema.Array(SkillFolderPath).check(Schema.isMaxLength(MAX_ADDED_SKILL_FOLDERS)),
});
export type SkillFolderSettings = typeof SkillFolderSettings.Type;

/**
 * One "Remember for this Project" answer to a Computer use first-action
 * approval below Full access: later threads in that Project control that
 * application without asking again until the person forgets it in Settings.
 * Grows only through the approval decision path; a settings replacement may
 * only forget entries.
 */
export const RememberedComputerUseApp = Schema.Struct({
  projectId: ProjectId,
  appId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  grantedBy: EventActor,
  grantedAt: UtcTimestamp,
});
export type RememberedComputerUseApp = typeof RememberedComputerUseApp.Type;

/**
 * One "Remember for this Project" answer to an agent's file sent into a
 * disposable desktop on this machine below Full access: later sent-file asks
 * from threads in that Project send without asking until the person forgets
 * it in Settings. Grows only through the approval decision path; a settings
 * replacement may only forget entries.
 */
export const RememberedDesktopFileTransfer = Schema.Struct({
  projectId: ProjectId,
  grantedBy: EventActor,
  grantedAt: UtcTimestamp,
});
export type RememberedDesktopFileTransfer = typeof RememberedDesktopFileTransfer.Type;

/** One site remembered for one stored Browser profile; see `rememberedBrowserProfileSites`. */
export const RememberedBrowserProfileSite = Schema.Struct({
  origin: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
  profile: StoredBrowserProfile,
});
export type RememberedBrowserProfileSite = typeof RememberedBrowserProfileSite.Type;

/**
 * One "Always allow" answer to an agent's upload or download-save below Full
 * access: later transfers in that direction between that site and that
 * thread workspace, on a page in that Browser profile, do not ask. It never
 * covers the other direction, another site, another workspace, or another
 * profile, and it lifts no path, size or type check.
 */
export const RememberedBrowserTransfer = Schema.Struct({
  direction: Schema.Literals(["upload", "download"]),
  origin: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
  /** The thread workspace on this host: a Work Project folder or a Code checkout. */
  workspaceRoot: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
  /** The stored profile the page was in. Absent for a Private page. */
  profile: Schema.optional(StoredBrowserProfile),
  /**
   * Set on an answer given on a Private page, which covers Private pages
   * alone. An entry with neither this nor `profile` was remembered before
   * the page was recorded: it was given for the site and the folder on any
   * page, which is what it covered then, so it still covers every profile
   * and Private pages until the person forgets it. Narrowing it would ask
   * again for what they already answered, and no entry written since can be
   * mistaken for one.
   */
  privatePage: Schema.optional(Schema.Literal(true)),
}).check(Schema.makeFilter((entry) => entry.profile === undefined || entry.privatePage !== true));
export type RememberedBrowserTransfer = typeof RememberedBrowserTransfer.Type;

/** The next-message suggestion switch and the modes it covers. */
export const NextMessageSuggestionsSetting = Schema.Struct({
  enabled: Schema.Boolean,
  modes: Schema.Array(OctantMode).check(
    Schema.isMaxLength(3),
    Schema.makeFilter((modes) => new Set(modes).size === modes.length),
  ),
});
export type NextMessageSuggestionsSetting = typeof NextMessageSuggestionsSetting.Type;

export const ThreadTitleSource = Schema.Literals(["first-message", "api", "subscription"]);
export type ThreadTitleSource = typeof ThreadTitleSource.Type;

const ThreadTitleModel = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
});

export const ThreadTitleSettings = Schema.Struct({
  source: ThreadTitleSource,
  apiModel: Schema.optional(ThreadTitleModel),
  subscriptionModel: Schema.optional(ThreadTitleModel),
});
export type ThreadTitleSettings = typeof ThreadTitleSettings.Type;

/** How many host credentials one provider's pass-through list may name. */
export const MAX_PROVIDER_PASS_THROUGH = 64;

/**
 * The name of a host environment variable a person lets through to a provider.
 * Octant's own (`OCTANT_*`) never reach a provider, so the list cannot name one.
 */
export const HostCredentialName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
  Schema.makeFilter((name) => !name.toUpperCase().startsWith("OCTANT_")),
);

export const ShellSettings = Schema.Struct({
  chatEnabled: Schema.Boolean,
  workEnabled: Schema.Boolean,
  /**
   * Where Octant puts what nobody gave a home: Work and Code threads started
   * without a Project bind `<folder>/Work` and `<folder>/Code`, and artifact
   * files mirror under `<folder>/Artifacts` unless the mirror says otherwise.
   * Absent means the host's own default (`~/Octant`); the host fills it in on
   * read so every client sees the folder that is actually in effect. A window
   * saves settings whole, so its first save stores that filled-in folder, and
   * a stored folder stays put when the host default changes: installs that
   * saved settings while the default was `~/Documents/Octant` keep it.
   */
  defaultFolder: Schema.optional(DefaultFolder),
  /** Absent preserves streaming replies for existing installations. */
  streamReplies: Schema.optional(Schema.Boolean),
  /**
   * Whether a reply predicts the person's next message for the composer's Tab,
   * and in which modes. Absent means on in every mode.
   */
  nextMessageSuggestions: Schema.optional(NextMessageSuggestionsSetting),
  /** Absent keeps prompt-based titles. Remember each model across source changes. */
  threadTitles: Schema.optional(ThreadTitleSettings),
  sidebarWidth: SidebarWidth,
  contextSidebarWidth: ContextSidebarWidth,
  lastContextSurface: Schema.NullOr(ContextSurfaceId),
  sidebarMaterial: Schema.Literals(["system", "opaque"]),
  /**
   * Extends translucency from the sidebar to the workspace background.
   * Only takes effect when the sidebar itself
   * resolves translucent; a store persisted before this setting shipped
   * decodes to opaque, matching the workspace's prior always-solid look.
   */
  workspaceMaterial: Schema.Literals(["system", "opaque"]).pipe(
    Schema.withDecodingDefaultType(Effect.succeed("opaque" as const)),
  ),
  modeSwitcherPresentation: ModeSwitcherPresentation,
  projectViewSwitcherPresentation: ProjectViewSwitcherPresentation.pipe(
    Schema.withDecodingDefaultType(Effect.succeed("dropdown" as const)),
  ),
  sidebarBackground: SidebarBackground.pipe(
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_SIDEBAR_BACKGROUND)),
  ),
  /**
   * Which sidebar destinations are visible and in what order. A store
   * persisted before customization shipped decodes to the untouched shell:
   * default rows, workspace destinations in the account menu.
   */
  sidebarDestinations: SidebarDestinationCustomization.pipe(
    Schema.withDecodingDefaultType(Effect.sync(() => ({ order: [], visibility: [] }))),
  ),
  /**
   * Projects the person pinned to the icon rail, in the order they pinned
   * them. A pin names a Project by id; one for a Project that no longer exists
   * is ignored when the rail draws and dropped the next time pins are saved. A
   * store persisted before pins shipped decodes to none.
   */
  sidebarPinnedProjects: Schema.Array(ProjectId).pipe(
    Schema.check(
      Schema.makeFilter((ids) => new Set(ids).size === ids.length),
      Schema.isMaxLength(64),
    ),
    Schema.withDecodingDefaultType(Effect.sync(() => [])),
  ),
  /**
   * Whether the sidebar ends in a More row that reveals the destinations set
   * to "Menu only" (plus Customize sidebar) beside the rail. Off keeps them in
   * the account menu, the home they kept before the More row shipped. A store
   * persisted before this setting shipped decodes to on.
   */
  sidebarMoreEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(true))),
  /**
   * Whether Inbox, Running, To review, and Done today sit in the sidebar as
   * count tiles. Off keeps the plain Inbox and Board rows. A store persisted
   * before the tiles shipped decodes to on.
   */
  sidebarCountTiles: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(true))),
  /**
   * Whether the spend ceiling row shows on threads and Projects. A ceiling that
   * is set always shows, so this only hides the way to set the first one. A
   * store persisted before the setting shipped decodes to off.
   */
  spendCeilingShown: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(false))),
  /**
   * The sidebar's thread filter: an icon that opens a field, or a field that
   * is always there. A store persisted before the choice decodes to the icon.
   */
  sidebarSearchPresentation: SidebarSearchPresentation.pipe(
    Schema.withDecodingDefaultType(Effect.succeed("icon" as const)),
  ),
  /**
   * What Hide sidebar leaves behind: a narrow rail of icons, or nothing (the
   * window chrome then offers Show sidebar). A store persisted before the
   * rail shipped decodes to the rail.
   */
  sidebarCollapsedPresentation: SidebarCollapsedPresentation.pipe(
    Schema.withDecodingDefaultType(Effect.succeed("always" as const)),
  ),
  environmentPresentationByMode: EnvironmentPresentationByMode.pipe(
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_ENVIRONMENT_PRESENTATION_BY_MODE)),
  ),
  firstRunOnboarding: FirstRunOnboardingStatus.pipe(
    Schema.withDecodingDefaultType(Effect.succeed("pending" as const)),
  ),
  /**
   * Whether Octant may check for updates on its own. Off means no request is
   * made at all rather than a check whose answer is withheld — what leaves the
   * machine is the point of the switch. Off by default, including for a store
   * persisted before updates shipped: an unrecorded preference must not turn
   * into network traffic the person never asked for (data protection by
   * default). Turning the switch on records the choice explicitly.
   */
  automaticUpdateChecks: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(false))),
  /**
   * Whether the desktop app's quit keyboard shortcut needs a second press
   * before it quits. On by default, including for a store from before the
   * choice existed: the guard was always on then.
   */
  quitShortcutNeedsSecondPress: Schema.Boolean.pipe(
    Schema.withDecodingDefaultType(Effect.succeed(true)),
  ),
  computerUse: ComputerUseSettings.pipe(
    Schema.withDecodingDefaultType(Effect.sync(() => ({ enabled: true, automaticUpdates: true }))),
  ),
  /**
   * Whether Skills & Extensions marketplace search, inspect, and install may
   * contact skills.sh, the npm registry, or GitHub for catalog packages. Off
   * means no request is made — opening the Marketplace tab still does not
   * fetch, and Search / Inspect / install refuse rather than calling out. A
   * store persisted before this preference shipped decodes to on, matching the
   * prior always-on fetch posture when the person searched or inspected.
   */
  marketplaceFetchesEnabled: Schema.Boolean.pipe(
    Schema.withDecodingDefaultType(Effect.succeed(true)),
  ),
  /**
   * How long a put-away thread rests in the Put away shelf before the host
   * archives it. `null` means never. Archiving keeps everything and is the
   * only thing this timer does; a purge still needs its own confirmation.
   * A store persisted before completion shipped
   * decodes to the week the feature was introduced with.
   */
  completedThreadArchiveAfterDays: Schema.NullOr(CompletedThreadArchiveAfterDays).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_COMPLETED_THREAD_ARCHIVE_AFTER_DAYS)),
  ),
  /**
   * Whether a thread is put away once it is done: a Work or Code thread when
   * a person marks it Done, and a Code thread when its pull request merges.
   * Putting away only files the row in the Put away shelf; Reopen or a new
   * message brings it back. On by default, including for a store persisted
   * before the choice existed.
   */
  putAwayThreadsWhenDone: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(true))),
  /**
   * Compact a thread once its window is this full, for threads Octant keeps
   * the conversation of: Octant Harness, and Chat and Work on a direct
   * endpoint. Near a full window these otherwise only drop older exchanges
   * from what they send. `null` means never.
   */
  autoCompactOctantWindowPercent: Schema.NullOr(AutoCompactWindowPercent).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_AUTO_COMPACT_OCTANT_WINDOW_PERCENT)),
  ),
  /**
   * The same rule for threads a runtime keeps (Claude Code, Codex, and the
   * others), which compact by themselves at their own point. `null` leaves
   * that to the runtime.
   */
  autoCompactRuntimeWindowPercent: Schema.NullOr(AutoCompactWindowPercent).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  /**
   * Compact a thread once no turn has run on it for this many minutes, so the
   * next turn starts from a summary rather than re-reading a window whose
   * provider cache has long expired. `null`, the default, means never: a
   * compaction of a thread nobody returns to is pure cost.
   */
  autoCompactIdleMinutes: Schema.NullOr(AutoCompactIdleMinutes).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  /**
   * Compact a thread, and write a summary another provider can carry, once a
   * turn leaves its provider's account window (a 5-hour or weekly limit) at
   * least this used. `null`, the default, means never: the summary spends a
   * little of the limit that is running out.
   */
  autoCompactLimitPercent: Schema.NullOr(AutoCompactLimitPercent).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  /**
   * Cut a Chat, Work or Code turn off once its provider has sent no event for
   * this many minutes. `null` means never: only the person stops such a turn.
   * A store persisted before the setting existed decodes to the default.
   */
  stalledTurnLimitMinutes: Schema.NullOr(StalledTurnLimitMinutes).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_STALLED_TURN_LIMIT_MINUTES)),
  ),
  /**
   * The stalled-turn limit for a Work or Code turn at Full access outside
   * Strict. `null`, the default, means never, since at Full access Octant
   * adds no limit of its own; a turn under Strict keeps
   * {@link stalledTurnLimitMinutes} at every level. A store persisted before
   * the setting existed decodes to Off.
   */
  fullAccessStalledTurnLimitMinutes: Schema.NullOr(StalledTurnLimitMinutes).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  /**
   * The longest a provider tool call that has reported a start and no finish
   * pauses the stalled-turn clock, in minutes. `null` means no bound: such a
   * call pauses the clock until it finishes or the person stops the turn. A
   * store persisted before the setting existed decodes to the default.
   */
  providerToolCallPauseLimitMinutes: Schema.NullOr(ProviderToolCallPauseLimitMinutes).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_PROVIDER_TOOL_CALL_PAUSE_LIMIT_MINUTES)),
  ),
  /**
   * How long a session left running only background work after its turn is
   * kept with no turn in its thread, in minutes, before the host stops it.
   * `null` means no bound: the session stops when its tasks end, the person
   * stops the thread, or the host quits. A store persisted before the
   * setting existed decodes to the default.
   */
  backgroundSessionIdleLimitMinutes: Schema.NullOr(BackgroundSessionIdleLimitMinutes).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_BACKGROUND_SESSION_IDLE_LIMIT_MINUTES)),
  ),
  /**
   * Whether a provider launch outside Strict leaves the provider's own
   * telemetry (usage metrics, error reports, trace and feedback uploads) to
   * the provider's own settings. Off, Octant sets the provider's telemetry
   * guards as Strict does. Strict sets them whatever this says. Off by
   * default, including for a store persisted before the setting existed:
   * before it, every launch set the telemetry guards, and Octant sends
   * nothing to a vendor the person did not turn on.
   */
  providerTelemetry: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(false))),
  /**
   * Whether a provider launch outside Strict lets the provider check for and
   * install a newer version of itself. Off, the default, keeps every
   * self-update guard set, since Octant installs and updates provider CLIs
   * itself; Strict keeps them set whatever this says.
   */
  providerSelfUpdate: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(false))),
  /**
   * Host credentials the person lets through to one provider launched outside
   * Strict, keyed by the provider's driver kind (`claude`, `codex`, an ACP
   * agent's kind, `acp-agent` for every added ACP agent). Outside Strict a
   * provider does not inherit well-known credentials that are not its own
   * (`GH_TOKEN`, AWS keys, another service's `*_API_KEY`) unless its list here
   * names them. Strict ignores this. Names only, never values. Empty by
   * default, including for a store persisted before the setting existed.
   */
  providerCredentialPassThrough: Schema.Record(
    Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/)),
    Schema.Array(HostCredentialName).check(Schema.isMaxLength(MAX_PROVIDER_PASS_THROUGH)),
  ).pipe(Schema.withDecodingDefaultType(Effect.sync(() => ({})))),
  /**
   * How many wake-ups one thread may have waiting, missed ones included. A
   * store persisted before the setting existed decodes to the former fixed 8.
   */
  threadWakeupsWaitingLimit: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_THREAD_WAKEUPS_WAITING_SETTING })),
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_THREAD_WAKEUPS_WAITING)),
  ),
  /**
   * Whether a wake-up that came due while the host was down or asleep runs
   * once when the host is back. On by default: a wake-up the host slept
   * through otherwise never ran. Off journals it as missed and waits for the
   * person's Run now.
   */
  threadWakeupsRunMissedOnReturn: Schema.Boolean.pipe(
    Schema.withDecodingDefaultType(Effect.succeed(true)),
  ),
  /**
   * Whether the host arms a resume at the reset by itself when a provider's
   * usage limit stops a turn a person sent from this computer or a device
   * they paired, and the stop names its reset. Off, the default, a resume at
   * the reset is only ever the person's choice on that stop. Never a billing
   * stop, never a turn no person sent, never a provider that refuses the
   * host's continuations. Absent is off: the field carries no default so the
   * window's initial code stays inside its size budget.
   */
  usageLimitResumeAtResetByDefault: Schema.optional(Schema.Boolean),
  /** The same, for hiding the thread until the reset; it starts nothing. Absent is off. */
  usageLimitSnoozeUntilResetByDefault: Schema.optional(Schema.Boolean),
  /**
   * How many wake turns a message may start on one thread in any hour, and
   * the hop count past which a message is carried but wakes nothing, for a
   * thread whose coordinator set no bounds of its own. Default to the former
   * fixed values.
   */
  messageWakesPerHour: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_COORDINATOR_WAKES_PER_HOUR })),
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_COORDINATOR_WAKES_PER_HOUR)),
  ),
  messageWakeRounds: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_COORDINATOR_ROUNDS })),
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_COORDINATOR_ROUNDS)),
  ),
  /** How many coordinators one Code Project may hold, the planner included. */
  coordinatorsPerProject: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_COORDINATORS_PER_PROJECT_SETTING })),
    Schema.withDecodingDefaultType(Effect.succeed(MAX_COORDINATORS_PER_PROJECT)),
  ),
  /** Started wakes after which a pull-request watch ends. */
  pullRequestWatchWakeLimit: Schema.Int.pipe(
    Schema.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_CODE_PROJECT_PULL_REQUEST_WATCH_WAKES_SETTING }),
    ),
    Schema.withDecodingDefaultType(Effect.succeed(CODE_PROJECT_PULL_REQUEST_WATCH_MAX_WAKES)),
  ),
  /** Days after which a pull-request watch ends, counted from when it began. */
  pullRequestWatchDays: Schema.Int.pipe(
    Schema.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_CODE_PROJECT_PULL_REQUEST_WATCH_DAYS_SETTING }),
    ),
    Schema.withDecodingDefaultType(Effect.succeed(CODE_PROJECT_PULL_REQUEST_WATCH_LIFETIME_DAYS)),
  ),
  /** Auto-fix's automatic attempts on one failure before it hands back. */
  autoFixAttemptsPerFailure: Schema.Int.pipe(
    Schema.check(
      Schema.isBetween({
        minimum: 1,
        maximum: MAX_CODE_PROJECT_PULL_REQUEST_AUTO_FIX_ATTEMPTS_SETTING,
      }),
    ),
    Schema.withDecodingDefaultType(Effect.succeed(CODE_PROJECT_PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS)),
  ),
  /** Thread messages one turn may send to other threads under Strict. */
  threadMessagesPerTurn: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_THREAD_MESSAGES_PER_TURN_SETTING })),
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_THREAD_MESSAGES_PER_TURN)),
  ),
  /** Sibling-thread `read` calls one turn may make under Strict. */
  siblingThreadReadsPerTurn: Schema.Int.pipe(
    Schema.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_SIBLING_THREAD_READS_PER_TURN_SETTING }),
    ),
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_SIBLING_THREAD_READS_PER_TURN)),
  ),
  /** Sibling-thread `wait` calls one turn may make under Strict. */
  siblingThreadWaitsPerTurn: Schema.Int.pipe(
    Schema.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_SIBLING_THREAD_WAITS_PER_TURN_SETTING }),
    ),
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_SIBLING_THREAD_WAITS_PER_TURN)),
  ),
  /** The longest one Browser wait may last under Strict, in minutes. */
  browserWaitLimitMinutes: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_BROWSER_WAIT_LIMIT_MINUTES_SETTING })),
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_BROWSER_WAIT_LIMIT_MINUTES)),
  ),
  /** The longest one `wait` on a child run may block, in seconds. */
  childRunWaitLimitSeconds: Schema.Int.pipe(
    Schema.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_CHILD_RUN_WAIT_LIMIT_SECONDS_SETTING }),
    ),
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_CHILD_RUN_WAIT_LIMIT_SECONDS)),
  ),
  /** Shield denials in a row after which the next call goes to the person. */
  shieldDenialsInARow: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_SHIELD_DENIALS_IN_A_ROW_SETTING })),
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_SHIELD_DENIALS_IN_A_ROW)),
  ),
  /** Shield denials in one thread after which every call goes to the person. */
  shieldDenialsPerThread: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_SHIELD_DENIALS_PER_THREAD_SETTING })),
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_SHIELD_DENIALS_PER_THREAD)),
  ),
  /** How many hours late a follow-up may still run before it is recorded missed. */
  followUpLatenessLimitHours: Schema.Int.pipe(
    Schema.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_FOLLOW_UP_LATENESS_LIMIT_HOURS_SETTING }),
    ),
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_FOLLOW_UP_LATENESS_LIMIT_HOURS)),
  ),
  /** Minutes a shown provider command may still be run with "Run this command once". */
  toolingCommandConfirmMinutes: Schema.Int.pipe(
    Schema.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_TOOLING_COMMAND_CONFIRM_MINUTES_SETTING }),
    ),
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_TOOLING_COMMAND_CONFIRM_MINUTES)),
  ),
  /**
   * "Start agent-created routines active at Full access": a routine an agent
   * suggests while its turn runs at Full access starts enabled instead of
   * paused. On by default, since that level already lets the agent act
   * without asking; off keeps such a routine paused until the person enables
   * it.
   */
  agentRoutinesStartActiveAtFullAccess: Schema.Boolean.pipe(
    Schema.withDecodingDefaultType(Effect.succeed(true)),
  ),
  /**
   * The release ring to follow, once someone has chosen one.
   *
   * Deliberately without a default. A build already knows its own ring from
   * its version, and a default here would overrule it — a preview build would
   * quietly move itself to stable the first time these settings loaded. Absent
   * means "nobody has chosen", which the host reads as "follow the ring you
   * were built for".
   */
  releaseRing: Schema.optional(AppReleaseRing),
  /**
   * The update channel chosen in Settings. Two choices follow the same ring
   * (Preview and Nightly both sit on `candidate`), so the ring alone cannot
   * say which one was picked. Absent means "derive it from the ring":
   * `stable` is Stable and `candidate` is Preview.
   */
  updateChannel: Schema.optional(AppUpdateChannel),
  /** Enabled Open in applications, in the order shown by the native shell. */
  openInApplications: OpenInApplicationOrder.pipe(
    Schema.withDecodingDefaultType(Effect.sync(() => [...DEFAULT_OPEN_IN_APPLICATIONS])),
  ),
  transcriptTextSize: TranscriptTextSize.pipe(
    Schema.withDecodingDefaultType(Effect.succeed("small" as const)),
  ),
  transcriptWidth: TranscriptWidth.pipe(
    Schema.withDecodingDefaultType(Effect.succeed("medium" as const)),
  ),
  /** Retired: the plan-usage bar style, with the Inbox card (2026-11-18); stays optional so old rows decode. */
  usageBars: UsageBarStyle.pipe(Schema.withDecodingDefaultType(Effect.succeed("smooth" as const))),
  /**
   * How much of a turn's thinking and tool calls the transcript shows open.
   * A store persisted before the setting shipped decodes to low, the quiet
   * folding every transcript had before.
   */
  replyDetail: ReplyDetailLevel.pipe(
    Schema.withDecodingDefaultType(Effect.succeed("low" as const)),
  ),
  /**
   * Threads that chose their own Reply detail level. A thread not listed
   * follows `replyDetail`, so changing the default never moves a thread that
   * chose. A store persisted before per-thread levels shipped decodes to none.
   */
  threadReplyDetail: ThreadReplyDetails.pipe(Schema.withDecodingDefaultType(Effect.sync(() => []))),
  showThreadProviderIcons: Schema.Boolean.pipe(
    Schema.withDecodingDefaultType(Effect.succeed(true)),
  ),
  /**
   * Whether the quiet stats line (tokens, cache hit, speed, first-token time,
   * cost) sits under the composer of every thread. Off hides only the line:
   * the per-turn detail stays reachable from the context meter. A store
   * persisted before the line shipped decodes to on.
   */
  showThreadStats: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(true))),
  /**
   * Which start-screen cards show and in what order, per device. A store
   * persisted before the cards shipped decodes to the registry's own defaults.
   */
  homeCards: HomeCardCustomization.pipe(
    Schema.withDecodingDefaultType(Effect.sync(() => ({ order: [], visibility: [] }))),
  ),
  /**
   * Which facts each sidebar view's thread rows show. A store persisted before
   * this shipped decodes to each view's own defaults — exactly what those rows
   * carried already — so nothing disappears or appears for an existing
   * install.
   */
  sidebarRowProperties: SidebarRowProperties.pipe(
    Schema.withDecodingDefaultType(
      Effect.sync(() => ({
        projects: { ...DEFAULT_SIDEBAR_ROW_PROPERTIES.projects },
        activity: { ...DEFAULT_SIDEBAR_ROW_PROPERTIES.activity },
      })),
    ),
  ),
  // Navigator settings section. A store persisted before Navigator shipped
  // decodes to the empty section — both roles absent — which the snapshot
  // reports as `unconfigured` rather than inventing a default model.
  navigatorAssistant: NavigatorAssistantSettings.pipe(
    Schema.withDecodingDefaultType(Effect.sync(() => ({}))),
  ),
  // Voice settings section. A store persisted before voice shipped decodes to
  // the empty section — no transcription or synthesis endpoint — which the
  // speech status reports as `unconfigured` rather than guessing an endpoint.
  voice: VoiceSettings.pipe(Schema.withDecodingDefaultType(Effect.sync(() => ({})))),
  // Custom image-generation settings section. A store persisted before this
  // shipped decodes to no custom sources — the same OpenAI-compatible-only
  // reuse Voice already uses, so nothing here can point at an arbitrary URL.
  imageGeneration: ImageGenerationSettings.pipe(
    Schema.withDecodingDefaultType(Effect.sync(() => ({ customSources: [] }))),
  ),
  // A store persisted before video shipped decodes to no named profile, so
  // Full access uses the first ready video profile.
  videoGeneration: VideoGenerationSettings.pipe(
    Schema.withDecodingDefaultType(Effect.sync(() => ({}))),
  ),
  // Who is using this host. A store persisted before profiles shipped decodes
  // to the empty profile rather than a name guessed from the OS account: the
  // host was never asked, and saying so is the honest reading.
  userProfile: UserProfile.pipe(
    Schema.withDecodingDefaultType(
      Effect.sync(() => ({ accent: DEFAULT_AVATAR_ACCENT, avatar: DEFAULT_USER_AVATAR })),
    ),
  ),
  /**
   * Skill folders beyond the Project and user-global roots: a key provider's
   * own folder the person turned on, and folders they added by path. Each is
   * its own root under the same activation ladder, so nothing in one is
   * trusted or active because the folder is listed. Octant never adds one on
   * its own, and a store persisted before this shipped decodes to none.
   */
  skillFolders: SkillFolderSettings.pipe(
    Schema.withDecodingDefaultType(Effect.sync(() => ({ providers: [], folders: [] }))),
  ),
  // Review, trust, and enablement state for discovered/bundled skills.
  // Persisted before this shipped decodes to empty, so skills remain unavailable
  // until explicitly reviewed. The key is the source-qualified skill identity,
  // which embeds its content digest; any content change produces a new key and
  // the prior activation is automatically revoked.
  standaloneSkillActivations: StandaloneSkillActivationMap.pipe(
    Schema.withDecodingDefaultType(Effect.sync(() => ({}))),
  ),
  /**
   * Origins the person approved with "always allow" for the bundled Browser
   * tool. A remembered origin opens without asking again — the browsing
   * context is still confined to it — until the person forgets it in
   * Settings. A store persisted before this shipped decodes to none.
   */
  rememberedBrowserOrigins: Schema.Array(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
  ).pipe(Schema.withDecodingDefaultType(Effect.sync(() => []))),
  /**
   * Sites the person approved with "always allow" on a page in a Project or
   * Personal Browser profile. A pair, never an origin alone: a remembered
   * Private origin does not cover a signed-in page, and a pair for one profile
   * does not cover another. Grows only through the approval answer, like
   * `rememberedBrowserOrigins`. A pair whose origin is `ANY_BROWSER_ORIGIN` is
   * the answer "Allow all sites in this profile".
   */
  rememberedBrowserProfileSites: Schema.Array(RememberedBrowserProfileSite).pipe(
    Schema.check(Schema.isMaxLength(1_024)),
    Schema.withDecodingDefaultType(Effect.sync(() => [])),
  ),
  /**
   * "Let agents download files": whether a page the agent drives in its
   * Browser may start a download that the host holds for the agent to ask to
   * save. Off, every download is blocked as before. It is a host switch the
   * person sets from a local window; shell settings are written only through
   * the shell route, which a paired device, a routine, a subagent, a plugin,
   * and a terminal CLI cannot reach. A store persisted before this shipped
   * decodes to off.
   */
  agentBrowserDownloads: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(false))),
  /**
   * How many Browser captures each thread keeps, newest first. A host
   * setting like the switch above. A store persisted before this shipped
   * decodes to the default.
   */
  browserCapturesPerThread: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_BROWSER_CAPTURES_PER_THREAD })),
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_BROWSER_CAPTURES_PER_THREAD)),
  ),
  /**
   * Whether Chat and Work keep a bounded copy of each tool call's input and
   * output in purgeable storage. A host setting. Turning it off stops new
   * records and leaves the ones already kept, which go with their threads. A
   * store persisted before this shipped decodes to on.
   */
  keepToolCallRecords: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(true))),
  /**
   * How many tool calls one Chat or Work turn keeps as steps, and so keeps
   * records for, while it runs below Full access. A host setting. A turn
   * that calls more still runs; its later calls have no row. A store
   * persisted before this shipped decodes to the default.
   */
  toolStepsPerTurn: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_THREAD_TOOL_STEPS_SETTING })),
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_THREAD_TOOL_STEPS_PER_TURN)),
  ),
  /**
   * The same limit for a Work turn that runs at Full access. `0`, the
   * default, is off: every call is kept, and the spend ceiling is what
   * bounds the turn. A person may set a number here too.
   */
  fullAccessToolStepsPerTurn: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 0, maximum: MAX_THREAD_TOOL_STEPS_SETTING })),
    Schema.withDecodingDefaultType(Effect.succeed(0)),
  ),
  /**
   * How many turns a runtime may start by itself inside one person's turn
   * below Full access (a background command's end, a watch's line). Past it
   * the person's turn completes and the session is stopped. At Full access
   * there is no such count. A store persisted before this shipped decodes to
   * the default.
   */
  runtimeTurnsPerTurn: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_RUNTIME_TURNS_PER_TURN_SETTING })),
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_RUNTIME_TURNS_PER_TURN)),
  ),
  /**
   * The largest file, in megabytes, an agent may upload through a page or have
   * held and saved from one. A store persisted before this shipped decodes to
   * the former fixed limit.
   */
  browserTransferFileLimitMegabytes: Schema.Int.pipe(
    Schema.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_BROWSER_TRANSFER_FILE_LIMIT_MEGABYTES }),
    ),
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_BROWSER_TRANSFER_FILE_LIMIT_MEGABYTES)),
  ),
  /**
   * How many downloads one browsing context holds for the agent at once; the
   * oldest is discarded first. Decodes to the former fixed limit when absent.
   */
  browserHeldDownloadLimit: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_BROWSER_HELD_DOWNLOAD_LIMIT })),
    Schema.withDecodingDefaultType(Effect.succeed(MAX_BROWSER_HELD_DOWNLOADS)),
  ),
  /**
   * How many files an agent may send in one upload. Decodes to the former
   * fixed count when absent.
   */
  browserUploadFileCountLimit: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_BROWSER_UPLOAD_FILE_COUNT_LIMIT })),
    Schema.withDecodingDefaultType(Effect.succeed(MAX_BROWSER_UPLOAD_FILES)),
  ),
  /**
   * Uploads and download saves the person answered "Always allow". Grows only
   * through that approval answer, like `rememberedBrowserOrigins`; a settings
   * replacement may only forget entries.
   */
  rememberedBrowserTransfers: Schema.Array(RememberedBrowserTransfer).pipe(
    Schema.check(Schema.isMaxLength(1_024)),
    Schema.withDecodingDefaultType(Effect.sync(() => [])),
  ),
  /**
   * Applications the person approved with "Remember for this Project" for the
   * bundled Computer use tool below Full access. Grows only through the
   * approval decision path; a settings replacement may only forget entries.
   */
  rememberedComputerUseApps: Schema.Array(RememberedComputerUseApp).pipe(
    Schema.check(Schema.isMaxLength(1_024)),
    Schema.withDecodingDefaultType(Effect.sync(() => [])),
  ),
  /**
   * Projects whose agents' files into a disposable desktop on this machine
   * the person approved with "Remember for this Project" below Full access.
   * Grows only through the approval decision path; a settings replacement
   * may only forget entries.
   */
  rememberedDesktopFileTransfers: Schema.Array(RememberedDesktopFileTransfer).pipe(
    Schema.check(Schema.isMaxLength(1_024)),
    Schema.withDecodingDefaultType(Effect.sync(() => [])),
  ),
  /** Local opt-in; old grants never inherit a newly enabled native owner. */
  persistentBrowserOwner: Schema.Boolean.pipe(
    Schema.withDecodingDefaultType(Effect.succeed(false)),
  ),
  /**
   * How long a paired device stays paired, counted from its pairing. A host
   * setting; changing it moves every still-current registration's deadline
   * to its pairing time plus the new length. A store persisted before this
   * shipped decodes to the 30 days every registration was given.
   */
  pairedDeviceLifetime: PairedDeviceLifetime.pipe(
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_PAIRED_DEVICE_LIFETIME)),
  ),
});
export type ShellSettings = typeof ShellSettings.Type;

const WelcomeWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("welcome"),
  id: WorkspaceTabId,
  mode: OctantMode,
  title: NonEmptyTrimmedString,
});

const DraftThreadWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("draft-thread"),
  id: WorkspaceTabId,
  mode: OctantMode,
  title: NonEmptyTrimmedString,
  projectId: Schema.optional(ProjectId),
});

const SettingsWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("settings"),
  id: WorkspaceTabId,
  title: NonEmptyTrimmedString,
});

const ProjectWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("project"),
  id: WorkspaceTabId,
  projectId: ProjectId,
  mode: OctantMode,
  title: NonEmptyTrimmedString,
});

const ChatThreadWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("chat-thread"),
  id: WorkspaceTabId,
  threadId: ChatThreadId,
  mode: Schema.Literal("chat"),
  title: NonEmptyTrimmedString,
});

const WorkThreadWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("work-thread"),
  id: WorkspaceTabId,
  threadId: WorkThreadId,
  mode: Schema.Literal("work"),
  title: NonEmptyTrimmedString,
  hostId: Schema.optional(HostId),
});

const CodeWorkspaceTabFields = {
  id: WorkspaceTabId,
  threadId: CodeThreadId,
  mode: Schema.Literal("code"),
  title: NonEmptyTrimmedString,
  hostId: Schema.optional(HostId),
} as const;

const CodeOverviewWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("code-overview"),
  ...CodeWorkspaceTabFields,
});

const CodeFileWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("code-file"),
  ...CodeWorkspaceTabFields,
  relativePath: CodeProjectFilePath,
});

const codeThreadSurface = <K extends string>(kind: K) =>
  Schema.Struct({ kind: Schema.Literal(kind), ...CodeWorkspaceTabFields });

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
  /** The tab runs the thread's provider's own command-line program rather than a shell. */
  program: Schema.optional(Schema.Literal("provider")),
});
const CodeTestWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("code-test"),
  ...CodeWorkspaceTabFields,
  testRunId: Schema.optional(CodeTestRunId),
});
const CodeGitWorkspaceTab = codeThreadSurface("code-git");
/**
 * A Code thread's pull request tab. Without `pullRequest` it is the thread's
 * own delivery pull request, observed from its checkout. With it, it is one
 * pull request the thread worked on, drawn with the Pull requests page's
 * reading view; the identity only names it, and every read of it still goes
 * through the host's window-authorized pull-request routes.
 */
const CodePrWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("code-pr"),
  ...CodeWorkspaceTabFields,
  pullRequest: Schema.optional(ThreadBoardPullRequestIdentity),
});
const CodeLocalReviewWorkspaceTab = codeThreadSurface("code-local-review");
const AppleWorkbenchWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("apple-workbench"),
  ...CodeWorkspaceTabFields,
  projectPath: AppleProjectPath,
  /**
   * The dock's iOS Simulator tab is a device pane, not the full workbench.
   * Absent on the Apple workbench command, which stays the evidence surface.
   */
  pane: Schema.optional(Schema.Literal("device")),
});

const BoundMode = Schema.Literals(["work", "code"]);

const BrowserWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("browser"),
  id: WorkspaceTabId,
  mode: BoundMode,
  title: NonEmptyTrimmedString,
  threadId: Schema.optional(BrowserThreadId),
  /**
   * The one host-owned context this tab shows, when it was opened for a
   * specific one. A Local servers Open creates a context per server,
   * so the tab carries that identity and a second Open lands in its own tab
   * instead of taking over the first server's session. Absent for the ordinary
   * Browser surface, which stays one shared tab per thread.
   */
  contextId: Schema.optional(BrowserContextId),
});

const FilesWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("files"),
  id: WorkspaceTabId,
  mode: BoundMode,
  title: NonEmptyTrimmedString,
});

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
  title: NonEmptyTrimmedString,
  sourceThreadId: MentionableThreadId,
  sidecarThreadId: Schema.optional(ChatThreadId),
});

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
  title: NonEmptyTrimmedString,
  targetId: PreviewTargetId,
  projectId: ProjectId,
  hostId: PreviewHostId,
  targetKind: PreviewTargetKind,
  opaqueRef: PreviewOpaqueRef,
  displayName: PreviewDisplayName,
  viewerState: Schema.optional(PreviewViewerState),
  boundCodeThreadId: Schema.optional(CodeThreadId),
});

// A Canvas tab names the Project the Canvas belongs to, or `null` for a Chat
// Canvas that belongs to its thread alone; the host restores the latter
// against the Canvas itself rather than against the pane's Project context.
const CanvasWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("canvas"),
  id: WorkspaceTabId,
  mode: OctantMode,
  title: NonEmptyTrimmedString,
  canvasId: CanvasId,
  projectId: Schema.NullOr(ProjectId),
});

/**
 * A subagent opened as a thread of its own: its conversation, headed by the
 * thread that started it. It stores the two identities and its title only,
 * never the conversation or any authority; every read reauthorizes the run
 * against its parent thread, and a run that is gone or no longer readable
 * restores as an unavailable placeholder that links back to the parent.
 */
const AgentRunWorkspaceTab = Schema.Struct({
  kind: Schema.Literal("agent-run"),
  id: WorkspaceTabId,
  mode: OctantMode,
  title: NonEmptyTrimmedString,
  parentThreadId: AgentRunParentThreadId,
  runId: AgentRunId,
});

/**
 * The authoritative surface a pane shows. Still named `WorkspaceTab` because
 * persisted state addresses surfaces by this identity —
 * `EnvironmentTabPresentation.tabId` and every journaled layout carry
 * `WorkspaceTabId`s — and renaming the wire name would churn hundreds of call
 * sites without changing any behavior. A pane holds exactly one of these. A
 * renderer may layer window-local thread navigation above the pane tree, but
 * those entries are not hidden WorkspaceTabs and carry no authority.
 */
export const WorkspaceTab = Schema.Union([
  WelcomeWorkspaceTab,
  DraftThreadWorkspaceTab,
  SettingsWorkspaceTab,
  ProjectWorkspaceTab,
  ChatThreadWorkspaceTab,
  WorkThreadWorkspaceTab,
  CodeOverviewWorkspaceTab,
  CodeFileWorkspaceTab,
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
  AgentRunWorkspaceTab,
]);
export type WorkspaceTab = typeof WorkspaceTab.Type;

/**
 * A leaf of the split tree: one pane showing exactly one authoritative surface.
 * There are no hidden sibling surfaces. A renderer-local thread strip may
 * reopen recent conversations through the ordinary server command; it is not
 * part of this persisted layout.
 */
export interface WorkspacePane {
  readonly kind: "pane";
  readonly nodeId: LayoutNodeId;
  readonly paneId: PaneId;
  readonly surface: WorkspaceTab;
  /**
   * The pane's own authority context when its surface belongs to another
   * Project than the layout's lead. Absent means the lead's, so a layout of
   * one Project carries none and decodes as it always did. Only the host
   * writes it, from the surface it resolves; a renderer's claim is not read.
   */
  readonly context?: WorkspaceContextKey;
}

export interface WorkspaceSplit {
  readonly kind: "split";
  readonly nodeId: LayoutNodeId;
  readonly orientation: "horizontal" | "vertical";
  readonly ratio: SplitRatio;
  readonly first: WorkspaceLayoutNode;
  readonly second: WorkspaceLayoutNode;
}

export type WorkspaceLayoutNode = WorkspacePane | WorkspaceSplit;

interface EncodedWorkspacePane {
  readonly kind: "pane";
  readonly nodeId: string;
  readonly paneId: string;
  readonly surface: typeof WorkspaceTab.Encoded;
  readonly context?: typeof WorkspaceContextKey.Encoded;
}

interface EncodedWorkspaceSplit {
  readonly kind: "split";
  readonly nodeId: string;
  readonly orientation: "horizontal" | "vertical";
  readonly ratio: number;
  readonly first: EncodedWorkspaceLayoutNode;
  readonly second: EncodedWorkspaceLayoutNode;
}

type EncodedWorkspaceLayoutNode = EncodedWorkspacePane | EncodedWorkspaceSplit;

export const WorkspaceLayoutNode: Schema.Codec<WorkspaceLayoutNode, EncodedWorkspaceLayoutNode> =
  Schema.suspend(() =>
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("pane"),
        nodeId: LayoutNodeId,
        paneId: PaneId,
        surface: WorkspaceTab,
        context: Schema.optionalKey(WorkspaceContextKey),
      }),
      Schema.Struct({
        kind: Schema.Literal("split"),
        nodeId: LayoutNodeId,
        orientation: Schema.Literals(["horizontal", "vertical"]),
        ratio: SplitRatio,
        first: WorkspaceLayoutNode,
        second: WorkspaceLayoutNode,
      }),
    ]),
  );

export const StowedWorkspaceLayout = Schema.Struct({
  context: WorkspaceContextKey,
  layout: WorkspaceLayoutNode,
  activePaneId: PaneId,
});
export type StowedWorkspaceLayout = typeof StowedWorkspaceLayout.Type;

export const WindowWorkspace = Schema.Struct({
  windowId: WindowId,
  activeMode: OctantMode,
  layouts: Schema.Struct({
    chat: WorkspaceLayoutNode,
    work: WorkspaceLayoutNode,
    code: WorkspaceLayoutNode,
  }),
  activePaneIds: Schema.Struct({
    chat: PaneId,
    work: PaneId,
    code: PaneId,
  }),
  contextByMode: Schema.Struct({
    chat: WorkspaceContextKey,
    work: WorkspaceContextKey,
    code: WorkspaceContextKey,
  }),
  stowedLayouts: Schema.Array(StowedWorkspaceLayout).pipe(
    Schema.check(Schema.isMaxLength(MAX_STOWED_WORKSPACE_LAYOUTS)),
    Schema.withDecodingDefaultType(Effect.sync(() => [])),
  ),
  focusedPaneId: Schema.optional(PaneId),
  version: AggregateVersion,
});
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
});
export type ShellBootstrap = typeof ShellBootstrap.Type;

const ModeOperationFields = { mode: OctantMode } as const;

/**
 * The surface takes the whole window: every other pane of the mode's layout
 * closes in the same step. A new task asks for this, so a person who starts
 * one from a split is not handed half a window and a thread they did not ask
 * to keep beside it.
 */
const OpensAlone = Schema.optional(Schema.Literal(true));

export const WorkspaceOperation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("open-surface"),
    ...ModeOperationFields,
    paneId: PaneId,
    surface: WorkspaceTab,
    alone: OpensAlone,
  }),
  Schema.Struct({
    kind: Schema.Literal("switch-project-surface"),
    ...ModeOperationFields,
    surface: WorkspaceTab,
    alone: OpensAlone,
  }),
  Schema.Struct({
    kind: Schema.Literal("replace-pane-surface"),
    ...ModeOperationFields,
    paneId: PaneId,
    surface: WorkspaceTab,
  }),
  Schema.Struct({
    kind: Schema.Literal("split-pane"),
    ...ModeOperationFields,
    targetPaneId: PaneId,
    surface: WorkspaceTab,
    splitNodeId: LayoutNodeId,
    newPaneNodeId: LayoutNodeId,
    newPaneId: PaneId,
    orientation: Schema.Literals(["horizontal", "vertical"]),
    placement: Schema.Literals(["before", "after"]),
    ratio: SplitRatio,
  }),
  Schema.Struct({
    kind: Schema.Literal("close-pane"),
    ...ModeOperationFields,
    paneId: PaneId,
  }),
  Schema.Struct({
    kind: Schema.Literal("resize-split"),
    ...ModeOperationFields,
    splitNodeId: LayoutNodeId,
    ratio: SplitRatio,
  }),
  Schema.Struct({
    kind: Schema.Literal("focus-pane"),
    ...ModeOperationFields,
    paneId: PaneId,
  }),
  Schema.Struct({ kind: Schema.Literal("unfocus-pane"), ...ModeOperationFields }),
  Schema.Struct({ kind: Schema.Literal("reset-mode"), ...ModeOperationFields }),
  Schema.Struct({ kind: Schema.Literal("set-active-mode"), ...ModeOperationFields }),
  Schema.Struct({
    kind: Schema.Literal("set-side-chat-sidecar"),
    ...ModeOperationFields,
    paneId: PaneId,
    sidecarThreadId: ChatThreadId,
  }),
]);
export type WorkspaceOperation = typeof WorkspaceOperation.Type;

export const ShellCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("replace-settings"),
    windowId: WindowId,
    expectedVersion: AggregateVersion,
    settings: ShellSettings,
  }),
  Schema.Struct({
    kind: Schema.Literal("apply-workspace-operation"),
    windowId: WindowId,
    expectedVersion: AggregateVersion,
    operation: WorkspaceOperation,
  }),
  Schema.Struct({
    kind: Schema.Literal("set-environment-presentation"),
    windowId: WindowId,
    expectedVersion: AggregateVersion,
    presentation: EnvironmentPresentationState,
  }),
]);
export type ShellCommand = typeof ShellCommand.Type;

export const ShellCommandResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("settings-replaced"),
    settings: ShellSettings,
    version: AggregateVersion,
  }),
  Schema.Struct({
    kind: Schema.Literal("workspace-replaced"),
    workspace: WindowWorkspace,
    version: AggregateVersion,
  }),
  Schema.Struct({
    kind: Schema.Literal("environment-presentation-replaced"),
    presentation: EnvironmentPresentationState,
    version: AggregateVersion,
  }),
]);
export type ShellCommandResult = typeof ShellCommandResult.Type;

const FailureMessage = NonEmptyTrimmedString;
export const ShellFailure = Schema.Union([
  Schema.Struct({ category: Schema.Literal("invalid"), message: FailureMessage }),
  Schema.Struct({ category: Schema.Literal("unsupported"), message: FailureMessage }),
  Schema.Struct({
    category: Schema.Literal("conflict"),
    message: FailureMessage,
    expectedVersion: AggregateVersion,
    actualVersion: AggregateVersion,
  }),
  Schema.Struct({ category: Schema.Literal("unavailable"), message: FailureMessage }),
  Schema.Struct({
    category: Schema.Literal("cross-context"),
    message: FailureMessage,
    offerNewWindow: Schema.Boolean,
  }),
  Schema.Struct({
    category: Schema.Literal("recovery-required"),
    message: FailureMessage,
  }),
]);
export type ShellFailure = typeof ShellFailure.Type;

export const ShellSettingsReplaced = Schema.Struct({ settings: ShellSettings });
export type ShellSettingsReplaced = typeof ShellSettingsReplaced.Type;

export const WorkspaceLayoutReplaced = Schema.Struct({ workspace: WindowWorkspace });
export type WorkspaceLayoutReplaced = typeof WorkspaceLayoutReplaced.Type;

export const EnvironmentPresentationReplaced = Schema.Struct({
  presentation: EnvironmentPresentationState,
});
export type EnvironmentPresentationReplaced = typeof EnvironmentPresentationReplaced.Type;

export const decodeWindowId = Schema.decodeUnknownSync(WindowId, STRICT_DECODE_OPTIONS);
export const decodeLayoutNodeId = Schema.decodeUnknownSync(LayoutNodeId, STRICT_DECODE_OPTIONS);
export const decodePaneId = Schema.decodeUnknownSync(PaneId, STRICT_DECODE_OPTIONS);
export const decodeWorkspaceTabId = Schema.decodeUnknownSync(WorkspaceTabId, STRICT_DECODE_OPTIONS);
export const decodeWorkspaceContextKey = Schema.decodeUnknownSync(
  WorkspaceContextKey,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkspaceSurfaceDescriptor = Schema.decodeUnknownSync(
  WorkspaceSurfaceDescriptor,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkspaceSurfaceCatalog = Schema.decodeUnknownSync(
  WorkspaceSurfaceCatalog,
  STRICT_DECODE_OPTIONS,
);
export const decodeShellSettings = Schema.decodeUnknownSync(ShellSettings, STRICT_DECODE_OPTIONS);

/**
 * The host's shell settings for a device the host's own person paired, which
 * has no window on the host to bootstrap: the settings with the version a
 * replacement must name, and the replacement itself.
 */
export const SHELL_SETTINGS_PATH = "/api/shell/settings";
export const ShellSettingsReading = Schema.Struct({
  settings: ShellSettings,
  version: AggregateVersion,
});
export type ShellSettingsReading = typeof ShellSettingsReading.Type;
export const decodeShellSettingsReading = Schema.decodeUnknownSync(
  ShellSettingsReading,
  STRICT_DECODE_OPTIONS,
);
export const ShellSettingsReplacement = Schema.Struct({
  expectedVersion: AggregateVersion,
  settings: ShellSettings,
});
export type ShellSettingsReplacement = typeof ShellSettingsReplacement.Type;
export const decodeShellSettingsReplacement = Schema.decodeUnknownSync(
  ShellSettingsReplacement,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkspaceTab = Schema.decodeUnknownSync(WorkspaceTab, STRICT_DECODE_OPTIONS);
export const decodeWorkspaceLayoutNode = Schema.decodeUnknownSync(
  WorkspaceLayoutNode,
  STRICT_DECODE_OPTIONS,
);
export const decodeWindowWorkspace = Schema.decodeUnknownSync(
  WindowWorkspace,
  STRICT_DECODE_OPTIONS,
);
export const decodeShellBootstrap = Schema.decodeUnknownSync(ShellBootstrap, STRICT_DECODE_OPTIONS);
export const decodeWorkspaceOperation = Schema.decodeUnknownSync(
  WorkspaceOperation,
  STRICT_DECODE_OPTIONS,
);
export const decodeShellCommand = Schema.decodeUnknownSync(ShellCommand, STRICT_DECODE_OPTIONS);
export const decodeShellCommandResult = Schema.decodeUnknownSync(
  ShellCommandResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeShellFailure = Schema.decodeUnknownSync(ShellFailure, STRICT_DECODE_OPTIONS);
export const decodeShellSettingsReplaced = Schema.decodeUnknownSync(
  ShellSettingsReplaced,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkspaceLayoutReplaced = Schema.decodeUnknownSync(
  WorkspaceLayoutReplaced,
  STRICT_DECODE_OPTIONS,
);
export const decodeEnvironmentPresentation = Schema.decodeUnknownSync(
  EnvironmentPresentation,
  STRICT_DECODE_OPTIONS,
);
export const decodeEnvironmentTabPresentation = Schema.decodeUnknownSync(
  EnvironmentTabPresentation,
  STRICT_DECODE_OPTIONS,
);
export const decodeEnvironmentPresentationByMode = Schema.decodeUnknownSync(
  EnvironmentPresentationByMode,
  STRICT_DECODE_OPTIONS,
);
export const decodeEnvironmentPresentationState = Schema.decodeUnknownSync(
  EnvironmentPresentationState,
  STRICT_DECODE_OPTIONS,
);
export const decodeEnvironmentCompactIdentity = Schema.decodeUnknownSync(
  EnvironmentCompactIdentity,
  STRICT_DECODE_OPTIONS,
);
export const decodeEnvironmentSectionDescriptor = Schema.decodeUnknownSync(
  EnvironmentSectionDescriptor,
  STRICT_DECODE_OPTIONS,
);
export const decodeEnvironmentPresentationReplaced = Schema.decodeUnknownSync(
  EnvironmentPresentationReplaced,
  STRICT_DECODE_OPTIONS,
);
