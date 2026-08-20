import {
  type WorkThreadId,
  type BrowserContextId,
  type BrowserThreadId,
  decodeLayoutNodeId,
  type ChatThreadId,
  type CodeThreadId,
  type EnvironmentPresentationState,
  type HostId,
  type ProjectId,
  decodeTabGroupId,
  decodeWorkspaceTabId,
  type LayoutNodeId,
  type MentionableThreadId,
  decodeMentionableThreadId,
  type SettingsDeepLink,
  type SideChatSidecar,
  type ShellBootstrap,
  type ShellSettings,
  type SplitRatio,
  type TabGroupId,
  type WindowId,
  type WindowWorkspace,
  type WorkspaceLayoutNode,
  type WorkspaceOperation,
  type WorkspaceSurfaceKind,
  type WorkspaceTab,
  type WorkspaceTabId,
} from "@octant/contracts";
import type { CanvasId } from "@octant/contracts/canvas";
import type {
  PreviewHostId,
  PreviewOpaqueRef,
  PreviewTargetId,
  PreviewTargetKind,
} from "@octant/contracts/previews";
import { createShellClient, type ShellClient } from "@octant/client-runtime/shell-client";
import type { OctantMode } from "@octant/contracts/modes";
import {
  applyWorkspaceOperation,
  buildSurfaceCatalog,
  normalizeEnvironmentPresentationState,
  reconcileWorkspaceWithSettings,
} from "@octant/domain/shell-policy";
import { enabledModes } from "@octant/domain/mode-policy";
import { sideChatTitle } from "@octant/domain";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ProjectWindowTarget } from "./hostBridge";
import { createTabActivationRegistry, type TabActivationRegistry } from "./TabActivation";
import type { WorkspaceTabDropDestination } from "./workspaceTabDragGeometry";

export const SHELL_BOOTSTRAP_TIMEOUT_MS = 10_000;

export type ShellControllerStatus =
  | "loading"
  | "ready"
  | "disconnected"
  | "recovery-required"
  | "conflict-reload";

export type ImplementedSettingId =
  | "enable-chat"
  | "enable-work"
  | "sidebar-width"
  | "sidebar-material"
  | "sidebar-background"
  | "mode-switcher"
  | "project-view-switcher"
  | "environment-presentation"
  | "theme-mode"
  | "theme-preset"
  | "ui-typography"
  | "editor-typography"
  | "terminal-typography"
  | "theme-accessibility"
  | "theme-import-export"
  | "reset-layout"
  | "reset-window-bounds"
  | "export-diagnostics";

export interface NativeShellHost {
  readonly resetBounds: () => Promise<void> | void;
  readonly openInNewWindow?: (target: ProjectWindowTarget) => Promise<void> | void;
}

export interface ShellControllerOptions {
  readonly bootstrapTimeoutMs?: number;
  readonly client?: ShellClient;
  readonly isNarrow?: boolean;
  readonly nativeHost?: NativeShellHost;
  readonly serverUrl: string;
  readonly windowId: WindowId;
}

interface AuthoritativeShell {
  readonly settings: ShellSettings;
  readonly settingsVersion: ShellBootstrap["settingsVersion"];
  readonly workspace: WindowWorkspace;
  readonly workspaceVersion: ShellBootstrap["workspaceVersion"];
  readonly environmentPresentation: EnvironmentPresentationState;
  readonly presentationVersion: ShellBootstrap["presentationVersion"];
}

interface ResizePreview {
  readonly ratio: SplitRatio;
  readonly splitNodeId: LayoutNodeId;
}

interface AnnouncementEvent {
  readonly message: string;
  readonly sequence: number;
}

interface WorkspaceMutation {
  readonly message: string;
  readonly operation: WorkspaceOperation;
  readonly newWindowTarget?: ProjectWindowTarget;
}

type CodeSurfaceTab = Extract<WorkspaceTab, { readonly mode: "code" }>;
type CodeSurfaceInput = CodeSurfaceTab extends infer Tab
  ? Tab extends CodeSurfaceTab
    ? Omit<Tab, "id" | "mode">
    : never
  : never;

type PreviewTab = Extract<WorkspaceTab, { readonly kind: "preview" }>;
type CanvasTab = Extract<WorkspaceTab, { readonly kind: "canvas" }>;
type SideChatTab = Extract<WorkspaceTab, { readonly kind: "side-chat" }>;
/**
 * Input for opening a persistent preview tab. The renderer receives the
 * opaque target identity from the host preview service; it never synthesizes
 * paths, credentials, or authority tokens. The host reauthorizes the opaque
 * target on every open/chunk/refresh after the tab is journaled.
 */
export interface PreviewTabInput {
  readonly mode: OctantMode;
  readonly title: string;
  readonly targetId: PreviewTargetId;
  readonly projectId: ProjectId;
  readonly hostId: PreviewHostId;
  readonly targetKind: PreviewTargetKind;
  readonly opaqueRef: PreviewOpaqueRef;
  readonly displayName: string;
  readonly boundCodeThreadId?: CodeThreadId;
}

export interface CanvasTabInput {
  readonly mode: OctantMode;
  readonly title: string;
  readonly canvasId: CanvasId;
  readonly projectId: ProjectId;
}

/**
 * The source thread a Side Chat tab asks about. Opening Side Chat from the
 * surface launcher binds the group's active thread; a group with no
 * open thread has nothing to ask about, so the surface is refused rather than
 * opened unbound.
 */
interface SideChatSource {
  readonly threadId: MentionableThreadId;
  readonly title: string;
}

type WorkspaceIntent =
  | { readonly kind: "activate-tab"; readonly groupId: TabGroupId; readonly tabId: WorkspaceTabId }
  | { readonly kind: "clear-focus" }
  | { readonly kind: "close-tab"; readonly groupId: TabGroupId; readonly tabId: WorkspaceTabId }
  | { readonly kind: "create-shell-tab" }
  | {
      readonly kind: "open-draft-thread";
      readonly mode: OctantMode;
      readonly projectId?: ProjectId;
    }
  | {
      readonly kind: "open-chat-thread";
      readonly threadId: ChatThreadId;
      readonly title: string;
      readonly projectId?: ProjectId;
    }
  | {
      readonly kind: "open-code-thread";
      readonly threadId: CodeThreadId;
      readonly title: string;
      readonly hostId?: HostId;
      readonly projectId?: ProjectId;
    }
  | {
      readonly kind: "open-work-thread";
      readonly threadId: WorkThreadId;
      readonly title: string;
      readonly hostId?: HostId;
      readonly projectId?: ProjectId;
    }
  | {
      readonly kind: "open-code-surface";
      readonly tab: CodeSurfaceInput;
    }
  | {
      readonly kind: "open-project";
      readonly projectId: ProjectId;
      readonly mode: OctantMode;
      readonly title: string;
    }
  | {
      readonly kind: "open-preview";
      readonly tab: PreviewTabInput;
    }
  | {
      readonly kind: "open-canvas";
      readonly tab: CanvasTabInput;
    }
  | {
      readonly kind: "open-side-chat";
      readonly sidecar: SideChatSidecar;
    }
  | { readonly kind: "focus-group"; readonly groupId: TabGroupId }
  | {
      readonly kind: "dock-tab";
      readonly fromGroupId: TabGroupId;
      readonly orientation: "horizontal" | "vertical";
      readonly placement: "before" | "after";
      readonly tabId: WorkspaceTabId;
      readonly targetGroupId: TabGroupId;
    }
  | {
      readonly kind: "move-tab";
      readonly fromGroupId: TabGroupId;
      readonly index: number;
      readonly tabId: WorkspaceTabId;
      readonly toGroupId: TabGroupId;
    }
  | {
      readonly kind: "open-surface";
      readonly surface: WorkspaceSurfaceKind;
      readonly groupId: TabGroupId | undefined;
      /** The Browser context this surface must show, when it has one of its own. */
      readonly browserContextId: BrowserContextId | undefined;
    }
  | {
      readonly kind: "reorder-tab";
      readonly groupId: TabGroupId;
      readonly index: number;
      readonly tabId: WorkspaceTabId;
    }
  | { readonly kind: "reset-layout" }
  | {
      readonly kind: "resize-split";
      readonly ratio: SplitRatio;
      readonly splitNodeId: LayoutNodeId;
    }
  | { readonly kind: "set-mode"; readonly mode: OctantMode }
  | {
      readonly kind: "split-group";
      readonly groupId: TabGroupId;
      readonly orientation: "horizontal" | "vertical";
      readonly placement: "before" | "after";
      readonly tabId: WorkspaceTabId;
    }
  | {
      readonly kind: "set-canvas-tab-pin";
      readonly groupId: TabGroupId;
      readonly tabId: WorkspaceTabId;
      readonly pinned: boolean;
    };

type SemanticMutation =
  | { readonly kind: "settings"; readonly patch: Partial<ShellSettings> }
  | { readonly kind: "presentation"; readonly presentation: EnvironmentPresentationState }
  | { readonly intent: WorkspaceIntent; readonly kind: "workspace" };

function nextAnnouncement(current: AnnouncementEvent, message: string): AnnouncementEvent {
  return { message, sequence: current.sequence + 1 };
}

const settingSearchText: Readonly<Record<ImplementedSettingId, string>> = {
  "enable-chat": "enable chat mode",
  "enable-work": "enable work mode",
  "sidebar-width": "sidebar width",
  "sidebar-material": "appearance translucent sidebar translucency material system opaque",
  "sidebar-background":
    "sidebar background image preset gradient custom upload overlay color opacity vibrancy",
  "mode-switcher": "mode switcher compact buttons dropdown sidebar navigation",
  "project-view-switcher": "project view switcher icons dropdown sidebar code",
  "environment-presentation":
    "environment panel presentation floating pinned hidden per mode default chat work code",
  "theme-mode": "theme mode system light dark appearance",
  "theme-preset": "theme preset Octant palette light dark",
  "ui-typography": "ui typography font family size prose interface",
  "editor-typography": "editor typography font code line height ligatures",
  "terminal-typography": "terminal typography font code line height ligatures",
  "theme-accessibility": "theme accessibility contrast motion transparency",
  "theme-import-export": "theme import export json vscode safe",
  "reset-layout": "reset active mode layout workspace",
  "reset-window-bounds": "reset native window bounds",
  "export-diagnostics": "export diagnostics evidence packet support redacted safe sealed receipt",
};

const implementedSettings = Object.keys(settingSearchText) as Array<ImplementedSettingId>;
const settledMutationQueue = Promise.resolve();

export function useShellController(options: ShellControllerOptions) {
  const fallbackClient = useMemo(
    () => createShellClient({ baseUrl: options.serverUrl, fetch: globalThis.fetch }),
    [options.serverUrl],
  );
  const client = options.client ?? fallbackClient;
  const bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? SHELL_BOOTSTRAP_TIMEOUT_MS;
  const requestGeneration = useRef(0);
  const bootstrapTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const committedShell = useRef<AuthoritativeShell | undefined>(undefined);
  const mutationQueue = useRef<Promise<void>>(settledMutationQueue);
  const activeLoad = useRef<Promise<void> | undefined>(undefined);
  const mounted = useRef(true);
  const tabActivation = useRef(createTabActivationRegistry()).current;
  const [status, setStatus] = useState<ShellControllerStatus>("loading");
  const [authoritative, setAuthoritative] = useState<AuthoritativeShell>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [crossContextOffer, setCrossContextOffer] = useState<
    | {
        readonly message: string;
        readonly newWindowProjectId: ProjectId | undefined;
        readonly target: ProjectWindowTarget | undefined;
      }
    | undefined
  >();
  const [announcementEvent, announce] = useReducer(nextAnnouncement, {
    message: "",
    sequence: 0,
  });
  const [settingsSearch, setSettingsSearch] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingSettingsDeepLink, setPendingSettingsDeepLink] = useState<
    SettingsDeepLink | undefined
  >();
  const [resizePreview, setResizePreview] = useState<ResizePreview>();

  const load = useCallback(
    (
      reason: "bootstrap" | "retry" | "command-recovery" | "conflict-reload" = "retry",
    ): Promise<void> => {
      const generation = ++requestGeneration.current;
      const isCommandReload = reason === "command-recovery" || reason === "conflict-reload";
      setStatus(isCommandReload ? "conflict-reload" : "loading");
      setErrorMessage(undefined);
      setCrossContextOffer(undefined);
      const task = (async () => {
        try {
          const bootstrap = await withTimeout(
            client.bootstrap(options.windowId),
            bootstrapTimeoutMs,
            bootstrapTimers.current,
          );
          if (!isCurrentRequest(generation, requestGeneration, mounted)) return;
          const next = fromBootstrap(bootstrap);
          committedShell.current = next;
          setAuthoritative(next);
          setResizePreview(undefined);
          setStatus("ready");
          if (reason === "conflict-reload") {
            announce("Shell state changed concurrently. Reloaded authoritative state.");
          } else if (reason === "command-recovery") {
            announce("Shell command outcome was uncertain. Reloaded authoritative state.");
          }
        } catch (error) {
          if (!isCurrentRequest(generation, requestGeneration, mounted)) return;
          const failure = shellFailure(error);
          committedShell.current = undefined;
          setAuthoritative(undefined);
          const message = isCommandReload
            ? `${failure.message} Queued shell operations were cancelled. Retry before issuing them again.`
            : failure.message;
          setErrorMessage(message);
          if (isCommandReload) announce(message);
          setStatus(
            failure.category === "recovery-required" ? "recovery-required" : "disconnected",
          );
        }
      })();
      activeLoad.current = task;
      void task.finally(() => {
        if (activeLoad.current === task) activeLoad.current = undefined;
      });
      return task;
    },
    [bootstrapTimeoutMs, client, options.windowId],
  );

  useEffect(() => {
    mounted.current = true;
    void load("bootstrap");
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
      for (const timer of bootstrapTimers.current) clearTimeout(timer);
      bootstrapTimers.current.clear();
    };
  }, [load]);

  /**
   * Resolves to whether the mutation actually committed.
   *
   * A conflict is recovered by reloading, which leaves the status `ready`
   * again, so a caller that only awaits this cannot tell a write that landed
   * from one the host discarded. Reporting the outcome lets a caller whose
   * next step depends on this write — first run recording its durable
   * outcome — stop instead of building on a state the host never accepted.
   */
  function enqueueMutation(mutation: SemanticMutation): Promise<boolean> {
    const queued = mutationQueue.current.then(async () => {
      const pendingLoad = activeLoad.current;
      if (pendingLoad !== undefined) await pendingLoad;
      if (!mounted.current) return false;
      const latest = committedShell.current;
      if (latest === undefined) return false;
      setStatus("ready");
      setErrorMessage(undefined);
      setCrossContextOffer(undefined);
      try {
        if (mutation.kind === "settings") {
          return await commitSettings(latest, mutation.patch);
        }
        if (mutation.kind === "presentation") {
          return await commitPresentation(latest, mutation.presentation);
        }
        const workspaceMutation = createWorkspaceMutation(latest, mutation.intent);
        noteTabActivation(tabActivation, workspaceMutation.operation);
        return await commitWorkspaceOperation(
          latest,
          workspaceMutation.operation,
          workspaceMutation.message,
          workspaceMutation.newWindowTarget,
        );
      } catch (error) {
        if (!mounted.current) return false;
        setAuthoritative(committedShell.current);
        await recoverCommandFailure(error);
        return false;
      }
    });
    mutationQueue.current = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async function commitWorkspaceOperation(
    previous: AuthoritativeShell,
    operation: WorkspaceOperation,
    message: string,
    requestedTarget?: ProjectWindowTarget,
  ): Promise<boolean> {
    const generation = ++requestGeneration.current;
    const preview = applyWorkspaceOperation(previous.workspace, operation);
    setAuthoritative({ ...previous, workspace: preview });
    setResizePreview(undefined);
    try {
      const result = await client.execute({
        kind: "apply-workspace-operation",
        windowId: options.windowId,
        expectedVersion: previous.workspaceVersion,
        operation,
      });
      if (!isCurrentRequest(generation, requestGeneration, mounted)) return false;
      if (result.kind !== "workspace-replaced") throw invalidResult();
      announce(message);
      const next = {
        ...previous,
        workspace: result.workspace,
        workspaceVersion: result.version,
      };
      committedShell.current = next;
      setAuthoritative(next);
      setStatus("ready");
      setErrorMessage(undefined);
      setCrossContextOffer(undefined);
      return true;
    } catch (error) {
      if (!isCurrentRequest(generation, requestGeneration, mounted)) return false;
      await recoverCommandFailure(error, operation, requestedTarget);
      return false;
    }
  }

  async function recoverCommandFailure(
    error: unknown,
    operation?: WorkspaceOperation,
    requestedTarget?: ProjectWindowTarget,
  ): Promise<void> {
    const failure = shellFailure(error);
    if (failure.category === "invalid" || failure.category === "unsupported") {
      setAuthoritative(committedShell.current);
      setErrorMessage(failure.message);
      setStatus("ready");
      announce(`Shell command rejected. ${failure.message}`);
      return;
    }
    if (failure.category === "cross-context") {
      setAuthoritative(committedShell.current);
      const target =
        requestedTarget ??
        (operation?.kind === "open-tab" && operation.tab.kind === "project"
          ? ({ kind: "project", projectId: operation.tab.projectId } as const)
          : undefined);
      setCrossContextOffer({
        message: failure.message,
        newWindowProjectId: target === undefined ? undefined : (target.projectId as ProjectId),
        target,
      });
      setStatus("ready");
      announce(failure.message);
      return;
    }
    if (failure.category === "recovery-required") {
      setAuthoritative(committedShell.current);
      setErrorMessage(failure.message);
      setStatus("recovery-required");
      announce(failure.message);
      return;
    }
    await load(failure.category === "conflict" ? "conflict-reload" : "command-recovery");
  }

  async function setMode(mode: OctantMode): Promise<void> {
    await enqueueMutation({ kind: "workspace", intent: { kind: "set-mode", mode } });
  }

  async function createShellTab(): Promise<void> {
    await enqueueMutation({ kind: "workspace", intent: { kind: "create-shell-tab" } });
  }

  async function openDraftThread(mode: OctantMode, projectId?: ProjectId): Promise<void> {
    if (authoritative?.workspace.activeMode !== mode) {
      await enqueueMutation({ kind: "workspace", intent: { kind: "set-mode", mode } });
    }
    await enqueueMutation({
      kind: "workspace",
      intent: {
        kind: "open-draft-thread",
        mode,
        ...(projectId === undefined ? {} : { projectId }),
      },
    });
  }

  async function openChatThread(
    threadId: ChatThreadId,
    title: string,
    projectId?: ProjectId,
  ): Promise<boolean> {
    if (authoritative?.workspace.activeMode !== "chat") {
      await enqueueMutation({ kind: "workspace", intent: { kind: "set-mode", mode: "chat" } });
      if (committedShell.current?.workspace.activeMode !== "chat") return false;
    }
    await enqueueMutation({
      kind: "workspace",
      intent: {
        kind: "open-chat-thread",
        threadId,
        title,
        ...(projectId === undefined ? {} : { projectId }),
      },
    });
    const workspace = committedShell.current?.workspace;
    return (
      workspace?.activeMode === "chat" &&
      findChatThreadTab(workspace.layouts.chat, threadId) !== undefined
    );
  }

  async function openCodeThread(
    threadId: CodeThreadId,
    title: string,
    hostId?: HostId,
    projectId?: ProjectId,
  ): Promise<void> {
    if (authoritative?.workspace.activeMode !== "code") {
      await enqueueMutation({ kind: "workspace", intent: { kind: "set-mode", mode: "code" } });
    }
    await enqueueMutation({
      kind: "workspace",
      intent: {
        kind: "open-code-thread",
        threadId,
        title,
        ...(hostId === undefined ? {} : { hostId }),
        ...(projectId === undefined ? {} : { projectId }),
      },
    });
  }

  async function openWorkThread(
    threadId: WorkThreadId,
    title: string,
    hostId?: HostId,
    projectId?: ProjectId,
  ): Promise<void> {
    if (authoritative?.workspace.activeMode !== "work") {
      await enqueueMutation({ kind: "workspace", intent: { kind: "set-mode", mode: "work" } });
    }
    await enqueueMutation({
      kind: "workspace",
      intent: {
        kind: "open-work-thread",
        threadId,
        title,
        ...(hostId === undefined ? {} : { hostId }),
        ...(projectId === undefined ? {} : { projectId }),
      },
    });
  }

  async function openCodeSurface(tab: CodeSurfaceInput): Promise<void> {
    if (authoritative?.workspace.activeMode !== "code") {
      await enqueueMutation({ kind: "workspace", intent: { kind: "set-mode", mode: "code" } });
    }
    await enqueueMutation({ kind: "workspace", intent: { kind: "open-code-surface", tab } });
  }

  async function openProject(projectId: ProjectId, mode: OctantMode, title: string): Promise<void> {
    if (authoritative?.workspace.activeMode !== mode) {
      await enqueueMutation({ kind: "workspace", intent: { kind: "set-mode", mode } });
    }
    await enqueueMutation({
      kind: "workspace",
      intent: { kind: "open-project", projectId, mode, title },
    });
  }

  async function openPreview(tab: PreviewTabInput): Promise<void> {
    if (authoritative?.workspace.activeMode !== tab.mode) {
      await enqueueMutation({ kind: "workspace", intent: { kind: "set-mode", mode: tab.mode } });
    }
    await enqueueMutation({ kind: "workspace", intent: { kind: "open-preview", tab } });
  }

  async function openCanvas(tab: CanvasTabInput): Promise<void> {
    if (authoritative?.workspace.activeMode !== tab.mode) {
      await enqueueMutation({ kind: "workspace", intent: { kind: "set-mode", mode: tab.mode } });
    }
    await enqueueMutation({ kind: "workspace", intent: { kind: "open-canvas", tab } });
  }

  /**
   * Open the Side Chat tab for a sidecar the host has already resolved. The
   * sidecar linkage is the host's answer to "which conversation is this lane",
   * so the tab is journaled with that identity and reopens the same sidecar
   * after a restart instead of minting a second one.
   */
  async function openSideChat(sidecar: SideChatSidecar): Promise<void> {
    if (authoritative?.workspace.activeMode !== sidecar.sourceMode) {
      await enqueueMutation({
        kind: "workspace",
        intent: { kind: "set-mode", mode: sidecar.sourceMode },
      });
    }
    await enqueueMutation({ kind: "workspace", intent: { kind: "open-side-chat", sidecar } });
  }

  function openSettings(deepLink?: SettingsDeepLink): Promise<void> {
    if (deepLink !== undefined) setPendingSettingsDeepLink(deepLink);
    setSettingsOpen(true);
    return Promise.resolve();
  }

  function closeSettings(): void {
    setSettingsOpen(false);
    setPendingSettingsDeepLink(undefined);
  }

  function clearPendingSettingsDeepLink(): void {
    setPendingSettingsDeepLink(undefined);
  }

  /**
   * Open one workspace surface in a group.
   *
   * `browserContextId` names a host-owned Browser context opened for exactly
   * one target — a Local servers Open. Tabs are deduplicated by that
   * identity together with the thread, so the ordinary Browser surface still
   * reuses the thread's single tab while every Open of a local server gets a
   * tab of its own instead of replacing the previous server's page.
   *
   * Resolves to whether a tab bound to `browserContextId` is committed. A
   * caller that minted a context for this Open must release it when this is
   * `false`: a rejected mutation is recovered rather than thrown, so the call
   * settling is no evidence the context has a close path. An Open naming no
   * context has nothing to confirm and resolves `true`.
   */
  async function openSurface(
    surface: WorkspaceSurfaceKind,
    groupId?: TabGroupId,
    browserContextId?: BrowserContextId,
  ): Promise<boolean> {
    const before = committedShell.current;
    const beforeMode = before?.workspace.activeMode;
    const beforeGroup =
      before === undefined || beforeMode === undefined
        ? undefined
        : groupId === undefined
          ? preferredGroup(before.workspace, beforeMode)
          : (findGroup(before.workspace.layouts[beforeMode], groupId) ??
            preferredGroup(before.workspace, beforeMode));
    const browserThreadId =
      surface === "browser" && beforeGroup !== undefined
        ? activeBoundThreadId(beforeGroup)
        : undefined;
    const shouldCreateBrowserSplit =
      surface === "browser" &&
      before !== undefined &&
      beforeMode !== undefined &&
      browserThreadId !== undefined &&
      findBrowserTab(before.workspace.layouts[beforeMode], browserThreadId, browserContextId) ===
        undefined;

    await enqueueMutation({
      kind: "workspace",
      intent: { kind: "open-surface", surface, groupId, browserContextId },
    });

    const adopted =
      browserContextId === undefined ||
      committedBrowserContextTab(committedShell.current, browserContextId);

    if (!shouldCreateBrowserSplit || beforeMode === undefined || browserThreadId === undefined) {
      return adopted;
    }
    const after = committedShell.current;
    if (after === undefined || after.workspace.activeMode !== beforeMode) return adopted;
    const opened = findBrowserTab(
      after.workspace.layouts[beforeMode],
      browserThreadId,
      browserContextId,
    );
    if (opened === undefined) return adopted;
    const openedGroup = findGroup(after.workspace.layouts[beforeMode], opened.groupId);
    if (openedGroup === undefined || openedGroup.tabs.length < 2) return adopted;
    await enqueueMutation({
      kind: "workspace",
      intent: {
        kind: "split-group",
        groupId: opened.groupId,
        tabId: opened.tabId,
        orientation: "horizontal",
        placement: "after",
      },
    });
    return adopted;
  }

  function dismissCrossContextOffer(): void {
    setCrossContextOffer(undefined);
  }

  async function openCrossContextInNewWindow(): Promise<void> {
    const offer = crossContextOffer;
    if (offer?.target === undefined) return;
    const opener = options.nativeHost?.openInNewWindow;
    if (opener === undefined) return;
    await opener(offer.target);
    setCrossContextOffer(undefined);
  }

  /** Resolves to whether the host accepted the patch. */
  async function updateSettings(patch: Partial<ShellSettings>): Promise<boolean> {
    return await enqueueMutation({ kind: "settings", patch });
  }

  async function setEnvironmentPresentation(
    presentation: EnvironmentPresentationState,
  ): Promise<void> {
    await enqueueMutation({ kind: "presentation", presentation });
  }

  async function commitPresentation(
    previous: AuthoritativeShell,
    presentation: EnvironmentPresentationState,
  ): Promise<boolean> {
    const generation = ++requestGeneration.current;
    setAuthoritative({ ...previous, environmentPresentation: presentation });
    try {
      const result = await client.execute({
        kind: "set-environment-presentation",
        windowId: options.windowId,
        expectedVersion: previous.presentationVersion,
        presentation,
      });
      if (!isCurrentRequest(generation, requestGeneration, mounted)) return false;
      if (result.kind !== "environment-presentation-replaced") throw invalidResult();
      const next: AuthoritativeShell = {
        ...previous,
        environmentPresentation: result.presentation,
        presentationVersion: result.version,
      };
      committedShell.current = next;
      setAuthoritative(next);
      setStatus("ready");
      setErrorMessage(undefined);
      setCrossContextOffer(undefined);
      announce("Environment presentation saved.");
      return true;
    } catch (error) {
      if (!isCurrentRequest(generation, requestGeneration, mounted)) return false;
      await recoverCommandFailure(error);
      return false;
    }
  }

  async function commitSettings(
    previous: AuthoritativeShell,
    patch: Partial<ShellSettings>,
  ): Promise<boolean> {
    const generation = ++requestGeneration.current;
    const settings = { ...previous.settings, ...patch };
    const reconciled = reconcileWorkspaceWithSettings(previous.workspace, settings);
    const optimisticPresentation = normalizeEnvironmentPresentationState({
      byTab: previous.environmentPresentation.byTab,
      byMode: settings.environmentPresentationByMode,
    });
    setAuthoritative({
      ...previous,
      settings,
      workspace: reconciled,
      environmentPresentation: optimisticPresentation,
    });
    try {
      let next: AuthoritativeShell = previous;
      if (reconciled.activeMode !== previous.workspace.activeMode) {
        const workspaceResult = await client.execute({
          kind: "apply-workspace-operation",
          windowId: options.windowId,
          expectedVersion: previous.workspaceVersion,
          operation: { kind: "set-active-mode", mode: reconciled.activeMode },
        });
        if (!isCurrentRequest(generation, requestGeneration, mounted)) return false;
        if (workspaceResult.kind !== "workspace-replaced") throw invalidResult();
        next = {
          ...next,
          workspace: workspaceResult.workspace,
          workspaceVersion: workspaceResult.version,
        };
        committedShell.current = next;
        setAuthoritative({ ...next, settings });
      }
      const result = await client.execute({
        kind: "replace-settings",
        windowId: options.windowId,
        expectedVersion: previous.settingsVersion,
        settings,
      });
      if (!isCurrentRequest(generation, requestGeneration, mounted)) return false;
      if (result.kind !== "settings-replaced") throw invalidResult();
      const mergedPresentation = normalizeEnvironmentPresentationState({
        byTab: previous.environmentPresentation.byTab,
        byMode: result.settings.environmentPresentationByMode,
      });
      next = {
        ...next,
        settings: result.settings,
        settingsVersion: result.version,
        environmentPresentation: mergedPresentation,
      };
      committedShell.current = next;
      setAuthoritative(next);
      setStatus("ready");
      setErrorMessage(undefined);
      setCrossContextOffer(undefined);
      announce("Shell settings saved.");
      return true;
    } catch (error) {
      if (!isCurrentRequest(generation, requestGeneration, mounted)) return false;
      await recoverCommandFailure(error);
      return false;
    }
  }

  async function activateTab(groupId: TabGroupId, tabId: WorkspaceTabId): Promise<void> {
    await enqueueMutation({ kind: "workspace", intent: { kind: "activate-tab", groupId, tabId } });
  }

  async function closeTab(groupId: TabGroupId, tabId: WorkspaceTabId): Promise<boolean> {
    await enqueueMutation({ kind: "workspace", intent: { kind: "close-tab", groupId, tabId } });
    const latest = committedShell.current;
    return latest !== undefined && findTabById(latest.workspace, tabId) === undefined;
  }

  async function reorderTab(
    groupId: TabGroupId,
    tabId: WorkspaceTabId,
    index: number,
  ): Promise<void> {
    await enqueueMutation({
      kind: "workspace",
      intent: { kind: "reorder-tab", groupId, tabId, index },
    });
  }

  async function setCanvasTabPin(
    groupId: TabGroupId,
    tabId: WorkspaceTabId,
    pinned: boolean,
  ): Promise<void> {
    await enqueueMutation({
      kind: "workspace",
      intent: { kind: "set-canvas-tab-pin", groupId, tabId, pinned },
    });
  }

  async function toggleCanvasTabPin(
    groupId: TabGroupId,
    tab: Extract<WorkspaceTab, { readonly kind: "canvas" }>,
  ): Promise<void> {
    await setCanvasTabPin(groupId, tab.id, tab.pinned !== true);
  }

  async function splitGroup(
    groupId: TabGroupId,
    tabId: WorkspaceTabId,
    orientation: "horizontal" | "vertical",
    placement: "before" | "after" = "after",
  ): Promise<void> {
    await enqueueMutation({
      kind: "workspace",
      intent: { kind: "split-group", groupId, tabId, orientation, placement },
    });
  }

  async function moveTab(
    fromGroupId: TabGroupId,
    toGroupId: TabGroupId,
    tabId: WorkspaceTabId,
    index: number,
  ): Promise<void> {
    await enqueueMutation({
      kind: "workspace",
      intent: { kind: "move-tab", fromGroupId, toGroupId, tabId, index },
    });
  }

  async function dockTab(
    fromGroupId: TabGroupId,
    targetGroupId: TabGroupId,
    tabId: WorkspaceTabId,
    orientation: "horizontal" | "vertical",
    placement: "before" | "after",
  ): Promise<void> {
    await enqueueMutation({
      kind: "workspace",
      intent: {
        kind: "dock-tab",
        fromGroupId,
        targetGroupId,
        tabId,
        orientation,
        placement,
      },
    });
  }

  async function dropTab(destination: WorkspaceTabDropDestination): Promise<void> {
    // Cross-Project denial for preview tabs: a preview tab carries its own
    // opaque Project binding. Dropping it into a group whose mode context is
    // bound to a different Project (or no Project) would violate the
    // one-Project invariant. Deny at the renderer so the host never journals
    // a cross-context open; the server still re-checks authority on restore.
    if (destination.kind !== "reorder") {
      const source = authoritative?.workspace;
      if (source !== undefined) {
        const tab = findTabById(source, destination.tabId);
        const targetMode = findGroupMode(source, destination.targetGroupId);
        if (
          tab?.kind === "preview" &&
          targetMode !== undefined &&
          source.contextByMode[targetMode].projectId !== tab.projectId
        ) {
          announce("Preview belongs to a different Project. Open it there instead.");
          return;
        }
        if (
          tab?.kind === "canvas" &&
          targetMode !== undefined &&
          source.contextByMode[targetMode].projectId !== null &&
          source.contextByMode[targetMode].projectId !== tab.projectId
        ) {
          announce("Canvas belongs to a different Project. Open it there instead.");
          return;
        }
      }
    }
    if (destination.kind === "reorder") {
      await reorderTab(destination.sourceGroupId, destination.tabId, destination.index);
      return;
    }
    if (destination.kind === "center") {
      await moveTab(
        destination.sourceGroupId,
        destination.targetGroupId,
        destination.tabId,
        destination.index,
      );
      return;
    }
    const orientation =
      destination.edge === "left" || destination.edge === "right" ? "horizontal" : "vertical";
    const placement =
      destination.edge === "left" || destination.edge === "top" ? "before" : "after";
    if (destination.sourceGroupId === destination.targetGroupId) {
      await splitGroup(destination.sourceGroupId, destination.tabId, orientation, placement);
      return;
    }
    await dockTab(
      destination.sourceGroupId,
      destination.targetGroupId,
      destination.tabId,
      orientation,
      placement,
    );
  }

  function previewSplitResize(splitNodeId: LayoutNodeId, ratio: number): void {
    setResizePreview(() => ({ splitNodeId, ratio: ratio as SplitRatio }));
  }

  async function commitSplitResize(splitNodeId: LayoutNodeId, ratio: number): Promise<void> {
    await enqueueMutation({
      kind: "workspace",
      intent: { kind: "resize-split", splitNodeId, ratio: ratio as SplitRatio },
    });
  }

  async function focusGroup(groupId: TabGroupId): Promise<void> {
    await enqueueMutation({ kind: "workspace", intent: { kind: "focus-group", groupId } });
  }

  async function clearFocus(): Promise<void> {
    await enqueueMutation({ kind: "workspace", intent: { kind: "clear-focus" } });
  }

  async function resetActiveLayout(): Promise<void> {
    await enqueueMutation({ kind: "workspace", intent: { kind: "reset-layout" } });
  }

  async function resetNativeBounds(): Promise<void> {
    if (options.nativeHost === undefined) return;
    const generation = requestGeneration.current;
    try {
      await options.nativeHost.resetBounds();
    } catch {
      if (generation !== requestGeneration.current) return;
      announce("Unable to reset native window bounds.");
      return;
    }
    if (generation !== requestGeneration.current) return;
    announce("Native window bounds reset.");
  }

  const activeLayout = authoritative?.workspace.layouts[authoritative.workspace.activeMode];
  const previewedLayout =
    authoritative !== undefined && activeLayout !== undefined && resizePreview !== undefined
      ? applyWorkspaceOperation(authoritative.workspace, {
          kind: "resize-split",
          mode: authoritative.workspace.activeMode,
          splitNodeId: resizePreview.splitNodeId,
          ratio: resizePreview.ratio,
        }).layouts[authoritative.workspace.activeMode]
      : activeLayout;
  const presentedLayout = presentationLayout(
    previewedLayout,
    authoritative?.workspace.focusedGroupId,
    authoritative === undefined
      ? undefined
      : authoritative.workspace.activeGroupIds[authoritative.workspace.activeMode],
    options.isNarrow ?? false,
  );
  const normalizedSearch = normalizeSettingsSearch(settingsSearch);
  const visibleSettings = implementedSettings.filter(
    (setting) => normalizedSearch === "" || settingSearchText[setting].includes(normalizedSearch),
  );
  // Derive the surface catalog from the live workspace context so the launcher
  // reflects context changes (e.g. first Project open) without a full reload.
  const availableSurfaces =
    authoritative === undefined
      ? undefined
      : buildSurfaceCatalog(authoritative.workspace.contextByMode);

  return {
    activateTab,
    announcement: announcementEvent.message,
    announcementSequence: announcementEvent.sequence,
    availableSurfaces,
    clearFocus,
    clearPendingSettingsDeepLink,
    closeSettings,
    environmentPresentation: authoritative?.environmentPresentation,
    presentationVersion: authoritative?.presentationVersion,
    closeTab,
    commitSplitResize,
    createShellTab,
    crossContextOffer,
    dismissCrossContextOffer,
    openCrossContextInNewWindow,
    canOpenCrossContextInNewWindow: options.nativeHost?.openInNewWindow !== undefined,
    dockTab,
    dropTab,
    errorMessage,
    focusGroup,
    moveTab,
    openDraftThread,
    openChatThread,
    openCodeThread,
    openWorkThread,
    openCodeSurface,
    openPreview,
    openCanvas,
    openProject,
    openSideChat,
    openSettings,
    openSurface,
    pendingSettingsDeepLink,
    presentedLayout,
    previewSplitResize,
    reorderTab,
    resetActiveLayout,
    resetNativeBounds,
    retry: () => load("retry"),
    setCanvasTabPin,
    setEnvironmentPresentation,
    setMode,
    setSettingsSearch,
    settings: authoritative?.settings,
    settingsOpen,
    settingsSearch,
    splitGroup,
    status,
    tabActivation,
    toggleCanvasTabPin,
    updateSettings,
    visibleSettings,
    workspace: authoritative?.workspace,
  };
}

function normalizeSettingsSearch(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Records the tab a workspace intent brings to the front. Every intent is a
 * gesture in this window, so opening, switching to, or activating a tab is the
 * person asking for it. A restored layout arrives through bootstrap instead and
 * is deliberately never recorded.
 */
function noteTabActivation(registry: TabActivationRegistry, operation: WorkspaceOperation): void {
  if (operation.kind === "open-tab" || operation.kind === "switch-project-tab") {
    registry.noteActivated(operation.tab.id);
    return;
  }
  if (operation.kind === "activate-tab") registry.noteActivated(operation.tabId);
}

function createWorkspaceMutation(
  latest: AuthoritativeShell,
  intent: WorkspaceIntent,
): WorkspaceMutation {
  const mode = latest.workspace.activeMode;
  switch (intent.kind) {
    case "set-mode":
      if (!enabledModes(latest.settings).includes(intent.mode)) {
        throw {
          category: "unsupported",
          message: `${modeLabel(intent.mode)} mode is disabled.`,
        };
      }
      return {
        operation: { kind: "set-active-mode", mode: intent.mode },
        message: `${modeLabel(intent.mode)} workspace selected.`,
      };
    case "create-shell-tab": {
      const group = preferredGroup(latest.workspace, mode);
      return {
        operation: {
          kind: "open-tab",
          mode,
          groupId: group.groupId,
          tab: {
            kind: "welcome",
            id: newTabId(),
            mode,
            title: `${modeLabel(mode)} Workspace`,
          },
        },
        message: `${modeLabel(mode)} shell tab opened.`,
      };
    }
    case "open-draft-thread": {
      if (intent.mode !== mode) {
        throw {
          category: "invalid",
          message: `Draft mode ${intent.mode} does not match the active workspace.`,
        };
      }
      const existingDraft = findDraftThreadTab(latest.workspace.layouts[mode], intent.projectId);
      if (existingDraft !== undefined) {
        return {
          operation: {
            kind: "activate-tab",
            mode,
            groupId: existingDraft.groupId,
            tabId: existingDraft.tabId,
          },
          message: `Draft ${modeLabel(mode)} thread selected.`,
        };
      }
      const group = preferredGroup(latest.workspace, mode);
      return {
        operation: {
          kind: "open-tab",
          mode,
          groupId: group.groupId,
          tab: {
            kind: "draft-thread",
            id: newTabId(),
            mode,
            title: `New ${modeLabel(mode)} thread`,
            ...(intent.projectId === undefined ? {} : { projectId: intent.projectId }),
          },
        },
        message: `New ${modeLabel(mode)} thread draft opened.`,
      };
    }
    case "open-chat-thread": {
      if (mode !== "chat") {
        throw { category: "invalid", message: "Chat thread tabs are valid only in Chat mode." };
      }
      const existing = findChatThreadTab(latest.workspace.layouts.chat, intent.threadId);
      const group = preferredGroup(latest.workspace, "chat");
      const tab = {
        kind: "chat-thread" as const,
        id: newTabId(),
        threadId: intent.threadId,
        mode: "chat" as const,
        title: intent.title,
      };
      if (isDifferentProject(latest.workspace, "chat", intent.projectId)) {
        return {
          operation: { kind: "switch-project-tab", mode: "chat", tab },
          message: `${intent.title} opened in this window.`,
        };
      }
      return existing === undefined
        ? {
            operation: {
              kind: "open-tab",
              mode: "chat",
              groupId: group.groupId,
              tab,
            },
            message: `${intent.title} opened.`,
          }
        : {
            operation: {
              kind: "activate-tab",
              mode: "chat",
              groupId: existing.groupId,
              tabId: existing.tabId,
            },
            message: `${intent.title} selected.`,
          };
    }
    case "open-code-thread": {
      if (mode !== "code") {
        throw { category: "invalid", message: "Code thread tabs are valid only in Code mode." };
      }
      const existing = findCodeThreadTab(
        latest.workspace.layouts.code,
        intent.threadId,
        intent.hostId,
      );
      const group = preferredGroup(latest.workspace, "code");
      const tab = {
        kind: "code-overview" as const,
        id: newTabId(),
        threadId: intent.threadId,
        mode: "code" as const,
        title: intent.title,
        ...(intent.hostId === undefined ? {} : { hostId: intent.hostId }),
      };
      if (isDifferentProject(latest.workspace, "code", intent.projectId)) {
        return {
          operation: { kind: "switch-project-tab", mode: "code", tab },
          message: `${intent.title} opened in this window.`,
          ...(intent.projectId === undefined
            ? {}
            : {
                newWindowTarget: {
                  kind: "project-thread" as const,
                  projectId: intent.projectId,
                  mode: "code" as const,
                  threadId: intent.threadId,
                },
              }),
        };
      }
      return existing === undefined
        ? {
            operation: {
              kind: "open-tab",
              mode: "code",
              groupId: group.groupId,
              tab,
            },
            message: `${intent.title} opened.`,
            ...(intent.projectId === undefined
              ? {}
              : {
                  newWindowTarget: {
                    kind: "project-thread" as const,
                    projectId: intent.projectId,
                    mode: "code" as const,
                    threadId: intent.threadId,
                  },
                }),
          }
        : {
            operation: {
              kind: "activate-tab",
              mode: "code",
              groupId: existing.groupId,
              tabId: existing.tabId,
            },
            message: `${intent.title} selected.`,
            ...(intent.projectId === undefined
              ? {}
              : {
                  newWindowTarget: {
                    kind: "project-thread" as const,
                    projectId: intent.projectId,
                    mode: "code" as const,
                    threadId: intent.threadId,
                  },
                }),
          };
    }
    case "open-work-thread": {
      if (mode !== "work") {
        throw { category: "invalid", message: "Work thread tabs are valid only in Work mode." };
      }
      const existing = findWorkThreadTab(
        latest.workspace.layouts.work,
        intent.threadId,
        intent.hostId,
      );
      const group = preferredGroup(latest.workspace, "work");
      const tab = {
        kind: "work-thread" as const,
        id: newTabId(),
        threadId: intent.threadId,
        mode: "work" as const,
        title: intent.title,
        ...(intent.hostId === undefined ? {} : { hostId: intent.hostId }),
      };
      if (isDifferentProject(latest.workspace, "work", intent.projectId)) {
        return {
          operation: { kind: "switch-project-tab", mode: "work", tab },
          message: `${intent.title} opened in this window.`,
          ...(intent.projectId === undefined
            ? {}
            : {
                newWindowTarget: {
                  kind: "project-thread" as const,
                  projectId: intent.projectId,
                  mode: "work" as const,
                  threadId: intent.threadId,
                },
              }),
        };
      }
      return existing === undefined
        ? {
            operation: {
              kind: "open-tab",
              mode: "work",
              groupId: group.groupId,
              tab,
            },
            message: `${intent.title} opened.`,
            ...(intent.projectId === undefined
              ? {}
              : {
                  newWindowTarget: {
                    kind: "project-thread" as const,
                    projectId: intent.projectId,
                    mode: "work" as const,
                    threadId: intent.threadId,
                  },
                }),
          }
        : {
            operation: {
              kind: "activate-tab",
              mode: "work",
              groupId: existing.groupId,
              tabId: existing.tabId,
            },
            message: `${intent.title} selected.`,
            ...(intent.projectId === undefined
              ? {}
              : {
                  newWindowTarget: {
                    kind: "project-thread" as const,
                    projectId: intent.projectId,
                    mode: "work" as const,
                    threadId: intent.threadId,
                  },
                }),
          };
    }
    case "open-code-surface": {
      if (mode !== "code") {
        throw { category: "invalid", message: "Code tabs are valid only in Code mode." };
      }
      const existing = findCodeSurfaceTab(latest.workspace.layouts.code, intent.tab);
      const group = preferredGroup(latest.workspace, "code");
      // A second terminal for the same thread would otherwise arrive with the
      // same title as the first, leaving two tabs nobody can tell apart.
      const title =
        intent.tab.kind === "code-terminal"
          ? unusedCodeTerminalTitle(latest.workspace.layouts.code, intent.tab.threadId)
          : intent.tab.title;
      return existing === undefined
        ? {
            operation: {
              kind: "open-tab",
              mode: "code",
              groupId: group.groupId,
              tab: { ...intent.tab, title, id: newTabId(), mode: "code" } as Extract<
                WorkspaceTab,
                { readonly mode: "code" }
              >,
            },
            message: `${title} opened.`,
          }
        : {
            operation: {
              kind: "activate-tab",
              mode: "code",
              groupId: existing.groupId,
              tabId: existing.tabId,
            },
            message: `${intent.tab.title} selected.`,
          };
    }
    case "open-project": {
      if (intent.mode !== mode) {
        throw { category: "invalid", message: "Project mode does not match the active workspace." };
      }
      const existing = findProjectTab(latest.workspace.layouts[mode], intent.projectId);
      const group = preferredGroup(latest.workspace, mode);
      const tab = {
        kind: "project" as const,
        id: newTabId(),
        projectId: intent.projectId,
        mode,
        title: intent.title,
      };
      if (isDifferentProject(latest.workspace, mode, intent.projectId)) {
        return {
          operation: { kind: "switch-project-tab", mode, tab },
          message: `${intent.title} opened in this window.`,
          newWindowTarget: { kind: "project", projectId: intent.projectId },
        };
      }
      return existing === undefined
        ? {
            operation: {
              kind: "open-tab",
              mode,
              groupId: group.groupId,
              tab,
            },
            message: `${intent.title} opened.`,
            newWindowTarget: { kind: "project", projectId: intent.projectId },
          }
        : {
            operation: {
              kind: "activate-tab",
              mode,
              groupId: existing.groupId,
              tabId: existing.tabId,
            },
            message: `${intent.title} selected.`,
            newWindowTarget: { kind: "project", projectId: intent.projectId },
          };
    }
    case "open-preview": {
      if (intent.tab.mode !== mode) {
        throw {
          category: "invalid",
          message: "Preview tab mode does not match the active workspace.",
        };
      }
      const existing = findPreviewTab(latest.workspace.layouts[mode], intent.tab.targetId);
      const group = preferredGroup(latest.workspace, mode);
      const tab: PreviewTab = {
        kind: "preview",
        id: newTabId(),
        mode,
        title: intent.tab.title,
        targetId: intent.tab.targetId,
        projectId: intent.tab.projectId,
        hostId: intent.tab.hostId,
        targetKind: intent.tab.targetKind,
        opaqueRef: intent.tab.opaqueRef,
        displayName: intent.tab.displayName,
        ...(intent.tab.boundCodeThreadId === undefined
          ? {}
          : { boundCodeThreadId: intent.tab.boundCodeThreadId }),
      };
      return existing === undefined
        ? {
            operation: { kind: "open-tab", mode, groupId: group.groupId, tab },
            message: `${intent.tab.title} opened.`,
          }
        : {
            operation: {
              kind: "activate-tab",
              mode,
              groupId: existing.groupId,
              tabId: existing.tabId,
            },
            message: `${intent.tab.title} selected.`,
          };
    }
    case "open-canvas": {
      if (intent.tab.mode !== mode) {
        throw {
          category: "invalid",
          message: "Canvas tab mode does not match the active workspace.",
        };
      }
      const existing = findCanvasTab(latest.workspace.layouts[mode], intent.tab.canvasId);
      const group = preferredGroup(latest.workspace, mode);
      const tab: CanvasTab = {
        kind: "canvas",
        id: newTabId(),
        mode,
        title: intent.tab.title,
        canvasId: intent.tab.canvasId,
        projectId: intent.tab.projectId,
      };
      return existing === undefined
        ? {
            operation: { kind: "open-tab", mode, groupId: group.groupId, tab },
            message: `${intent.tab.title} opened.`,
          }
        : {
            operation: {
              kind: "activate-tab",
              mode,
              groupId: existing.groupId,
              tabId: existing.tabId,
            },
            message: `${intent.tab.title} selected.`,
          };
    }
    case "open-side-chat": {
      if (intent.sidecar.sourceMode !== mode) {
        throw {
          category: "invalid",
          message: "Side Chat tab mode does not match the active workspace.",
        };
      }
      const existing = findSideChatTab(
        latest.workspace.layouts[mode],
        intent.sidecar.sourceThreadId,
      );
      const group = preferredGroup(latest.workspace, mode);
      const tab: SideChatTab = {
        kind: "side-chat",
        id: newTabId(),
        mode,
        title: intent.sidecar.title,
        sourceThreadId: intent.sidecar.sourceThreadId,
        sidecarThreadId: intent.sidecar.sidecarThreadId,
      };
      if (existing === undefined) {
        return {
          operation: { kind: "open-tab", mode, groupId: group.groupId, tab },
          message: `${tab.title} opened.`,
        };
      }
      // A launcher-opened tab names the source thread but not the sidecar.
      // Record the identity the host just answered so a restart can fail
      // closed instead of silently swapping in a fresh conversation. A tab
      // that already names a different sidecar stays as it is — the tab
      // itself says the restored conversation is gone.
      if (existing.sidecarThreadId === undefined) {
        return {
          operation: {
            kind: "set-side-chat-sidecar",
            mode,
            groupId: existing.groupId,
            tabId: existing.tabId,
            sidecarThreadId: intent.sidecar.sidecarThreadId,
          },
          message: `${tab.title} selected.`,
        };
      }
      return {
        operation: {
          kind: "activate-tab",
          mode,
          groupId: existing.groupId,
          tabId: existing.tabId,
        },
        message: `${tab.title} selected.`,
      };
    }
    case "open-surface": {
      const group =
        intent.groupId === undefined
          ? preferredGroup(latest.workspace, mode)
          : (findGroup(latest.workspace.layouts[mode], intent.groupId) ??
            preferredGroup(latest.workspace, mode));
      const tab = surfaceTab(
        intent.surface,
        mode,
        activeBoundThreadId(group),
        activeSideChatSource(group),
        intent.browserContextId,
      );
      if (tab === undefined) {
        throw { category: "unsupported", message: "This surface is not available here." };
      }
      const existing =
        tab.kind === "browser"
          ? findBrowserTab(latest.workspace.layouts[mode], tab.threadId, tab.contextId)
          : tab.kind === "side-chat"
            ? findSideChatTab(latest.workspace.layouts[mode], tab.sourceThreadId)
            : undefined;
      return {
        operation:
          existing === undefined
            ? { kind: "open-tab", mode, groupId: group.groupId, tab }
            : {
                kind: "activate-tab",
                mode,
                groupId: existing.groupId,
                tabId: existing.tabId,
              },
        message: `${tab.title} ${existing === undefined ? "opened" : "selected"}.`,
      };
    }
    case "activate-tab":
      return {
        operation: { kind: "activate-tab", mode, groupId: intent.groupId, tabId: intent.tabId },
        message: "Tab activated.",
      };
    case "close-tab":
      return {
        operation: { kind: "close-tab", mode, groupId: intent.groupId, tabId: intent.tabId },
        message: "Tab closed.",
      };
    case "reorder-tab":
      return {
        operation: {
          kind: "reorder-tab",
          mode,
          groupId: intent.groupId,
          tabId: intent.tabId,
          index: intent.index,
        },
        message: "Tab order saved.",
      };
    case "set-canvas-tab-pin":
      return {
        operation: {
          kind: "set-canvas-tab-pin",
          mode,
          groupId: intent.groupId,
          tabId: intent.tabId,
          pinned: intent.pinned,
        },
        message: intent.pinned ? "Canvas tab pinned." : "Canvas tab unpinned.",
      };
    case "split-group":
      return {
        operation: {
          kind: "split-group",
          mode,
          groupId: intent.groupId,
          tabId: intent.tabId,
          splitNodeId: newLayoutNodeId(),
          newGroupNodeId: newLayoutNodeId(),
          newGroupId: newGroupId(),
          orientation: intent.orientation,
          placement: intent.placement,
          ratio: 0.5 as SplitRatio,
        },
        message: `${intent.orientation === "horizontal" ? "Horizontal" : "Vertical"} split created.`,
      };
    case "move-tab":
      return {
        operation: {
          kind: "move-tab",
          mode,
          fromGroupId: intent.fromGroupId,
          toGroupId: intent.toGroupId,
          tabId: intent.tabId,
          index: intent.index,
        },
        message: "Tab moved.",
      };
    case "dock-tab":
      return {
        operation: {
          kind: "dock-tab",
          mode,
          fromGroupId: intent.fromGroupId,
          targetGroupId: intent.targetGroupId,
          tabId: intent.tabId,
          splitNodeId: newLayoutNodeId(),
          newGroupNodeId: newLayoutNodeId(),
          newGroupId: newGroupId(),
          orientation: intent.orientation,
          placement: intent.placement,
          ratio: 0.5 as SplitRatio,
        },
        message: "Tab docked.",
      };
    case "resize-split":
      return {
        operation: {
          kind: "resize-split",
          mode,
          splitNodeId: intent.splitNodeId,
          ratio: intent.ratio,
        },
        message: "Split size saved.",
      };
    case "focus-group":
      return {
        operation: { kind: "focus-group", mode, groupId: intent.groupId },
        message: "Workspace group focused.",
      };
    case "clear-focus":
      return {
        operation: { kind: "unfocus-group", mode },
        message: "Full workspace restored.",
      };
    case "reset-layout":
      return {
        operation: { kind: "reset-mode", mode },
        message: `${modeLabel(mode)} layout reset.`,
      };
  }
}

function fromBootstrap(bootstrap: ShellBootstrap): AuthoritativeShell {
  return {
    settings: bootstrap.settings,
    settingsVersion: bootstrap.settingsVersion,
    workspace: bootstrap.workspace,
    workspaceVersion: bootstrap.workspaceVersion,
    environmentPresentation: bootstrap.environmentPresentation,
    presentationVersion: bootstrap.presentationVersion,
  };
}

function shellFailure(error: unknown): { readonly category: string; readonly message: string } {
  if (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    typeof error.category === "string" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return { category: error.category, message: error.message };
  }
  return { category: "unavailable", message: "Octant shell service is unavailable." };
}

function invalidResult(): { readonly category: "unavailable"; readonly message: string } {
  return { category: "unavailable", message: "Shell command returned an unexpected result." };
}

function isCurrentRequest(
  generation: number,
  requestGeneration: { readonly current: number },
  mounted: { readonly current: boolean },
): boolean {
  return mounted.current && generation === requestGeneration.current;
}

async function withTimeout<T>(
  request: Promise<T>,
  timeoutMs: number,
  timers: Set<ReturnType<typeof setTimeout>>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      if (timer !== undefined) timers.delete(timer);
      reject({
        category: "unavailable",
        message: "Octant shell service did not respond in time.",
      });
    }, timeoutMs);
    timers.add(timer);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(timer);
    }
  }
}

function preferredGroup(workspace: WindowWorkspace, mode: OctantMode) {
  const layout = workspace.layouts[mode];
  return (
    (workspace.focusedGroupId === undefined
      ? undefined
      : findGroup(layout, workspace.focusedGroupId)) ??
    findGroup(layout, workspace.activeGroupIds[mode]) ??
    firstGroup(layout)
  );
}

function firstGroup(layout: WorkspaceLayoutNode): Extract<WorkspaceLayoutNode, { kind: "group" }> {
  return layout.kind === "group" ? layout : firstGroup(layout.first);
}

function findGroup(
  layout: WorkspaceLayoutNode,
  groupId: TabGroupId,
): Extract<WorkspaceLayoutNode, { kind: "group" }> | undefined {
  if (layout.kind === "group") return layout.groupId === groupId ? layout : undefined;
  return findGroup(layout.first, groupId) ?? findGroup(layout.second, groupId);
}

function findChatThreadTab(
  layout: WorkspaceLayoutNode,
  threadId: ChatThreadId,
): { readonly groupId: TabGroupId; readonly tabId: WorkspaceTabId } | undefined {
  if (layout.kind === "group") {
    const tab = layout.tabs.find(
      (candidate) => candidate.kind === "chat-thread" && candidate.threadId === threadId,
    );
    return tab === undefined ? undefined : { groupId: layout.groupId, tabId: tab.id };
  }
  return findChatThreadTab(layout.first, threadId) ?? findChatThreadTab(layout.second, threadId);
}

function findCodeThreadTab(
  layout: WorkspaceLayoutNode,
  threadId: CodeThreadId,
  hostId?: HostId,
): { readonly groupId: TabGroupId; readonly tabId: WorkspaceTabId } | undefined {
  if (layout.kind === "group") {
    const tab = layout.tabs.find(
      (candidate) =>
        candidate.kind === "code-overview" &&
        candidate.threadId === threadId &&
        candidate.hostId === hostId,
    );
    return tab === undefined ? undefined : { groupId: layout.groupId, tabId: tab.id };
  }
  return (
    findCodeThreadTab(layout.first, threadId, hostId) ??
    findCodeThreadTab(layout.second, threadId, hostId)
  );
}

function findWorkThreadTab(
  layout: WorkspaceLayoutNode,
  threadId: WorkThreadId,
  hostId?: HostId,
): { readonly groupId: TabGroupId; readonly tabId: WorkspaceTabId } | undefined {
  if (layout.kind === "group") {
    const tab = layout.tabs.find(
      (candidate) =>
        candidate.kind === "work-thread" &&
        candidate.threadId === threadId &&
        candidate.hostId === hostId,
    );
    return tab === undefined ? undefined : { groupId: layout.groupId, tabId: tab.id };
  }
  return (
    findWorkThreadTab(layout.first, threadId, hostId) ??
    findWorkThreadTab(layout.second, threadId, hostId)
  );
}

/**
 * The Browser tab for one thread *and* one context identity. The ordinary
 * Browser surface names no context, so it keeps finding the thread's single
 * shared tab; a tab opened for one local server is found again only by that
 * same context, so the next server opens beside it rather than over it.
 */
function findBrowserTab(
  layout: WorkspaceLayoutNode,
  threadId: BrowserThreadId | undefined,
  contextId?: BrowserContextId,
): { readonly groupId: TabGroupId; readonly tabId: WorkspaceTabId } | undefined {
  if (layout.kind === "group") {
    const tab = layout.tabs.find(
      (candidate) =>
        candidate.kind === "browser" &&
        candidate.threadId === threadId &&
        candidate.contextId === contextId,
    );
    return tab === undefined ? undefined : { groupId: layout.groupId, tabId: tab.id };
  }
  return (
    findBrowserTab(layout.first, threadId, contextId) ??
    findBrowserTab(layout.second, threadId, contextId)
  );
}

/**
 * Whether the committed workspace holds a Browser tab bound to exactly this
 * dedicated context.
 *
 * Every mode is searched: the tab lands in whichever mode was authoritative
 * when the mutation committed, and all the caller needs to know is that some
 * tab now owns this context's close path.
 */
function committedBrowserContextTab(
  shell: AuthoritativeShell | undefined,
  contextId: BrowserContextId,
): boolean {
  if (shell === undefined) return false;
  return Object.values(shell.workspace.layouts).some((layout) =>
    layoutHasBrowserContextTab(layout, contextId),
  );
}

function layoutHasBrowserContextTab(
  layout: WorkspaceLayoutNode,
  contextId: BrowserContextId,
): boolean {
  if (layout.kind === "group") {
    return layout.tabs.some((tab) => tab.kind === "browser" && tab.contextId === contextId);
  }
  return (
    layoutHasBrowserContextTab(layout.first, contextId) ||
    layoutHasBrowserContextTab(layout.second, contextId)
  );
}

function findCodeSurfaceTab(
  layout: WorkspaceLayoutNode,
  target: CodeSurfaceInput,
): { readonly groupId: TabGroupId; readonly tabId: WorkspaceTabId } | undefined {
  if (layout.kind === "group") {
    const tab = layout.tabs.find((candidate) => {
      if (!("mode" in candidate) || candidate.mode !== "code" || candidate.kind !== target.kind)
        return false;
      if (
        !("threadId" in candidate) ||
        !("threadId" in target) ||
        candidate.threadId !== target.threadId
      )
        return false;
      if (candidate.kind === "code-file" && target.kind === "code-file") {
        return candidate.relativePath === target.relativePath;
      }
      if (candidate.kind === "code-diff" && target.kind === "code-diff") {
        return candidate.relativePath === target.relativePath;
      }
      if (candidate.kind === "code-terminal" && target.kind === "code-terminal") {
        // Two terminal tabs are the same tab only when they show the same
        // process. Opening a terminal without naming one still reuses the
        // thread's original terminal tab.
        return candidate.terminalId === target.terminalId;
      }
      return true;
    });
    return tab === undefined ? undefined : { groupId: layout.groupId, tabId: tab.id };
  }
  return findCodeSurfaceTab(layout.first, target) ?? findCodeSurfaceTab(layout.second, target);
}

/**
 * A terminal tab title for this thread that no open terminal tab already uses.
 *
 * The first terminal is simply "Terminal"; the next free ordinal names each
 * one after it. Closing a terminal returns its number to the pool, which is
 * what a user reading the tab strip expects — the numbers describe the tabs
 * that are open, not how many have ever existed.
 */
function unusedCodeTerminalTitle(layout: WorkspaceLayoutNode, threadId: CodeThreadId): string {
  const used = new Set(codeTerminalTitles(layout, threadId));
  for (let ordinal = 1; ordinal <= used.size + 1; ordinal += 1) {
    const title = ordinal === 1 ? "Terminal" : `Terminal ${ordinal}`;
    if (!used.has(title)) return title;
  }
  return "Terminal";
}

function codeTerminalTitles(
  layout: WorkspaceLayoutNode,
  threadId: CodeThreadId,
): ReadonlyArray<string> {
  if (layout.kind === "group") {
    return layout.tabs
      .filter((tab) => tab.kind === "code-terminal" && tab.threadId === threadId)
      .map((tab) => tab.title);
  }
  return [
    ...codeTerminalTitles(layout.first, threadId),
    ...codeTerminalTitles(layout.second, threadId),
  ];
}

function findProjectTab(
  layout: WorkspaceLayoutNode,
  projectId: ProjectId,
): { readonly groupId: TabGroupId; readonly tabId: WorkspaceTabId } | undefined {
  if (layout.kind === "group") {
    const tab = layout.tabs.find(
      (candidate) => candidate.kind === "project" && candidate.projectId === projectId,
    );
    return tab === undefined ? undefined : { groupId: layout.groupId, tabId: tab.id };
  }
  return findProjectTab(layout.first, projectId) ?? findProjectTab(layout.second, projectId);
}

function findDraftThreadTab(
  layout: WorkspaceLayoutNode,
  projectId: ProjectId | undefined,
):
  | {
      readonly groupId: TabGroupId;
      readonly tabId: WorkspaceTabId;
      readonly projectId: ProjectId | undefined;
    }
  | undefined {
  if (layout.kind === "group") {
    const tab = layout.tabs.find(
      (candidate) =>
        candidate.kind === "draft-thread" &&
        (projectId === undefined
          ? candidate.projectId === undefined
          : String(candidate.projectId) === String(projectId)),
    );
    return tab?.kind !== "draft-thread"
      ? undefined
      : { groupId: layout.groupId, tabId: tab.id, projectId: tab.projectId };
  }
  return (
    findDraftThreadTab(layout.first, projectId) ?? findDraftThreadTab(layout.second, projectId)
  );
}

function findPreviewTab(
  layout: WorkspaceLayoutNode,
  targetId: PreviewTargetId,
): { readonly groupId: TabGroupId; readonly tabId: WorkspaceTabId } | undefined {
  if (layout.kind === "group") {
    const tab = layout.tabs.find(
      (candidate) => candidate.kind === "preview" && candidate.targetId === targetId,
    );
    return tab === undefined ? undefined : { groupId: layout.groupId, tabId: tab.id };
  }
  return findPreviewTab(layout.first, targetId) ?? findPreviewTab(layout.second, targetId);
}

function findCanvasTab(
  layout: WorkspaceLayoutNode,
  canvasId: CanvasId,
): { readonly groupId: TabGroupId; readonly tabId: WorkspaceTabId } | undefined {
  if (layout.kind === "group") {
    const tab = layout.tabs.find(
      (candidate) => candidate.kind === "canvas" && candidate.canvasId === canvasId,
    );
    return tab === undefined ? undefined : { groupId: layout.groupId, tabId: tab.id };
  }
  return findCanvasTab(layout.first, canvasId) ?? findCanvasTab(layout.second, canvasId);
}

function findTabById(workspace: WindowWorkspace, tabId: WorkspaceTabId): WorkspaceTab | undefined {
  for (const mode of ["chat", "work", "code"] as const) {
    const found = findTabInLayout(workspace.layouts[mode], tabId);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findTabInLayout(
  layout: WorkspaceLayoutNode,
  tabId: WorkspaceTabId,
): WorkspaceTab | undefined {
  if (layout.kind === "group") {
    return layout.tabs.find((tab) => tab.id === tabId);
  }
  return findTabInLayout(layout.first, tabId) ?? findTabInLayout(layout.second, tabId);
}

function findGroupMode(workspace: WindowWorkspace, groupId: TabGroupId): OctantMode | undefined {
  for (const mode of ["chat", "work", "code"] as const) {
    if (groupExistsInLayout(workspace.layouts[mode], groupId)) return mode;
  }
  return undefined;
}

function groupExistsInLayout(layout: WorkspaceLayoutNode, groupId: TabGroupId): boolean {
  if (layout.kind === "group") return layout.groupId === groupId;
  return groupExistsInLayout(layout.first, groupId) || groupExistsInLayout(layout.second, groupId);
}

function presentationLayout(
  layout: WorkspaceLayoutNode | undefined,
  focusedGroupId: TabGroupId | undefined,
  activeGroupId: TabGroupId | undefined,
  narrow: boolean,
): WorkspaceLayoutNode | undefined {
  if (layout === undefined) return undefined;
  if (focusedGroupId !== undefined) return findGroup(layout, focusedGroupId) ?? firstGroup(layout);
  return narrow && activeGroupId !== undefined
    ? (findGroup(layout, activeGroupId) ?? firstGroup(layout))
    : layout;
}

function modeLabel(mode: OctantMode): string {
  return mode === "chat" ? "Chat" : mode === "work" ? "Work" : "Code";
}

function isDifferentProject(
  workspace: WindowWorkspace,
  mode: OctantMode,
  projectId: ProjectId | undefined,
): boolean {
  const currentProjectId = workspace.contextByMode[mode].projectId;
  return (
    projectId !== undefined &&
    currentProjectId !== null &&
    String(currentProjectId) !== String(projectId)
  );
}

function newTabId(): WorkspaceTabId {
  return decodeWorkspaceTabId(crypto.randomUUID());
}

function surfaceTab(
  surface: WorkspaceSurfaceKind,
  mode: OctantMode,
  threadId?: BrowserThreadId,
  sideChatSource?: SideChatSource,
  browserContextId?: BrowserContextId,
): WorkspaceTab | undefined {
  if (surface === "thread") {
    return {
      kind: "welcome",
      id: newTabId(),
      mode,
      title: `${modeLabel(mode)} Workspace`,
    };
  }
  if (surface === "browser") {
    if (mode === "chat" || threadId === undefined) return undefined;
    return {
      kind: "browser",
      id: newTabId(),
      mode: mode as "work" | "code",
      title: "Browser",
      threadId,
      ...(browserContextId === undefined ? {} : { contextId: browserContextId }),
    };
  }
  if (surface === "files") {
    if (mode === "chat") return undefined;
    return { kind: "files", id: newTabId(), mode: mode as "work" | "code", title: "Files" };
  }
  if (surface === "side-chat") {
    // Side Chat is always about one thread. With no thread open in this group
    // there is nothing to ask about, so the surface is refused rather than
    // opened as a tab that could never name its sidecar.
    if (sideChatSource === undefined) return undefined;
    return {
      kind: "side-chat",
      id: newTabId(),
      mode,
      title: sideChatTitle(sideChatSource.title),
      sourceThreadId: sideChatSource.threadId,
    };
  }
  // terminal, diff, git-review require an active Code thread context and are
  // not advertised by the launcher catalog; they are opened via code surface
  // controls within a Code thread.
  return undefined;
}

function activeBoundThreadId(
  group: Extract<WorkspaceLayoutNode, { kind: "group" }>,
): BrowserThreadId | undefined {
  const active = group.tabs.find((tab) => tab.id === group.activeTabId);
  if (
    active?.kind !== "work-thread" &&
    active?.kind !== "code-overview" &&
    active?.kind !== "code-file" &&
    active?.kind !== "code-diff" &&
    active?.kind !== "code-terminal" &&
    active?.kind !== "code-test" &&
    active?.kind !== "code-git" &&
    active?.kind !== "code-pr" &&
    active?.kind !== "code-local-review" &&
    active?.kind !== "browser"
  ) {
    return undefined;
  }
  return active.threadId as unknown as BrowserThreadId;
}

/**
 * The thread a Side Chat opened from this group would ask about: the group's
 * active thread tab, in any mode. A group showing no thread yields nothing, so
 * the launcher refuses Side Chat instead of opening a lane about nothing.
 */
function activeSideChatSource(
  group: Extract<WorkspaceLayoutNode, { kind: "group" }>,
): SideChatSource | undefined {
  const active = group.tabs.find((tab) => tab.id === group.activeTabId);
  if (
    active?.kind !== "chat-thread" &&
    active?.kind !== "work-thread" &&
    active?.kind !== "code-overview" &&
    active?.kind !== "code-file" &&
    active?.kind !== "code-diff" &&
    active?.kind !== "code-terminal" &&
    active?.kind !== "code-test" &&
    active?.kind !== "code-git" &&
    active?.kind !== "code-pr" &&
    active?.kind !== "code-local-review"
  ) {
    return undefined;
  }
  let threadId: MentionableThreadId;
  try {
    threadId = decodeMentionableThreadId(String(active.threadId));
  } catch {
    return undefined;
  }
  return { threadId, title: active.title };
}

function findSideChatTab(
  layout: WorkspaceLayoutNode,
  sourceThreadId: MentionableThreadId,
):
  | {
      readonly groupId: TabGroupId;
      readonly tabId: WorkspaceTabId;
      readonly sidecarThreadId?: ChatThreadId;
    }
  | undefined {
  if (layout.kind === "group") {
    const tab = layout.tabs.find(
      (candidate) =>
        candidate.kind === "side-chat" &&
        String(candidate.sourceThreadId) === String(sourceThreadId),
    );
    if (tab === undefined || tab.kind !== "side-chat") return undefined;
    return {
      groupId: layout.groupId,
      tabId: tab.id,
      ...(tab.sidecarThreadId === undefined ? {} : { sidecarThreadId: tab.sidecarThreadId }),
    };
  }
  return (
    findSideChatTab(layout.first, sourceThreadId) ?? findSideChatTab(layout.second, sourceThreadId)
  );
}

function newLayoutNodeId(): LayoutNodeId {
  return decodeLayoutNodeId(crypto.randomUUID());
}

function newGroupId(): TabGroupId {
  return decodeTabGroupId(crypto.randomUUID());
}
