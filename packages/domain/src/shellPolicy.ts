import { orderTabsWithPinnedCanvasFirst, withCanvasTabPin } from "./canvasTabPolicy";
import {
  DEFAULT_ENVIRONMENT_PRESENTATION_BY_MODE,
  LOCAL_HOST_ID,
  MAX_CONTEXT_SIDEBAR_WIDTH,
  MAX_ENVIRONMENT_PINNED_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MAX_SPLIT_RATIO,
  MAX_STOWED_WORKSPACE_LAYOUTS,
  MIN_CONTEXT_SIDEBAR_WIDTH,
  MIN_ENVIRONMENT_PINNED_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MIN_SPLIT_RATIO,
  decodeLayoutNodeId,
  decodeTabGroupId,
  decodeWorkspaceTabId,
  type EnvironmentCompactIdentity,
  type EnvironmentPresentation,
  type EnvironmentPresentationByMode,
  type EnvironmentPresentationState,
  type EnvironmentSectionDescriptor,
  type EnvironmentSectionId,
  type EnvironmentTabPresentation,
  type FirstRunOnboardingStatus,
  type HostId,
  type LayoutNodeId,
  type ShellSettings,
  type SplitRatio,
  type StowedWorkspaceLayout,
  type TabGroupId,
  type WindowId,
  type WindowWorkspace,
  type WorkspaceContextKey,
  type WorkspaceLayoutNode,
  type WorkspaceOperation,
  type WorkspaceSurfaceCatalog,
  type WorkspaceSurfaceDescriptor,
  type WorkspaceTab,
  type WorkspaceTabGroup,
  type WorkspaceTabId,
} from "@octant/contracts/shell";
import { DEFAULT_SIDEBAR_BACKGROUND } from "@octant/contracts/theme";
import { DEFAULT_AVATAR_ACCENT, DEFAULT_USER_AVATAR } from "@octant/contracts/user-profile";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId } from "@octant/contracts/projects";
import type { CodeEnvironmentObservation } from "@octant/contracts";
import { resolveAvailableMode } from "./modePolicy";

export const MAX_LAYOUT_DEPTH = 6;
export const MAX_TAB_GROUPS = 8;
export const MAX_WORKSPACE_TABS = 48;

export type ShellPolicyRejectionCode =
  | "cross-context"
  | "duplicate-id"
  | "invalid-active-group"
  | "invalid-active-tab"
  | "invalid-focus"
  | "invalid-index"
  | "invalid-layout"
  | "limit-exceeded"
  | "missing-group"
  | "missing-node"
  | "missing-tab"
  | "redundant-split";

export class ShellPolicyRejected extends Error {
  override readonly name = "ShellPolicyRejected";

  constructor(
    readonly code: ShellPolicyRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

const DEFAULT_IDS = {
  chat: {
    nodeId: decodeLayoutNodeId("01000000-0000-4000-8000-000000000001"),
    groupId: decodeTabGroupId("01000000-0000-4000-8000-000000000002"),
    tabId: decodeWorkspaceTabId("01000000-0000-4000-8000-000000000003"),
  },
  work: {
    nodeId: decodeLayoutNodeId("02000000-0000-4000-8000-000000000001"),
    groupId: decodeTabGroupId("02000000-0000-4000-8000-000000000002"),
    tabId: decodeWorkspaceTabId("02000000-0000-4000-8000-000000000003"),
  },
  code: {
    nodeId: decodeLayoutNodeId("03000000-0000-4000-8000-000000000001"),
    groupId: decodeTabGroupId("03000000-0000-4000-8000-000000000002"),
    tabId: decodeWorkspaceTabId("03000000-0000-4000-8000-000000000003"),
  },
} as const;

const MODE_TITLES: Record<OctantMode, string> = {
  chat: "Welcome to Chat",
  work: "Welcome to Work",
  code: "Welcome to Code",
};

export function defaultContextKey(mode: OctantMode): WorkspaceContextKey {
  return {
    host: LOCAL_HOST_ID,
    mode,
    projectId: null,
    boundRoot: null,
  };
}

export function contextKeyForProject(
  mode: OctantMode,
  host: HostId,
  projectId: ProjectId,
  boundRoot: string | null,
): WorkspaceContextKey {
  return { host, mode, projectId, boundRoot };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function reject(code: ShellPolicyRejectionCode, message: string): never {
  throw new ShellPolicyRejected(code, message);
}

function defaultLayout(mode: OctantMode): WorkspaceTabGroup {
  const ids = DEFAULT_IDS[mode];
  return {
    kind: "group",
    nodeId: ids.nodeId,
    groupId: ids.groupId,
    tabs: [{ kind: "welcome", id: ids.tabId, mode, title: MODE_TITLES[mode] }],
    activeTabId: ids.tabId,
  };
}

export function defaultShellSettings(): ShellSettings {
  return {
    chatEnabled: true,
    workEnabled: true,
    sidebarWidth: 232,
    contextSidebarWidth: 360,
    lastContextSurface: null,
    sidebarMaterial: "system",
    modeSwitcherPresentation: "buttons",
    projectViewSwitcherPresentation: "dropdown",
    sidebarBackground: DEFAULT_SIDEBAR_BACKGROUND,
    environmentPresentationByMode: defaultEnvironmentPresentationByMode(),
    firstRunOnboarding: "pending",
    automaticUpdateChecks: true,
    navigatorAssistant: {},
    userProfile: { accent: DEFAULT_AVATAR_ACCENT, avatar: DEFAULT_USER_AVATAR },
  };
}

export function defaultEnvironmentPresentationByMode(): EnvironmentPresentationByMode {
  return { ...DEFAULT_ENVIRONMENT_PRESENTATION_BY_MODE };
}

export function defaultEnvironmentPresentationState(): EnvironmentPresentationState {
  return { byTab: [], byMode: defaultEnvironmentPresentationByMode() };
}

export function resolveEffectivePresentation(
  state: EnvironmentPresentationState,
  mode: OctantMode,
  tabId: WorkspaceTabId,
): EnvironmentPresentation {
  const override = state.byTab.find((entry) => entry.tabId === tabId);
  return override?.presentation ?? state.byMode[mode];
}

export function resolveEnvironmentPinnedWidth(
  state: EnvironmentPresentationState,
  tabId: WorkspaceTabId,
  override?: number,
): number {
  if (override !== undefined) return clampPinnedWidth(override);
  const existing = state.byTab.find((entry) => entry.tabId === tabId);
  if (existing === undefined) return 360;
  return existing.pinnedWidth;
}

export type EnvironmentPresentationInput = Omit<EnvironmentTabPresentation, "pinnedWidth"> & {
  readonly pinnedWidth?: number;
};

export function replaceEnvironmentPresentation(
  state: EnvironmentPresentationState,
  entry: EnvironmentPresentationInput,
): EnvironmentPresentationState {
  const without = state.byTab.filter((existing) => existing.tabId !== entry.tabId);
  const next: EnvironmentTabPresentation = {
    tabId: entry.tabId,
    presentation: entry.presentation,
    pinnedWidth: clampPinnedWidth(entry.pinnedWidth),
  };
  return { ...state, byTab: [...without, next] };
}

export function removeEnvironmentPresentation(
  state: EnvironmentPresentationState,
  tabId: WorkspaceTabId,
): EnvironmentPresentationState {
  return { ...state, byTab: state.byTab.filter((entry) => entry.tabId !== tabId) };
}

export function normalizeEnvironmentPresentationState(
  state: EnvironmentPresentationState,
): EnvironmentPresentationState {
  const seen = new Set<WorkspaceTabId>();
  const byTab: EnvironmentTabPresentation[] = [];
  for (const entry of state.byTab) {
    if (seen.has(entry.tabId)) continue;
    seen.add(entry.tabId);
    byTab.push({
      tabId: entry.tabId,
      presentation: entry.presentation,
      pinnedWidth: clampPinnedWidth(entry.pinnedWidth),
    });
  }
  return { byTab, byMode: state.byMode };
}

function clampPinnedWidth(value: number | undefined): number {
  if (value === undefined) return 360;
  return Math.min(MAX_ENVIRONMENT_PINNED_WIDTH, Math.max(MIN_ENVIRONMENT_PINNED_WIDTH, value));
}

export interface EnvironmentSectionCapabilities {
  readonly hasBoundRoot: boolean;
  readonly hasAuthoritativeContext?: boolean;
  readonly hasProjectMemory?: boolean;
}

export function filterEnvironmentSections(
  mode: OctantMode,
  capabilities: EnvironmentSectionCapabilities,
): ReadonlyArray<EnvironmentSectionDescriptor> {
  if (mode === "chat") {
    const hasAuthoritativeContext = capabilities.hasAuthoritativeContext ?? true;
    const hasProjectMemory = capabilities.hasProjectMemory ?? true;
    const contextUnavailableReason = "Authoritative Chat context is unavailable.";
    return [
      section(
        "project-context",
        "Project context",
        hasAuthoritativeContext,
        contextUnavailableReason,
      ),
      section(
        "memory",
        "Memory",
        hasAuthoritativeContext && hasProjectMemory,
        hasAuthoritativeContext
          ? "File this thread in a Chat Project to use shared memory."
          : contextUnavailableReason,
      ),
      section("attachments", "Attachments", hasAuthoritativeContext, contextUnavailableReason),
      section("sources", "Sources", hasAuthoritativeContext, contextUnavailableReason),
      section("recap", "Recap", hasAuthoritativeContext, contextUnavailableReason),
    ];
  }
  if (mode === "work") {
    return [
      section(
        "confined-root",
        "Confined root",
        capabilities.hasBoundRoot,
        "Open a folder Project to view the confined root.",
      ),
      section(
        "artifacts",
        "Artifacts",
        capabilities.hasBoundRoot,
        "Open a folder Project to view artifacts.",
      ),
      section(
        "approvals",
        "Approvals",
        capabilities.hasBoundRoot,
        "Open a folder Project to view approvals.",
      ),
      section("sources", "Sources", true),
      section("recap", "Recap", true),
    ];
  }
  return [
    section(
      "git",
      "Git",
      capabilities.hasBoundRoot,
      "Open a repository Project to view Git facts.",
    ),
    section(
      "changes",
      "Changes",
      capabilities.hasBoundRoot,
      "Open a repository Project to view changes.",
    ),
    section(
      "checkout",
      "Checkout",
      capabilities.hasBoundRoot,
      "Open a repository Project to view the checkout.",
    ),
    section(
      "branch",
      "Branch",
      capabilities.hasBoundRoot,
      "Open a repository Project to view the branch.",
    ),
    section(
      "commit-readiness",
      "Commit readiness",
      capabilities.hasBoundRoot,
      "Open a repository Project to view commit readiness.",
    ),
    section(
      "local-servers",
      "Local servers",
      capabilities.hasBoundRoot,
      "Open a repository Project to view local servers.",
    ),
    section(
      "repository",
      "Repository",
      capabilities.hasBoundRoot,
      "Open a repository Project to view the repository.",
    ),
    section(
      "editor-handoff",
      "Editor handoff",
      capabilities.hasBoundRoot,
      "Open a repository Project to view editor handoff.",
    ),
    section("notepad", "Notepad", true),
    section("project-instructions", "Project instructions", true),
    section("browser-sessions", "Browser sessions", true),
    section("sources", "Sources", true),
    section("recap", "Recap", true),
  ];
}

function section(
  id: EnvironmentSectionId,
  label: string,
  available: boolean,
  unavailableReason?: string,
): EnvironmentSectionDescriptor {
  return available
    ? { id, label, available: true }
    : { id, label, available: false, unavailableReason };
}

export function buildCompactIdentity(input: {
  readonly host: HostId;
  readonly label: string;
  readonly detail: string;
  readonly status: EnvironmentCompactIdentity["status"];
}): EnvironmentCompactIdentity {
  return { host: input.host, label: input.label, detail: input.detail, status: input.status };
}

export type ChatEnvironmentControllerStatus =
  | "loading"
  | "ready"
  | "disconnected"
  | "conflict-reload";

export interface ChatEnvironmentProjectionInput {
  readonly controllerStatus: ChatEnvironmentControllerStatus;
  readonly hasAuthoritativeThread: boolean;
  readonly projectName?: string;
  readonly threadHasProject: boolean;
}

export interface ChatEnvironmentProjection {
  readonly identity: EnvironmentCompactIdentity;
  readonly sections: ReadonlyArray<EnvironmentSectionDescriptor>;
}

/**
 * Project authoritative Chat thread context into the thread-local Environment.
 * Chat never gains filesystem, Git, terminal, artifact, or approval authority.
 * A missing referenced Project fails closed; an unfiled thread remains an
 * explicit virtual context without Project-scoped memory.
 */
export function deriveChatEnvironmentProjection(
  input: ChatEnvironmentProjectionInput,
): ChatEnvironmentProjection {
  const identity = deriveChatEnvironmentIdentity(input);
  const hasAuthoritativeContext = identity.status === "available";
  return {
    identity,
    sections: filterEnvironmentSections("chat", {
      hasBoundRoot: false,
      hasAuthoritativeContext,
      hasProjectMemory:
        hasAuthoritativeContext && input.threadHasProject && input.projectName !== undefined,
    }),
  };
}

function deriveChatEnvironmentIdentity(
  input: ChatEnvironmentProjectionInput,
): EnvironmentCompactIdentity {
  if (input.controllerStatus === "disconnected") {
    return buildCompactIdentity({
      host: LOCAL_HOST_ID,
      label: input.projectName ?? "Chat",
      detail: "Reconnecting",
      status: "disconnected",
    });
  }
  if (input.controllerStatus === "loading") {
    return buildCompactIdentity({
      host: LOCAL_HOST_ID,
      label: "Chat",
      detail: "Loading context",
      status: "recovery",
    });
  }
  if (input.controllerStatus === "conflict-reload") {
    return buildCompactIdentity({
      host: LOCAL_HOST_ID,
      label: input.projectName ?? "Chat",
      detail: "Refreshing context",
      status: "recovery",
    });
  }
  if (!input.hasAuthoritativeThread) {
    return buildCompactIdentity({
      host: LOCAL_HOST_ID,
      label: "Chat",
      detail: "Context unavailable",
      status: "unavailable",
    });
  }
  if (input.threadHasProject && input.projectName === undefined) {
    return buildCompactIdentity({
      host: LOCAL_HOST_ID,
      label: "Chat",
      detail: "Project unavailable",
      status: "unavailable",
    });
  }
  if (input.projectName !== undefined) {
    return buildCompactIdentity({
      host: LOCAL_HOST_ID,
      label: input.projectName,
      detail: "Virtual Project",
      status: "available",
    });
  }
  return buildCompactIdentity({
    host: LOCAL_HOST_ID,
    label: "Unfiled Chat",
    detail: "Virtual context",
    status: "available",
  });
}

/**
 * Controller status for a thread environment, mirroring the renderer-side
 * `useCodeEnvironmentController` status without coupling the pure domain layer
 * to React. The domain only needs to know whether facts are loading, ready,
 * unreachable, or idle (no project bound).
 */
export type CodeEnvironmentControllerStatus = "idle" | "loading" | "ready" | "error";

export interface CodeEnvironmentProjectionInput {
  readonly observation: CodeEnvironmentObservation | undefined;
  readonly projectName: string;
  readonly controllerStatus: CodeEnvironmentControllerStatus;
}

export interface CodeEnvironmentProjection {
  readonly identity: EnvironmentCompactIdentity;
  readonly sections: ReadonlyArray<EnvironmentSectionDescriptor>;
}

/**
 * Project an authoritative {@link CodeEnvironmentObservation} into the compact
 * identity and capability-valid Code sections consumed by the thread
 * Environment panel. The identity follows the authoritative thread
 * environment/worktree: `local` host (Code is local-only for now), the project
 * name as the label, and the branch/worktree as the detail. Status maps from
 * the controller + observation so unavailable, stale, disconnected, and
 * recovery states stay distinguishable in the compact control.
 */
export function deriveCodeEnvironmentProjection(
  input: CodeEnvironmentProjectionInput,
): CodeEnvironmentProjection {
  const identity = deriveCodeEnvironmentIdentity(input);
  const hasBoundRoot = input.observation?.status === "ready";
  const sections = filterEnvironmentSections("code", { hasBoundRoot });
  return { identity, sections };
}

export interface WorkEnvironmentProjectionInput {
  readonly projectName: string;
  readonly boundRoot?: string;
}

export interface WorkEnvironmentProjection {
  readonly identity: EnvironmentCompactIdentity;
  readonly sections: ReadonlyArray<EnvironmentSectionDescriptor>;
}

/**
 * Project a Work Project binding into a compact identity and capability-valid
 * Environment sections. Artifact and approval bodies remain gated by their
 * owning contracts; this projection only exposes the confined root.
 */
export function deriveWorkEnvironmentProjection(
  input: WorkEnvironmentProjectionInput,
): WorkEnvironmentProjection {
  const boundRoot = input.boundRoot?.trim();
  const hasBoundRoot = boundRoot !== undefined && boundRoot.length > 0;
  const sections = filterEnvironmentSections("work", { hasBoundRoot });
  if (!hasBoundRoot || boundRoot === undefined) {
    return {
      identity: buildCompactIdentity({
        host: LOCAL_HOST_ID,
        label: input.projectName,
        detail: "No folder Project",
        status: "unavailable",
      }),
      sections,
    };
  }
  return {
    identity: buildCompactIdentity({
      host: LOCAL_HOST_ID,
      label: input.projectName,
      detail: confinedRootDetail(boundRoot),
      status: "available",
    }),
    sections,
  };
}

function confinedRootDetail(boundRoot: string): string {
  const trimmed = boundRoot.replace(/\/+$/, "");
  const segments = trimmed.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? trimmed;
}

function deriveCodeEnvironmentIdentity(
  input: CodeEnvironmentProjectionInput,
): EnvironmentCompactIdentity {
  const { controllerStatus, observation, projectName } = input;
  if (controllerStatus === "loading") {
    return buildCompactIdentity({
      host: LOCAL_HOST_ID,
      label: projectName,
      detail: "Loading environment",
      status: "recovery",
    });
  }
  if (controllerStatus === "error") {
    return buildCompactIdentity({
      host: LOCAL_HOST_ID,
      label: projectName,
      detail: "Reconnecting",
      status: "disconnected",
    });
  }
  if (controllerStatus === "idle" || observation === undefined) {
    return buildCompactIdentity({
      host: LOCAL_HOST_ID,
      label: projectName,
      detail: "No project",
      status: "unavailable",
    });
  }
  if (observation.status === "unavailable") {
    return buildCompactIdentity({
      host: LOCAL_HOST_ID,
      label: projectName,
      detail: "Environment unavailable",
      status: "unavailable",
    });
  }
  if (observation.status === "failed") {
    return buildCompactIdentity({
      host: LOCAL_HOST_ID,
      label: projectName,
      detail: "Environment inspection failed",
      status: "recovery",
    });
  }
  return buildCompactIdentity({
    host: LOCAL_HOST_ID,
    label: projectName,
    detail: codeEnvironmentDetail(observation),
    status: "available",
  });
}

function codeEnvironmentDetail(
  observation: Extract<CodeEnvironmentObservation, { status: "ready" }>,
): string {
  if (observation.branch.kind === "detached") {
    return `detached ${observation.branch.oid.slice(0, 12)}`;
  }
  return observation.branch.name;
}

export function defaultWindowWorkspace(windowId: WindowId): WindowWorkspace {
  return {
    windowId,
    activeMode: "chat",
    layouts: {
      chat: defaultLayout("chat"),
      work: defaultLayout("work"),
      code: defaultLayout("code"),
    },
    activeGroupIds: {
      chat: DEFAULT_IDS.chat.groupId,
      work: DEFAULT_IDS.work.groupId,
      code: DEFAULT_IDS.code.groupId,
    },
    contextByMode: {
      chat: defaultContextKey("chat"),
      work: defaultContextKey("work"),
      code: defaultContextKey("code"),
    },
    stowedLayouts: [],
    version: 0 as WindowWorkspace["version"],
  };
}

/**
 * Resolve the host's first-run onboarding state for a settings replacement.
 *
 * Onboarding is a one-way host fact: a renderer may report that the walkthrough
 * finished or was skipped, but it can never reopen it. Enforcing the transition
 * beside the rest of the settings policy means a replayed or forged settings
 * document cannot make first run reappear on the next launch, and cannot
 * un-resolve a host that has already answered.
 */
export function resolveFirstRunOnboarding(
  current: FirstRunOnboardingStatus,
  requested: FirstRunOnboardingStatus,
): FirstRunOnboardingStatus {
  return current === "pending" ? requested : current;
}

export function replaceShellSettings(
  current: ShellSettings,
  replacement: ShellSettings,
): ShellSettings {
  return {
    ...replacement,
    firstRunOnboarding: resolveFirstRunOnboarding(
      current.firstRunOnboarding,
      replacement.firstRunOnboarding,
    ),
    sidebarWidth: clamp(
      replacement.sidebarWidth,
      MIN_SIDEBAR_WIDTH,
      MAX_SIDEBAR_WIDTH,
    ) as ShellSettings["sidebarWidth"],
    contextSidebarWidth: clamp(
      replacement.contextSidebarWidth,
      MIN_CONTEXT_SIDEBAR_WIDTH,
      MAX_CONTEXT_SIDEBAR_WIDTH,
    ) as ShellSettings["contextSidebarWidth"],
  };
}

interface LayoutStats {
  readonly groups: number;
  readonly tabs: number;
  readonly groupIds: ReadonlySet<TabGroupId>;
}

function validateLayout(
  mode: OctantMode,
  context: WorkspaceContextKey,
  layout: WorkspaceLayoutNode,
  seenNodeIds: Set<LayoutNodeId>,
  seenGroupIds: Set<TabGroupId>,
  seenTabIds: Set<WorkspaceTabId>,
  depth = 1,
): LayoutStats {
  if (depth > MAX_LAYOUT_DEPTH) {
    reject("limit-exceeded", `layout depth exceeds ${MAX_LAYOUT_DEPTH}`);
  }
  if (seenNodeIds.has(layout.nodeId)) reject("duplicate-id", "layout node IDs must be unique");
  seenNodeIds.add(layout.nodeId);

  if (layout.kind === "split") {
    if (
      !Number.isFinite(layout.ratio) ||
      layout.ratio < MIN_SPLIT_RATIO ||
      layout.ratio > MAX_SPLIT_RATIO
    ) {
      reject("invalid-layout", "split ratio is outside the supported range");
    }
    const first = validateLayout(
      mode,
      context,
      layout.first,
      seenNodeIds,
      seenGroupIds,
      seenTabIds,
      depth + 1,
    );
    const second = validateLayout(
      mode,
      context,
      layout.second,
      seenNodeIds,
      seenGroupIds,
      seenTabIds,
      depth + 1,
    );
    return {
      groups: first.groups + second.groups,
      tabs: first.tabs + second.tabs,
      groupIds: new Set([...first.groupIds, ...second.groupIds]),
    };
  }

  if (seenGroupIds.has(layout.groupId)) reject("duplicate-id", "tab group IDs must be unique");
  seenGroupIds.add(layout.groupId);
  if (layout.tabs.length === 0) reject("invalid-layout", "tab groups cannot be empty");
  if (!layout.tabs.some((tab) => tab.id === layout.activeTabId)) {
    reject("invalid-active-tab", "active tab must belong to its group");
  }
  for (const tab of layout.tabs) {
    if ("mode" in tab && tab.mode !== mode) {
      reject("invalid-layout", `${tab.kind} tab mode must match the ${mode} layout`);
    }
    validateTabContext(tab, mode, context);
    if (seenTabIds.has(tab.id)) reject("duplicate-id", "workspace tab IDs must be unique");
    seenTabIds.add(tab.id);
  }
  return { groups: 1, tabs: layout.tabs.length, groupIds: new Set([layout.groupId]) };
}

function validateTabContext(
  tab: WorkspaceTab,
  mode: OctantMode,
  context: WorkspaceContextKey,
): void {
  if (context.mode !== mode) {
    reject("invalid-layout", `workspace context mode must match the ${mode} layout`);
  }
  if (tab.kind === "browser" || tab.kind === "files") {
    if (context.boundRoot === null) {
      reject(
        "invalid-layout",
        `${tab.kind} tabs require a bound Project root in the ${mode} workspace context`,
      );
    }
    return;
  }
  if (tab.kind === "preview") {
    // Preview tabs carry their own opaque Project binding. The one-Project
    // invariant (tab.projectId === context.projectId when a Project is bound)
    // is enforced by resolveWorkspaceContext at the server boundary so a
    // cross-Project open surfaces the cross-context failure instead of being
    // rejected during the renderer's optimistic application. Here we only fail
    // closed when the layout's mode context has no bound Project at all: a
    // preview tab cannot rest in a workspace whose mode has no Project
    // authority, because the host cannot reauthorize it on restore.
    if (context.projectId === null) {
      reject(
        "invalid-layout",
        `preview tabs require a bound Project in the ${mode} workspace context`,
      );
    }
  }
  if (tab.kind === "canvas") {
    if (context.projectId === null) {
      reject(
        "invalid-layout",
        `canvas tabs require a bound Project in the ${mode} workspace context`,
      );
    }
  }
  // Project-tab context binding is enforced by resolveWorkspaceContext at the
  // server boundary so cross-Project opens can surface the cross-context failure
  // instead of being rejected during the renderer's optimistic application.
}

export function validateWorkspace(workspace: WindowWorkspace): WindowWorkspace {
  const seenNodeIds = new Set<LayoutNodeId>();
  const seenGroupIds = new Set<TabGroupId>();
  const seenTabIds = new Set<WorkspaceTabId>();
  const activeGroupIds = new Set<TabGroupId>();
  let totalGroups = 0;
  let totalTabs = 0;

  for (const mode of ["chat", "work", "code"] as const) {
    const context = workspace.contextByMode[mode];
    const stats = validateLayout(
      mode,
      context,
      workspace.layouts[mode],
      seenNodeIds,
      seenGroupIds,
      seenTabIds,
    );
    totalGroups += stats.groups;
    totalTabs += stats.tabs;
    if (mode === workspace.activeMode) {
      for (const groupId of stats.groupIds) activeGroupIds.add(groupId);
    }
    if (!stats.groupIds.has(workspace.activeGroupIds[mode])) {
      reject("invalid-active-group", `active group must be reachable in the ${mode} layout`);
    }
  }

  if (totalGroups > MAX_TAB_GROUPS) {
    reject("limit-exceeded", `workspace groups exceed ${MAX_TAB_GROUPS}`);
  }
  if (totalTabs > MAX_WORKSPACE_TABS) {
    reject("limit-exceeded", `workspace tabs exceed ${MAX_WORKSPACE_TABS}`);
  }

  if (workspace.focusedGroupId !== undefined && !activeGroupIds.has(workspace.focusedGroupId)) {
    reject("invalid-focus", "focused group must be reachable in the active mode");
  }

  // Stowed layouts are inactive per-Project snapshots: they are validated
  // against their own recorded context with independent identity sets (their
  // tabs are not part of the active workspace identity space), and they do not
  // count against the active group/tab limits.
  if (workspace.stowedLayouts.length > MAX_STOWED_WORKSPACE_LAYOUTS) {
    reject("limit-exceeded", `stowed layouts exceed ${MAX_STOWED_WORKSPACE_LAYOUTS}`);
  }
  const seenStowedContexts = new Set<string>();
  for (const stowed of workspace.stowedLayouts) {
    const key = `${stowed.context.host}:${stowed.context.mode}:${String(
      stowed.context.projectId,
    )}:${String(stowed.context.boundRoot)}`;
    if (seenStowedContexts.has(key)) {
      reject("duplicate-id", "stowed layouts must have unique workspace contexts");
    }
    seenStowedContexts.add(key);
    validateLayout(
      stowed.context.mode,
      stowed.context,
      stowed.layout,
      new Set<LayoutNodeId>(),
      new Set<TabGroupId>(),
      new Set<WorkspaceTabId>(),
    );
    if (findGroup(stowed.layout, stowed.activeGroupId) === undefined) {
      reject("invalid-active-group", "stowed active group must be reachable in its layout");
    }
  }
  return workspace;
}

export function reconcileWorkspaceWithSettings(
  workspace: WindowWorkspace,
  settings: ShellSettings,
): WindowWorkspace {
  validateWorkspace(workspace);
  const activeMode = resolveAvailableMode(workspace.activeMode, settings);
  if (activeMode === workspace.activeMode) return workspace;
  const { focusedGroupId: _focusedGroupId, ...unfocused } = workspace;
  return validateWorkspace({ ...unfocused, activeMode });
}

export interface WorkspaceContextResolves {
  readonly tabContext: (tab: WorkspaceTab) => WorkspaceContextKey | undefined;
}

export class WorkspaceContextRejected extends Error {
  override readonly name = "WorkspaceContextRejected";
  readonly offerNewWindow = true as const;

  constructor(message: string) {
    super(message);
  }
}

function sameProject(left: ProjectId | null, right: ProjectId | null): boolean {
  return left === null ? right === null : right !== null && left === right;
}

function sameWorkspaceContext(left: WorkspaceContextKey, right: WorkspaceContextKey): boolean {
  return (
    left.host === right.host &&
    left.mode === right.mode &&
    sameProject(left.projectId, right.projectId) &&
    left.boundRoot === right.boundRoot
  );
}

function isWelcomeOnlyLayout(layout: WorkspaceLayoutNode): layout is WorkspaceTabGroup {
  return layout.kind === "group" && layout.tabs.length === 1 && layout.tabs[0]?.kind === "welcome";
}

function isWelcomeOnlyGroup(group: WorkspaceTabGroup): boolean {
  return group.tabs.length === 1 && group.tabs[0]?.kind === "welcome";
}

function stowOutgoingLayout(workspace: WindowWorkspace, mode: OctantMode): WindowWorkspace {
  const layout = workspace.layouts[mode];
  if (isWelcomeOnlyLayout(layout)) return workspace;
  const context = workspace.contextByMode[mode];
  const entry: StowedWorkspaceLayout = {
    context,
    layout,
    activeGroupId: workspace.activeGroupIds[mode],
  };
  const rest = workspace.stowedLayouts.filter(
    (stowed) => !sameWorkspaceContext(stowed.context, context),
  );
  return {
    ...workspace,
    stowedLayouts: [entry, ...rest].slice(0, MAX_STOWED_WORKSPACE_LAYOUTS),
  };
}

function restoreDestinationLayout(
  workspace: WindowWorkspace,
  mode: OctantMode,
  candidate: WorkspaceContextKey,
): WindowWorkspace {
  const entry = workspace.stowedLayouts.find((stowed) =>
    sameWorkspaceContext(stowed.context, candidate),
  );
  const stowedLayouts = workspace.stowedLayouts.filter((stowed) => stowed !== entry);
  const layout = entry === undefined ? defaultLayout(mode) : entry.layout;
  const activeGroupId = entry === undefined ? firstGroup(layout).groupId : entry.activeGroupId;
  const next: WindowWorkspace = {
    ...workspace,
    layouts: { ...workspace.layouts, [mode]: layout },
    activeGroupIds: { ...workspace.activeGroupIds, [mode]: activeGroupId },
    stowedLayouts,
  };
  if (
    next.focusedGroupId !== undefined &&
    mode === next.activeMode &&
    findGroup(layout, next.focusedGroupId) === undefined
  ) {
    const { focusedGroupId: _focusedGroupId, ...unfocused } = next;
    return unfocused;
  }
  return next;
}

export function resolveWorkspaceContext(
  workspace: WindowWorkspace,
  operation: WorkspaceOperation,
  resolves: WorkspaceContextResolves,
): WindowWorkspace {
  if (operation.kind === "switch-project-tab") {
    const candidate = resolves.tabContext(operation.tab);
    if (
      candidate === undefined ||
      candidate.projectId === null ||
      candidate.mode !== operation.mode ||
      ("mode" in operation.tab && operation.tab.mode !== operation.mode)
    ) {
      throw new WorkspaceContextRejected(
        "The selected surface could not be resolved to an active matching Project.",
      );
    }
    const current = workspace.contextByMode[operation.mode];
    if (candidate.host !== current.host) {
      throw new WorkspaceContextRejected(
        "This surface belongs to a different host. Open it in a new window to switch hosts.",
      );
    }
    const stowed = stowOutgoingLayout(workspace, operation.mode);
    const restored = restoreDestinationLayout(stowed, operation.mode, candidate);
    return {
      ...restored,
      contextByMode: {
        ...restored.contextByMode,
        [operation.mode]: candidate,
      },
    };
  }
  if (operation.kind === "activate-tab") {
    const group = findGroup(workspace.layouts[operation.mode], operation.groupId);
    const tab = group?.tabs.find((candidate) => candidate.id === operation.tabId);
    if (tab === undefined) return workspace;
    return resolveWorkspaceContext(
      workspace,
      {
        kind: "open-tab",
        mode: operation.mode,
        groupId: operation.groupId,
        tab,
      },
      resolves,
    );
  }
  if (operation.kind !== "open-tab") return workspace;
  const mode = operation.mode;
  const tab = operation.tab;
  const current = workspace.contextByMode[mode];

  if (tab.kind === "files") {
    if (current.boundRoot === null) {
      throw new WorkspaceContextRejected(
        `${tab.kind} surfaces require a bound ${mode === "work" ? "folder" : "repository"} Project. Open a Project first.`,
      );
    }
    return workspace;
  }

  if (tab.kind === "browser" && tab.threadId === undefined) {
    throw new WorkspaceContextRejected(
      "Browser requires one exact owning thread. Open it from a Work or Code thread.",
    );
  }

  if (tab.kind === "preview") {
    // Preview tabs carry their own opaque Project/host/mode identity. The
    // one-Project invariant is enforced here: a preview tab may only join a
    // workspace whose mode context is unbound (the tab binds it) or already
    // bound to the same Project. Cross-Project drops fail before layout
    // mutation and surface the cross-context offer so the user can open the
    // preview in a new window instead. The host still reauthorizes the
    // opaque target on every open/chunk/refresh against the resolved context.
    if (tab.mode !== mode) {
      throw new WorkspaceContextRejected(
        "This preview belongs to a different mode. Open it in a new window to switch modes.",
      );
    }
    const candidate: WorkspaceContextKey = {
      host: current.host,
      mode,
      projectId: tab.projectId,
      // boundRoot is resolved by the host from the Project binding at
      // reauthorization time; the pure policy only needs the Project identity
      // to enforce the one-Project invariant.
      boundRoot: current.boundRoot,
    };
    if (current.projectId === null) {
      return validateWorkspace({
        ...workspace,
        contextByMode: { ...workspace.contextByMode, [mode]: candidate },
      });
    }
    if (sameProject(current.projectId, candidate.projectId)) {
      return workspace;
    }
    throw new WorkspaceContextRejected(
      "This preview belongs to a different Project. Open it in a new window to keep its authority.",
    );
  }

  if (tab.kind === "canvas") {
    if (tab.mode !== mode) {
      throw new WorkspaceContextRejected(
        "This canvas belongs to a different mode. Open it in a new window to switch modes.",
      );
    }
    const candidate: WorkspaceContextKey = {
      host: current.host,
      mode,
      projectId: tab.projectId,
      boundRoot: current.boundRoot,
    };
    if (current.projectId === null) {
      return validateWorkspace({
        ...workspace,
        contextByMode: { ...workspace.contextByMode, [mode]: candidate },
      });
    }
    if (sameProject(current.projectId, candidate.projectId)) {
      return workspace;
    }
    throw new WorkspaceContextRejected(
      "This canvas belongs to a different Project. Open it in a new window to keep its authority.",
    );
  }

  const candidate = resolves.tabContext(tab);
  if (candidate === undefined) {
    // Context-free tabs (welcome, settings, side-chat) carry no Project binding
    // and are always acceptable. Thread/project tabs that fail to resolve a
    // context must fail closed rather than journaling a durable tab with no
    // authoritative Project binding.
    if (
      tab.kind === "chat-thread" ||
      tab.kind === "code-overview" ||
      tab.kind === "work-thread" ||
      tab.kind === "code-file" ||
      tab.kind === "code-diff" ||
      tab.kind === "code-terminal" ||
      tab.kind === "code-test" ||
      tab.kind === "code-git" ||
      tab.kind === "code-pr" ||
      tab.kind === "code-local-review" ||
      tab.kind === "browser" ||
      tab.kind === "project"
    ) {
      throw new WorkspaceContextRejected(
        "This surface could not be resolved to an active Project. Open it again from the sidebar.",
      );
    }
    return workspace;
  }

  if (candidate.host !== current.host) {
    throw new WorkspaceContextRejected(
      "This surface belongs to a different host. Open it in a new window to switch hosts.",
    );
  }
  if (candidate.mode !== mode) {
    throw new WorkspaceContextRejected(
      "This surface belongs to a different mode. Open it in a new window to switch modes.",
    );
  }

  if (current.projectId === null) {
    return validateWorkspace({
      ...workspace,
      contextByMode: { ...workspace.contextByMode, [mode]: candidate },
    });
  }
  if (sameProject(current.projectId, candidate.projectId)) {
    if (candidate.boundRoot !== current.boundRoot) {
      // Same Project, different canonical root: the binding was relinked.
      // Update the context so root-backed tabs operate under the new authority.
      return validateWorkspace({
        ...workspace,
        contextByMode: { ...workspace.contextByMode, [mode]: candidate },
      });
    }
    return workspace;
  }
  throw new WorkspaceContextRejected(
    "This surface belongs to a different Project. Open it in a new window to keep its authority.",
  );
}

export function resolveSurfaceDescriptors(
  context: WorkspaceContextKey,
): ReadonlyArray<WorkspaceSurfaceDescriptor> {
  const hasBoundRoot = context.boundRoot !== null;
  // terminal, diff, and git-review surfaces require an active Code thread
  // context and are not independently launchable from the New Tab launcher;
  // they are opened within a Code thread via the code surface controls.
  return [
    { kind: "thread", label: "Thread", available: true },
    { kind: "side-chat", label: "Side Chat", available: true },
    descriptorForBound(
      "browser",
      "Browser",
      hasBoundRoot,
      "Open a Project to enable Browser surfaces.",
    ),
    descriptorForBound("files", "Files", hasBoundRoot, "Open a Project to enable Files surfaces."),
  ];
}

function descriptorForBound(
  kind: WorkspaceSurfaceDescriptor["kind"],
  label: string,
  available: boolean,
  unavailableReason: string,
): WorkspaceSurfaceDescriptor {
  return available
    ? { kind, label, available: true }
    : { kind, label, available: false, unavailableReason };
}

export function buildSurfaceCatalog(
  contextByMode: WindowWorkspace["contextByMode"],
): WorkspaceSurfaceCatalog {
  return {
    chat: resolveSurfaceDescriptors(contextByMode.chat),
    work: resolveSurfaceDescriptors(contextByMode.work),
    code: resolveSurfaceDescriptors(contextByMode.code),
  };
}

function findGroup(
  layout: WorkspaceLayoutNode,
  groupId: TabGroupId,
): WorkspaceTabGroup | undefined {
  if (layout.kind === "group") return layout.groupId === groupId ? layout : undefined;
  return findGroup(layout.first, groupId) ?? findGroup(layout.second, groupId);
}

function findTab(
  layout: WorkspaceLayoutNode,
  tabId: WorkspaceTabId,
): { readonly group: WorkspaceTabGroup; readonly tab: WorkspaceTab } | undefined {
  if (layout.kind === "group") {
    const tab = layout.tabs.find((candidate) => candidate.id === tabId);
    return tab === undefined ? undefined : { group: layout, tab };
  }
  return findTab(layout.first, tabId) ?? findTab(layout.second, tabId);
}

function findTabInWorkspace(
  workspace: WindowWorkspace,
  tabId: WorkspaceTabId,
):
  | { readonly mode: OctantMode; readonly group: WorkspaceTabGroup; readonly tab: WorkspaceTab }
  | undefined {
  for (const mode of ["chat", "work", "code"] as const) {
    const found = findTab(workspace.layouts[mode], tabId);
    if (found !== undefined) return { mode, ...found };
  }
  return undefined;
}

function hasNodeId(layout: WorkspaceLayoutNode, nodeId: LayoutNodeId): boolean {
  if (layout.nodeId === nodeId) return true;
  return layout.kind === "split"
    ? hasNodeId(layout.first, nodeId) || hasNodeId(layout.second, nodeId)
    : false;
}

function hasNodeIdInWorkspace(workspace: WindowWorkspace, nodeId: LayoutNodeId): boolean {
  return (["chat", "work", "code"] as const).some((mode) =>
    hasNodeId(workspace.layouts[mode], nodeId),
  );
}

function hasGroupIdInWorkspace(workspace: WindowWorkspace, groupId: TabGroupId): boolean {
  return (["chat", "work", "code"] as const).some(
    (mode) => findGroup(workspace.layouts[mode], groupId) !== undefined,
  );
}

function mapGroup(
  layout: WorkspaceLayoutNode,
  groupId: TabGroupId,
  transform: (group: WorkspaceTabGroup) => WorkspaceLayoutNode,
): { readonly layout: WorkspaceLayoutNode; readonly found: boolean } {
  if (layout.kind === "group") {
    return layout.groupId === groupId
      ? { layout: transform(layout), found: true }
      : { layout, found: false };
  }
  const first = mapGroup(layout.first, groupId, transform);
  if (first.found) return { layout: { ...layout, first: first.layout }, found: true };
  const second = mapGroup(layout.second, groupId, transform);
  return second.found
    ? { layout: { ...layout, second: second.layout }, found: true }
    : { layout, found: false };
}

function mapSplit(
  layout: WorkspaceLayoutNode,
  nodeId: LayoutNodeId,
  transform: (split: Extract<WorkspaceLayoutNode, { kind: "split" }>) => WorkspaceLayoutNode,
): { readonly layout: WorkspaceLayoutNode; readonly found: boolean } {
  if (layout.kind === "group") return { layout, found: false };
  if (layout.nodeId === nodeId) return { layout: transform(layout), found: true };
  const first = mapSplit(layout.first, nodeId, transform);
  if (first.found) return { layout: { ...layout, first: first.layout }, found: true };
  const second = mapSplit(layout.second, nodeId, transform);
  return second.found
    ? { layout: { ...layout, second: second.layout }, found: true }
    : { layout, found: false };
}

function removeTab(
  layout: WorkspaceLayoutNode,
  groupId: TabGroupId,
  tabId: WorkspaceTabId,
): { readonly layout: WorkspaceLayoutNode | undefined; readonly tab: WorkspaceTab | undefined } {
  if (layout.kind === "group") {
    if (layout.groupId !== groupId) return { layout, tab: undefined };
    const index = layout.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return { layout, tab: undefined };
    const removed = layout.tabs[index];
    const tabs = [...layout.tabs.slice(0, index), ...layout.tabs.slice(index + 1)];
    if (tabs.length === 0) return { layout: undefined, tab: removed };
    return {
      layout: {
        ...layout,
        tabs,
        activeTabId:
          layout.activeTabId === tabId
            ? tabs[Math.min(index, tabs.length - 1)]!.id
            : layout.activeTabId,
      },
      tab: removed,
    };
  }

  const first = removeTab(layout.first, groupId, tabId);
  if (first.tab !== undefined) {
    return {
      layout: first.layout === undefined ? layout.second : { ...layout, first: first.layout },
      tab: first.tab,
    };
  }
  const second = removeTab(layout.second, groupId, tabId);
  if (second.tab !== undefined) {
    return {
      layout: second.layout === undefined ? layout.first : { ...layout, second: second.layout },
      tab: second.tab,
    };
  }
  return { layout, tab: undefined };
}

function replaceLayout(
  workspace: WindowWorkspace,
  mode: OctantMode,
  layout: WorkspaceLayoutNode,
): WindowWorkspace {
  return { ...workspace, layouts: { ...workspace.layouts, [mode]: layout } };
}

function firstGroup(layout: WorkspaceLayoutNode): WorkspaceTabGroup {
  return layout.kind === "group" ? layout : firstGroup(layout.first);
}

function activateGroup(
  workspace: WindowWorkspace,
  mode: OctantMode,
  groupId: TabGroupId,
): WindowWorkspace {
  return {
    ...workspace,
    activeGroupIds: { ...workspace.activeGroupIds, [mode]: groupId },
  };
}

function nextVersion(workspace: WindowWorkspace): WindowWorkspace["version"] {
  return (workspace.version + 1) as WindowWorkspace["version"];
}

function finishOperation(workspace: WindowWorkspace): WindowWorkspace {
  const focusedGroupId = workspace.focusedGroupId;
  const focusReachable =
    focusedGroupId === undefined ||
    findGroup(workspace.layouts[workspace.activeMode], focusedGroupId) !== undefined;
  const activeGroupIds = { ...workspace.activeGroupIds };
  for (const mode of ["chat", "work", "code"] as const) {
    if (findGroup(workspace.layouts[mode], activeGroupIds[mode]) === undefined) {
      activeGroupIds[mode] = firstGroup(workspace.layouts[mode]).groupId;
    }
  }
  return validateWorkspace({
    ...workspace,
    activeGroupIds,
    ...(focusReachable ? {} : { focusedGroupId: undefined }),
    version: nextVersion(workspace),
  });
}

function requireGroup(layout: WorkspaceLayoutNode, groupId: TabGroupId): WorkspaceTabGroup {
  return (
    findGroup(layout, groupId) ?? reject("missing-group", "operation references a missing group")
  );
}

function requireIndex(index: number, maximum: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index > maximum) {
    reject("invalid-index", "tab index is outside the group bounds");
  }
}

export function applyWorkspaceOperation(
  workspace: WindowWorkspace,
  operation: WorkspaceOperation,
): WindowWorkspace {
  validateWorkspace(workspace);
  const mode = operation.mode;
  const layout = workspace.layouts[mode];

  switch (operation.kind) {
    case "switch-project-tab": {
      if (!("mode" in operation.tab) || operation.tab.mode !== mode) {
        reject("invalid-layout", "Project switch tab mode must match the target layout");
      }
      // resolveWorkspaceContext has already stowed the outgoing Project layout
      // and restored (or reset) the destination layout, so this upserts the tab
      // into the destination's active group instead of discarding state.
      const activeGroupId = workspace.activeGroupIds[mode];
      requireGroup(layout, activeGroupId);
      const mapped = mapGroup(layout, activeGroupId, (candidate) => {
        if (candidate.tabs.some((tab) => tab.id === operation.tab.id)) {
          return { ...candidate, activeTabId: operation.tab.id };
        }
        return isWelcomeOnlyGroup(candidate)
          ? { ...candidate, tabs: [operation.tab], activeTabId: operation.tab.id }
          : {
              ...candidate,
              tabs: [...candidate.tabs, operation.tab],
              activeTabId: operation.tab.id,
            };
      });
      return finishOperation(
        activateGroup(replaceLayout(workspace, mode, mapped.layout), mode, activeGroupId),
      );
    }

    case "open-tab": {
      requireGroup(layout, operation.groupId);
      const existing = findTabInWorkspace(workspace, operation.tab.id);
      if (existing !== undefined && existing.tab.kind !== "unavailable") {
        reject("duplicate-id", "workspace tab ID already exists");
      }

      if (existing?.group.groupId === operation.groupId && existing.mode === mode) {
        const recovered = mapGroup(layout, operation.groupId, (group) => ({
          ...group,
          tabs: group.tabs.map((tab) => (tab.id === operation.tab.id ? operation.tab : tab)),
          activeTabId: operation.tab.id,
        }));
        return finishOperation(
          activateGroup(replaceLayout(workspace, mode, recovered.layout), mode, operation.groupId),
        );
      }

      let next = workspace;
      if (existing !== undefined) {
        const removed = removeTab(
          next.layouts[existing.mode],
          existing.group.groupId,
          operation.tab.id,
        );
        next = replaceLayout(next, existing.mode, removed.layout ?? defaultLayout(existing.mode));
      }
      const targetLayout = next.layouts[mode];
      const mapped = mapGroup(targetLayout, operation.groupId, (group) => ({
        ...group,
        tabs: [...group.tabs, operation.tab],
        activeTabId: operation.tab.id,
      }));
      if (!mapped.found) reject("missing-group", "operation target disappeared during recovery");
      return finishOperation(
        activateGroup(replaceLayout(next, mode, mapped.layout), mode, operation.groupId),
      );
    }

    case "activate-tab": {
      const group = requireGroup(layout, operation.groupId);
      if (!group.tabs.some((tab) => tab.id === operation.tabId)) {
        reject("missing-tab", "tab does not belong to the requested group");
      }
      const mapped = mapGroup(layout, operation.groupId, (candidate) => ({
        ...candidate,
        activeTabId: operation.tabId,
      }));
      return finishOperation(
        activateGroup(replaceLayout(workspace, mode, mapped.layout), mode, operation.groupId),
      );
    }

    case "close-tab": {
      requireGroup(layout, operation.groupId);
      const removed = removeTab(layout, operation.groupId, operation.tabId);
      if (removed.tab === undefined)
        reject("missing-tab", "tab does not belong to the requested group");
      return finishOperation(replaceLayout(workspace, mode, removed.layout ?? defaultLayout(mode)));
    }

    case "reorder-tab": {
      const group = requireGroup(layout, operation.groupId);
      const fromIndex = group.tabs.findIndex((tab) => tab.id === operation.tabId);
      if (fromIndex < 0) reject("missing-tab", "tab does not belong to the requested group");
      requireIndex(operation.index, group.tabs.length - 1);
      const reordered = [...group.tabs];
      const [moved] = reordered.splice(fromIndex, 1);
      reordered.splice(operation.index, 0, moved!);
      const mapped = mapGroup(layout, operation.groupId, (candidate) => ({
        ...candidate,
        tabs: reordered,
      }));
      return finishOperation(
        activateGroup(replaceLayout(workspace, mode, mapped.layout), mode, operation.groupId),
      );
    }

    case "split-group": {
      const group = requireGroup(layout, operation.groupId);
      if (group.tabs.length === 1) {
        reject("redundant-split", "a group with one tab cannot be split");
      }
      if (hasNodeIdInWorkspace(workspace, operation.splitNodeId)) {
        reject("duplicate-id", "split node ID already exists");
      }
      if (hasNodeIdInWorkspace(workspace, operation.newGroupNodeId)) {
        reject("duplicate-id", "new group node ID already exists");
      }
      if (hasGroupIdInWorkspace(workspace, operation.newGroupId)) {
        reject("duplicate-id", "new group ID already exists");
      }
      const tabIndex = group.tabs.findIndex((tab) => tab.id === operation.tabId);
      if (tabIndex < 0) reject("missing-tab", "tab does not belong to the requested group");
      const remainingTabs = group.tabs.filter((tab) => tab.id !== operation.tabId);
      const remainingGroup: WorkspaceTabGroup = {
        ...group,
        tabs: remainingTabs,
        activeTabId:
          group.activeTabId === operation.tabId
            ? remainingTabs[Math.min(tabIndex, remainingTabs.length - 1)]!.id
            : group.activeTabId,
      };
      const newGroup: WorkspaceTabGroup = {
        kind: "group",
        nodeId: operation.newGroupNodeId,
        groupId: operation.newGroupId,
        tabs: [group.tabs[tabIndex]!],
        activeTabId: operation.tabId,
      };
      const first = operation.placement === "before" ? newGroup : remainingGroup;
      const second = operation.placement === "before" ? remainingGroup : newGroup;
      const mapped = mapGroup(layout, operation.groupId, () => ({
        kind: "split",
        nodeId: operation.splitNodeId,
        orientation: operation.orientation,
        ratio: clamp(operation.ratio, MIN_SPLIT_RATIO, MAX_SPLIT_RATIO) as SplitRatio,
        first,
        second,
      }));
      return finishOperation(
        activateGroup(replaceLayout(workspace, mode, mapped.layout), mode, operation.newGroupId),
      );
    }

    case "move-tab": {
      if (operation.fromGroupId === operation.toGroupId) {
        const group = requireGroup(layout, operation.fromGroupId);
        const fromIndex = group.tabs.findIndex((tab) => tab.id === operation.tabId);
        if (fromIndex < 0) reject("missing-tab", "tab does not belong to the requested group");
        requireIndex(operation.index, group.tabs.length - 1);
        const tabs = [...group.tabs];
        const [moved] = tabs.splice(fromIndex, 1);
        tabs.splice(operation.index, 0, moved!);
        const mapped = mapGroup(layout, operation.fromGroupId, (candidate) => ({
          ...candidate,
          tabs,
          activeTabId: operation.tabId,
        }));
        return finishOperation(
          activateGroup(replaceLayout(workspace, mode, mapped.layout), mode, operation.fromGroupId),
        );
      }

      requireGroup(layout, operation.fromGroupId);
      const target = requireGroup(layout, operation.toGroupId);
      requireIndex(operation.index, target.tabs.length);
      const removed = removeTab(layout, operation.fromGroupId, operation.tabId);
      if (removed.tab === undefined)
        reject("missing-tab", "tab does not belong to the source group");
      if (removed.layout === undefined)
        reject("missing-group", "move requires a destination group");
      const mapped = mapGroup(removed.layout, operation.toGroupId, (group) => ({
        ...group,
        tabs: [
          ...group.tabs.slice(0, operation.index),
          removed.tab!,
          ...group.tabs.slice(operation.index),
        ],
        activeTabId: operation.tabId,
      }));
      if (!mapped.found) reject("missing-group", "destination group became unreachable");
      return finishOperation(
        activateGroup(replaceLayout(workspace, mode, mapped.layout), mode, operation.toGroupId),
      );
    }

    case "dock-tab": {
      if (operation.fromGroupId === operation.targetGroupId) {
        reject("redundant-split", "cross-group docking requires distinct source and target groups");
      }
      const source = requireGroup(layout, operation.fromGroupId);
      requireGroup(layout, operation.targetGroupId);
      if (!source.tabs.some((tab) => tab.id === operation.tabId)) {
        reject("missing-tab", "tab does not belong to the source group");
      }
      if (hasNodeIdInWorkspace(workspace, operation.splitNodeId)) {
        reject("duplicate-id", "split node ID already exists");
      }
      if (hasNodeIdInWorkspace(workspace, operation.newGroupNodeId)) {
        reject("duplicate-id", "new group node ID already exists");
      }
      if (hasGroupIdInWorkspace(workspace, operation.newGroupId)) {
        reject("duplicate-id", "new group ID already exists");
      }

      const removed = removeTab(layout, operation.fromGroupId, operation.tabId);
      if (removed.tab === undefined || removed.layout === undefined) {
        reject("missing-tab", "tab could not be removed from the source group");
      }
      const newGroup: WorkspaceTabGroup = {
        kind: "group",
        nodeId: operation.newGroupNodeId,
        groupId: operation.newGroupId,
        tabs: [removed.tab],
        activeTabId: operation.tabId,
      };
      const mapped = mapGroup(removed.layout, operation.targetGroupId, (target) => ({
        kind: "split",
        nodeId: operation.splitNodeId,
        orientation: operation.orientation,
        ratio: clamp(operation.ratio, MIN_SPLIT_RATIO, MAX_SPLIT_RATIO) as SplitRatio,
        first: operation.placement === "before" ? newGroup : target,
        second: operation.placement === "before" ? target : newGroup,
      }));
      if (!mapped.found) reject("missing-group", "destination group became unreachable");
      return finishOperation(
        activateGroup(replaceLayout(workspace, mode, mapped.layout), mode, operation.newGroupId),
      );
    }

    case "resize-split": {
      const mapped = mapSplit(layout, operation.splitNodeId, (split) => ({
        ...split,
        ratio: clamp(operation.ratio, MIN_SPLIT_RATIO, MAX_SPLIT_RATIO) as SplitRatio,
      }));
      if (!mapped.found) reject("missing-node", "operation references a missing split");
      return finishOperation(replaceLayout(workspace, mode, mapped.layout));
    }

    case "focus-group": {
      if (mode !== workspace.activeMode || findGroup(layout, operation.groupId) === undefined) {
        reject("invalid-focus", "focused group must be reachable in the active mode");
      }
      return finishOperation(
        activateGroup({ ...workspace, focusedGroupId: operation.groupId }, mode, operation.groupId),
      );
    }

    case "unfocus-group": {
      if (mode !== workspace.activeMode) {
        reject("invalid-focus", "unfocus operation must target the active mode");
      }
      const { focusedGroupId: _focusedGroupId, ...unfocused } = workspace;
      return finishOperation(unfocused);
    }

    case "reset-mode": {
      const layout = defaultLayout(mode);
      return finishOperation(
        activateGroup(replaceLayout(workspace, mode, layout), mode, layout.groupId),
      );
    }

    case "set-active-mode": {
      const { focusedGroupId: _focusedGroupId, ...unfocused } = workspace;
      return finishOperation({ ...unfocused, activeMode: mode });
    }

    case "set-canvas-tab-pin": {
      const group = requireGroup(layout, operation.groupId);
      const tab = group.tabs.find((candidate) => candidate.id === operation.tabId);
      if (tab === undefined) reject("missing-tab", "tab does not belong to the requested group");
      if (tab.kind !== "canvas") {
        reject("invalid-layout", "only canvas tabs support presentation pin");
      }
      const mapped = mapGroup(layout, operation.groupId, (candidate) => {
        const tabs = candidate.tabs.map((entry) =>
          entry.id === operation.tabId ? withCanvasTabPin(entry, operation.pinned) : entry,
        );
        return {
          ...candidate,
          tabs: orderTabsWithPinnedCanvasFirst(tabs),
          activeTabId: operation.tabId,
        };
      });
      return finishOperation(
        activateGroup(replaceLayout(workspace, mode, mapped.layout), mode, operation.groupId),
      );
    }
  }
}
