import {
  DEFAULT_ENVIRONMENT_PRESENTATION_BY_MODE,
  LOCAL_HOST_ID,
  MAX_CONTEXT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MAX_SPLIT_RATIO,
  MAX_STOWED_WORKSPACE_LAYOUTS,
  MIN_CONTEXT_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MIN_SPLIT_RATIO,
  decodeLayoutNodeId,
  decodePaneId,
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
  type PaneId,
  type ShellSettings,
  type SplitRatio,
  type StowedWorkspaceLayout,
  type WindowId,
  type WindowWorkspace,
  type WorkspaceContextKey,
  type WorkspaceLayoutNode,
  type WorkspaceOperation,
  type WorkspacePane,
  type WorkspaceSurfaceCatalog,
  type WorkspaceSurfaceDescriptor,
  type WorkspaceTab,
  type WorkspaceTabId,
} from "@octant/contracts/shell";
import { DEFAULT_SIDEBAR_BACKGROUND } from "@octant/contracts/theme";
import { DEFAULT_AVATAR_ACCENT, DEFAULT_USER_AVATAR } from "@octant/contracts/user-profile";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId } from "@octant/contracts/projects";
import type { ChatThreadId, CodeEnvironmentObservation } from "@octant/contracts";
import { resolveAvailableMode } from "./modePolicy";

export const MAX_LAYOUT_DEPTH = 6;
export const MAX_WORKSPACE_PANES = 8;

export type ShellPolicyRejectionCode =
  | "cross-context"
  | "duplicate-id"
  | "invalid-active-pane"
  | "invalid-focus"
  | "invalid-layout"
  | "limit-exceeded"
  | "missing-node"
  | "missing-pane"
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
    paneId: decodePaneId("01000000-0000-4000-8000-000000000002"),
    tabId: decodeWorkspaceTabId("01000000-0000-4000-8000-000000000003"),
  },
  work: {
    nodeId: decodeLayoutNodeId("02000000-0000-4000-8000-000000000001"),
    paneId: decodePaneId("02000000-0000-4000-8000-000000000002"),
    tabId: decodeWorkspaceTabId("02000000-0000-4000-8000-000000000003"),
  },
  code: {
    nodeId: decodeLayoutNodeId("03000000-0000-4000-8000-000000000001"),
    paneId: decodePaneId("03000000-0000-4000-8000-000000000002"),
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

function defaultLayout(mode: OctantMode): WorkspacePane {
  const ids = DEFAULT_IDS[mode];
  return {
    kind: "pane",
    nodeId: ids.nodeId,
    paneId: ids.paneId,
    surface: workspaceWelcomeSurface(mode, ids.tabId),
  };
}

/**
 * The welcome surface a pane falls back to. Restore renders this in place of a
 * surface that no longer resolves, reusing the old surface's id so the pane
 * keeps a stable identity instead of presenting a dead view with a Retry.
 */
export function workspaceWelcomeSurface(mode: OctantMode, id: WorkspaceTabId): WorkspaceTab {
  return { kind: "welcome", id, mode, title: MODE_TITLES[mode] };
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

export type EnvironmentPresentationInput = EnvironmentTabPresentation;

export function replaceEnvironmentPresentation(
  state: EnvironmentPresentationState,
  entry: EnvironmentPresentationInput,
): EnvironmentPresentationState {
  const without = state.byTab.filter((existing) => existing.tabId !== entry.tabId);
  const next: EnvironmentTabPresentation = {
    tabId: entry.tabId,
    presentation: entry.presentation,
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
    byTab.push({ tabId: entry.tabId, presentation: entry.presentation });
  }
  return { byTab, byMode: state.byMode };
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
    activePaneIds: {
      chat: DEFAULT_IDS.chat.paneId,
      work: DEFAULT_IDS.work.paneId,
      code: DEFAULT_IDS.code.paneId,
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
  readonly panes: number;
  readonly paneIds: ReadonlySet<PaneId>;
}

function validateLayout(
  mode: OctantMode,
  context: WorkspaceContextKey,
  layout: WorkspaceLayoutNode,
  seenNodeIds: Set<LayoutNodeId>,
  seenPaneIds: Set<PaneId>,
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
      seenPaneIds,
      seenTabIds,
      depth + 1,
    );
    const second = validateLayout(
      mode,
      context,
      layout.second,
      seenNodeIds,
      seenPaneIds,
      seenTabIds,
      depth + 1,
    );
    return {
      panes: first.panes + second.panes,
      paneIds: new Set([...first.paneIds, ...second.paneIds]),
    };
  }

  if (seenPaneIds.has(layout.paneId)) reject("duplicate-id", "pane IDs must be unique");
  seenPaneIds.add(layout.paneId);
  const surface = layout.surface;
  if ("mode" in surface && surface.mode !== mode) {
    reject("invalid-layout", `${surface.kind} surface mode must match the ${mode} layout`);
  }
  validateTabContext(surface, mode, context);
  if (seenTabIds.has(surface.id)) reject("duplicate-id", "workspace surface IDs must be unique");
  seenTabIds.add(surface.id);
  return { panes: 1, paneIds: new Set([layout.paneId]) };
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
  const seenPaneIds = new Set<PaneId>();
  const seenTabIds = new Set<WorkspaceTabId>();
  const activeModePaneIds = new Set<PaneId>();
  let totalPanes = 0;

  for (const mode of ["chat", "work", "code"] as const) {
    const context = workspace.contextByMode[mode];
    const stats = validateLayout(
      mode,
      context,
      workspace.layouts[mode],
      seenNodeIds,
      seenPaneIds,
      seenTabIds,
    );
    totalPanes += stats.panes;
    if (mode === workspace.activeMode) {
      for (const paneId of stats.paneIds) activeModePaneIds.add(paneId);
    }
    if (!stats.paneIds.has(workspace.activePaneIds[mode])) {
      reject("invalid-active-pane", `active pane must be reachable in the ${mode} layout`);
    }
  }

  if (totalPanes > MAX_WORKSPACE_PANES) {
    reject("limit-exceeded", `workspace panes exceed ${MAX_WORKSPACE_PANES}`);
  }

  if (workspace.focusedPaneId !== undefined && !activeModePaneIds.has(workspace.focusedPaneId)) {
    reject("invalid-focus", "focused pane must be reachable in the active mode");
  }

  // Stowed layouts are inactive per-Project snapshots: they are validated
  // against their own recorded context with independent identity sets (their
  // surfaces are not part of the active workspace identity space), and they do
  // not count against the active pane limit.
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
      new Set<PaneId>(),
      new Set<WorkspaceTabId>(),
    );
    if (findPane(stowed.layout, stowed.activePaneId) === undefined) {
      reject("invalid-active-pane", "stowed active pane must be reachable in its layout");
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
  const { focusedPaneId: _focusedPaneId, ...unfocused } = workspace;
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

function isWelcomeOnlyLayout(layout: WorkspaceLayoutNode): layout is WorkspacePane {
  return layout.kind === "pane" && layout.surface.kind === "welcome";
}

function stowOutgoingLayout(workspace: WindowWorkspace, mode: OctantMode): WindowWorkspace {
  const layout = workspace.layouts[mode];
  if (isWelcomeOnlyLayout(layout)) return workspace;
  const context = workspace.contextByMode[mode];
  const entry: StowedWorkspaceLayout = {
    context,
    layout,
    activePaneId: workspace.activePaneIds[mode],
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
  const activePaneId = entry === undefined ? firstPane(layout).paneId : entry.activePaneId;
  const next: WindowWorkspace = {
    ...workspace,
    layouts: { ...workspace.layouts, [mode]: layout },
    activePaneIds: { ...workspace.activePaneIds, [mode]: activePaneId },
    stowedLayouts,
  };
  if (
    next.focusedPaneId !== undefined &&
    mode === next.activeMode &&
    findPane(layout, next.focusedPaneId) === undefined
  ) {
    const { focusedPaneId: _focusedPaneId, ...unfocused } = next;
    return unfocused;
  }
  return next;
}

export function resolveWorkspaceContext(
  workspace: WindowWorkspace,
  operation: WorkspaceOperation,
  resolves: WorkspaceContextResolves,
): WindowWorkspace {
  if (operation.kind === "switch-project-surface") {
    const candidate = resolves.tabContext(operation.surface);
    if (
      candidate === undefined ||
      candidate.projectId === null ||
      candidate.mode !== operation.mode ||
      ("mode" in operation.surface && operation.surface.mode !== operation.mode)
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
  // Every operation that introduces a surface must resolve its context: a
  // sidebar drag lands as split-pane or replace-pane-surface without ever
  // passing through open-surface, and skipping resolution there would journal
  // a surface whose Project authority was never checked.
  if (
    operation.kind !== "open-surface" &&
    operation.kind !== "replace-pane-surface" &&
    operation.kind !== "split-pane"
  ) {
    return workspace;
  }
  const mode = operation.mode;
  const tab = operation.surface;
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

function findPane(layout: WorkspaceLayoutNode, paneId: PaneId): WorkspacePane | undefined {
  if (layout.kind === "pane") {
    return String(layout.paneId) === String(paneId) ? layout : undefined;
  }
  return findPane(layout.first, paneId) ?? findPane(layout.second, paneId);
}

function findSurfacePane(
  layout: WorkspaceLayoutNode,
  surface: WorkspaceTab,
): WorkspacePane | undefined {
  if (layout.kind === "pane") {
    return sameWorkspaceSurface(layout.surface, surface) ? layout : undefined;
  }
  return findSurfacePane(layout.first, surface) ?? findSurfacePane(layout.second, surface);
}

function hasSurfaceId(layout: WorkspaceLayoutNode, id: WorkspaceTabId): boolean {
  if (layout.kind === "pane") return String(layout.surface.id) === String(id);
  return hasSurfaceId(layout.first, id) || hasSurfaceId(layout.second, id);
}

function hasSurfaceIdInWorkspace(workspace: WindowWorkspace, id: WorkspaceTabId): boolean {
  return (["chat", "work", "code"] as const).some((mode) =>
    hasSurfaceId(workspace.layouts[mode], id),
  );
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

function hasPaneIdInWorkspace(workspace: WindowWorkspace, paneId: PaneId): boolean {
  return (["chat", "work", "code"] as const).some(
    (mode) => findPane(workspace.layouts[mode], paneId) !== undefined,
  );
}

function mapPane(
  layout: WorkspaceLayoutNode,
  paneId: PaneId,
  transform: (pane: WorkspacePane) => WorkspaceLayoutNode,
): { readonly layout: WorkspaceLayoutNode; readonly found: boolean } {
  if (layout.kind === "pane") {
    return String(layout.paneId) === String(paneId)
      ? { layout: transform(layout), found: true }
      : { layout, found: false };
  }
  const first = mapPane(layout.first, paneId, transform);
  if (first.found) return { layout: { ...layout, first: first.layout }, found: true };
  const second = mapPane(layout.second, paneId, transform);
  return second.found
    ? { layout: { ...layout, second: second.layout }, found: true }
    : { layout, found: false };
}

function mapSplit(
  layout: WorkspaceLayoutNode,
  nodeId: LayoutNodeId,
  transform: (split: Extract<WorkspaceLayoutNode, { kind: "split" }>) => WorkspaceLayoutNode,
): { readonly layout: WorkspaceLayoutNode; readonly found: boolean } {
  if (layout.kind === "pane") return { layout, found: false };
  if (layout.nodeId === nodeId) return { layout: transform(layout), found: true };
  const first = mapSplit(layout.first, nodeId, transform);
  if (first.found) return { layout: { ...layout, first: first.layout }, found: true };
  const second = mapSplit(layout.second, nodeId, transform);
  return second.found
    ? { layout: { ...layout, second: second.layout }, found: true }
    : { layout, found: false };
}

function removePane(
  layout: WorkspaceLayoutNode,
  paneId: PaneId,
): { readonly layout: WorkspaceLayoutNode | undefined; readonly pane: WorkspacePane | undefined } {
  if (layout.kind === "pane") {
    return String(layout.paneId) === String(paneId)
      ? { layout: undefined, pane: layout }
      : { layout, pane: undefined };
  }
  const first = removePane(layout.first, paneId);
  if (first.pane !== undefined) {
    return {
      layout: first.layout === undefined ? layout.second : { ...layout, first: first.layout },
      pane: first.pane,
    };
  }
  const second = removePane(layout.second, paneId);
  if (second.pane !== undefined) {
    return {
      layout: second.layout === undefined ? layout.first : { ...layout, second: second.layout },
      pane: second.pane,
    };
  }
  return { layout, pane: undefined };
}

function replaceLayout(
  workspace: WindowWorkspace,
  mode: OctantMode,
  layout: WorkspaceLayoutNode,
): WindowWorkspace {
  return { ...workspace, layouts: { ...workspace.layouts, [mode]: layout } };
}

function firstPane(layout: WorkspaceLayoutNode): WorkspacePane {
  return layout.kind === "pane" ? layout : firstPane(layout.first);
}

function activatePane(
  workspace: WindowWorkspace,
  mode: OctantMode,
  paneId: PaneId,
): WindowWorkspace {
  const next: WindowWorkspace = {
    ...workspace,
    activePaneIds: { ...workspace.activePaneIds, [mode]: paneId },
  };
  // Focus mode shows exactly one pane, so an activation while focused must move
  // the focus with it — otherwise the newly opened surface would be running
  // behind a zoomed view of some other pane, which is the invisible-work bug
  // the single-surface model exists to remove.
  if (next.focusedPaneId !== undefined && mode === next.activeMode) {
    return { ...next, focusedPaneId: paneId };
  }
  return next;
}

function nextVersion(workspace: WindowWorkspace): WindowWorkspace["version"] {
  return (workspace.version + 1) as WindowWorkspace["version"];
}

function finishOperation(workspace: WindowWorkspace): WindowWorkspace {
  const focusedPaneId = workspace.focusedPaneId;
  const focusReachable =
    focusedPaneId === undefined ||
    findPane(workspace.layouts[workspace.activeMode], focusedPaneId) !== undefined;
  const activePaneIds = { ...workspace.activePaneIds };
  for (const mode of ["chat", "work", "code"] as const) {
    if (findPane(workspace.layouts[mode], activePaneIds[mode]) === undefined) {
      activePaneIds[mode] = firstPane(workspace.layouts[mode]).paneId;
    }
  }
  return validateWorkspace({
    ...workspace,
    activePaneIds,
    ...(focusReachable ? {} : { focusedPaneId: undefined }),
    version: nextVersion(workspace),
  });
}

function requirePane(layout: WorkspaceLayoutNode, paneId: PaneId): WorkspacePane {
  return findPane(layout, paneId) ?? reject("missing-pane", "operation references a missing pane");
}

/**
 * Whether two surface values are views of the same thing, ignoring the surface
 * id and title. This is what "already open" means: opening from the sidebar
 * mints a fresh id every time, so identity has to live in what the surface
 * shows, never in which gesture created it. Welcome surfaces are placeholders
 * rather than content, so two of them are never "the same" — a split may hold
 * several.
 */
export function sameWorkspaceSurface(a: WorkspaceTab, b: WorkspaceTab): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "welcome":
      return false;
    case "settings":
      return true;
    case "draft-thread":
      return (
        b.kind === "draft-thread" && a.mode === b.mode && sameOptionalId(a.projectId, b.projectId)
      );
    case "project":
      return (
        b.kind === "project" && a.mode === b.mode && String(a.projectId) === String(b.projectId)
      );
    case "chat-thread":
      return b.kind === "chat-thread" && String(a.threadId) === String(b.threadId);
    case "work-thread":
      return (
        b.kind === "work-thread" &&
        String(a.threadId) === String(b.threadId) &&
        sameOptionalId(a.hostId, b.hostId)
      );
    case "code-overview":
    case "code-git":
    case "code-pr":
    case "code-local-review":
      return "threadId" in b && String(a.threadId) === String(b.threadId);
    case "code-file":
      return (
        b.kind === "code-file" &&
        String(a.threadId) === String(b.threadId) &&
        String(a.relativePath) === String(b.relativePath)
      );
    case "code-terminal":
      return (
        b.kind === "code-terminal" &&
        String(a.threadId) === String(b.threadId) &&
        sameOptionalId(a.terminalId, b.terminalId)
      );
    case "code-test":
      return (
        b.kind === "code-test" &&
        String(a.threadId) === String(b.threadId) &&
        sameOptionalId(a.testRunId, b.testRunId)
      );
    case "apple-workbench":
      return (
        b.kind === "apple-workbench" &&
        String(a.threadId) === String(b.threadId) &&
        String(a.projectPath) === String(b.projectPath)
      );
    case "browser":
      return (
        b.kind === "browser" &&
        a.mode === b.mode &&
        sameOptionalId(a.threadId, b.threadId) &&
        sameOptionalId(a.contextId, b.contextId)
      );
    case "files":
      return b.kind === "files" && a.mode === b.mode;
    case "side-chat":
      return b.kind === "side-chat" && String(a.sourceThreadId) === String(b.sourceThreadId);
    case "preview":
      return b.kind === "preview" && String(a.targetId) === String(b.targetId);
    case "canvas":
      return b.kind === "canvas" && String(a.canvasId) === String(b.canvasId);
  }
}

function sameOptionalId(a: unknown, b: unknown): boolean {
  return a === undefined ? b === undefined : b !== undefined && String(a) === String(b);
}

export function applyWorkspaceOperation(
  workspace: WindowWorkspace,
  operation: WorkspaceOperation,
): WindowWorkspace {
  validateWorkspace(workspace);
  const mode = operation.mode;
  const layout = workspace.layouts[mode];

  switch (operation.kind) {
    case "switch-project-surface": {
      if (!("mode" in operation.surface) || operation.surface.mode !== mode) {
        reject("invalid-layout", "Project switch surface mode must match the target layout");
      }
      // resolveWorkspaceContext has already stowed the outgoing Project layout
      // and restored (or reset) the destination layout, so the surface lands in
      // the destination's active pane instead of discarding restored state.
      const activePaneId = workspace.activePaneIds[mode];
      requirePane(layout, activePaneId);
      const visible = findSurfacePane(layout, operation.surface);
      if (visible !== undefined) {
        return finishOperation(activatePane(workspace, mode, visible.paneId));
      }
      if (hasSurfaceIdInWorkspace(workspace, operation.surface.id)) {
        reject("duplicate-id", "workspace surface ID already exists");
      }
      const mapped = mapPane(layout, activePaneId, (pane) => ({
        ...pane,
        surface: operation.surface,
      }));
      return finishOperation(
        activatePane(replaceLayout(workspace, mode, mapped.layout), mode, activePaneId),
      );
    }

    case "open-surface": {
      // Open replaces: a surface already visible in some pane gets that pane
      // activated, and anything else replaces the named pane's content. There
      // is no path that mints a second view of the same surface.
      const visible = findSurfacePane(layout, operation.surface);
      if (visible !== undefined) {
        return finishOperation(activatePane(workspace, mode, visible.paneId));
      }
      requirePane(layout, operation.paneId);
      if (hasSurfaceIdInWorkspace(workspace, operation.surface.id)) {
        reject("duplicate-id", "workspace surface ID already exists");
      }
      const mapped = mapPane(layout, operation.paneId, (pane) => ({
        ...pane,
        surface: operation.surface,
      }));
      return finishOperation(
        activatePane(replaceLayout(workspace, mode, mapped.layout), mode, operation.paneId),
      );
    }

    case "replace-pane-surface": {
      requirePane(layout, operation.paneId);
      const source = findSurfacePane(layout, operation.surface);
      if (source !== undefined) {
        if (String(source.paneId) === String(operation.paneId)) {
          return finishOperation(activatePane(workspace, mode, source.paneId));
        }
        // A center drop of a surface that is already visible moves it: the
        // source pane collapses and its surface object survives the move so
        // per-surface state keyed by its id (environment presentation) does.
        const removed = removePane(layout, source.paneId);
        if (removed.pane === undefined || removed.layout === undefined) {
          reject("missing-pane", "source pane could not be removed");
        }
        const mapped = mapPane(removed.layout, operation.paneId, (pane) => ({
          ...pane,
          surface: removed.pane!.surface,
        }));
        if (!mapped.found) reject("missing-pane", "target pane became unreachable");
        return finishOperation(
          activatePane(replaceLayout(workspace, mode, mapped.layout), mode, operation.paneId),
        );
      }
      if (hasSurfaceIdInWorkspace(workspace, operation.surface.id)) {
        reject("duplicate-id", "workspace surface ID already exists");
      }
      const mapped = mapPane(layout, operation.paneId, (pane) => ({
        ...pane,
        surface: operation.surface,
      }));
      return finishOperation(
        activatePane(replaceLayout(workspace, mode, mapped.layout), mode, operation.paneId),
      );
    }

    case "split-pane": {
      requirePane(layout, operation.targetPaneId);
      if (hasNodeIdInWorkspace(workspace, operation.splitNodeId)) {
        reject("duplicate-id", "split node ID already exists");
      }
      if (hasNodeIdInWorkspace(workspace, operation.newPaneNodeId)) {
        reject("duplicate-id", "new pane node ID already exists");
      }
      if (hasPaneIdInWorkspace(workspace, operation.newPaneId)) {
        reject("duplicate-id", "new pane ID already exists");
      }
      const source = findSurfacePane(layout, operation.surface);
      let working: WorkspaceLayoutNode = layout;
      let surface = operation.surface;
      if (source !== undefined) {
        if (String(source.paneId) === String(operation.targetPaneId)) {
          reject("redundant-split", "a pane cannot be split off itself");
        }
        // An edge drop of a visible surface moves its pane into the split
        // rather than duplicating the surface; the surface object survives so
        // per-surface state keyed by its id does.
        const removed = removePane(layout, source.paneId);
        if (removed.pane === undefined || removed.layout === undefined) {
          reject("missing-pane", "source pane could not be removed");
        }
        working = removed.layout;
        surface = removed.pane.surface;
      } else if (hasSurfaceIdInWorkspace(workspace, operation.surface.id)) {
        reject("duplicate-id", "workspace surface ID already exists");
      }
      const newPane: WorkspacePane = {
        kind: "pane",
        nodeId: operation.newPaneNodeId,
        paneId: operation.newPaneId,
        surface,
      };
      const mapped = mapPane(working, operation.targetPaneId, (target) => ({
        kind: "split",
        nodeId: operation.splitNodeId,
        orientation: operation.orientation,
        ratio: clamp(operation.ratio, MIN_SPLIT_RATIO, MAX_SPLIT_RATIO) as SplitRatio,
        first: operation.placement === "before" ? newPane : target,
        second: operation.placement === "before" ? target : newPane,
      }));
      if (!mapped.found) reject("missing-pane", "target pane became unreachable");
      return finishOperation(
        activatePane(replaceLayout(workspace, mode, mapped.layout), mode, operation.newPaneId),
      );
    }

    case "close-pane": {
      const removed = removePane(layout, operation.paneId);
      if (removed.pane === undefined) reject("missing-pane", "operation references a missing pane");
      // Closing the last pane leaves the mode's default welcome pane rather
      // than an empty tree: a mode always shows something.
      return finishOperation(replaceLayout(workspace, mode, removed.layout ?? defaultLayout(mode)));
    }

    case "resize-split": {
      const mapped = mapSplit(layout, operation.splitNodeId, (split) => ({
        ...split,
        ratio: clamp(operation.ratio, MIN_SPLIT_RATIO, MAX_SPLIT_RATIO) as SplitRatio,
      }));
      if (!mapped.found) reject("missing-node", "operation references a missing split");
      return finishOperation(replaceLayout(workspace, mode, mapped.layout));
    }

    case "focus-pane": {
      if (mode !== workspace.activeMode || findPane(layout, operation.paneId) === undefined) {
        reject("invalid-focus", "focused pane must be reachable in the active mode");
      }
      return finishOperation(
        activatePane({ ...workspace, focusedPaneId: operation.paneId }, mode, operation.paneId),
      );
    }

    case "unfocus-pane": {
      if (mode !== workspace.activeMode) {
        reject("invalid-focus", "unfocus operation must target the active mode");
      }
      const { focusedPaneId: _focusedPaneId, ...unfocused } = workspace;
      return finishOperation(unfocused);
    }

    case "reset-mode": {
      const layout = defaultLayout(mode);
      return finishOperation(
        activatePane(replaceLayout(workspace, mode, layout), mode, layout.paneId),
      );
    }

    case "set-active-mode": {
      const { focusedPaneId: _focusedPaneId, ...unfocused } = workspace;
      return finishOperation({ ...unfocused, activeMode: mode });
    }

    case "set-side-chat-sidecar": {
      const pane = requirePane(layout, operation.paneId);
      if (pane.surface.kind !== "side-chat") {
        reject("invalid-layout", "only Side Chat surfaces record a sidecar identity");
      }
      const mapped = mapPane(layout, operation.paneId, (candidate) => ({
        ...candidate,
        surface: withSideChatSidecar(candidate.surface, operation.sidecarThreadId),
      }));
      return finishOperation(
        activatePane(replaceLayout(workspace, mode, mapped.layout), mode, operation.paneId),
      );
    }
  }
}

/**
 * Record which sidecar a Side Chat tab was showing. A tab that already names a
 * different sidecar is refused: swapping would present a fresh conversation as
 * the restored one. Same-id is a no-op so a later Open of the same sidecar can
 * still activate the tab.
 */
function withSideChatSidecar(tab: WorkspaceTab, sidecarThreadId: ChatThreadId): WorkspaceTab {
  if (tab.kind !== "side-chat") return tab;
  if (tab.sidecarThreadId !== undefined) {
    if (String(tab.sidecarThreadId) !== String(sidecarThreadId)) {
      reject(
        "invalid-layout",
        "Side Chat tab already records a different sidecar. Close it and open Side Chat again.",
      );
    }
    return tab;
  }
  return { ...tab, sidecarThreadId };
}
