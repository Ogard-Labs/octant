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
  decodeProjectId,
  decodePaneId,
  decodeWorkspaceTabId,
  type LayoutNodeId,
  type MentionableThreadId,
  decodeMentionableThreadId,
  type PaneId,
  type SettingsDeepLink,
  type SideChatSidecar,
  type ShellBootstrap,
  type ShellSettings,
  type SplitRatio,
  type WindowId,
  type WindowWorkspace,
  type WorkspaceLayoutNode,
  type WorkspaceOperation,
  type WorkspacePane,
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
  sameWorkspaceSurface,
  workspaceWelcomeSurface,
} from "@octant/domain/shell-policy";
import { enabledModes } from "@octant/domain/mode-policy";
import { sideChatTitle } from "@octant/domain";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { markInteraction, markInteractionAfterPaint } from "../polling/interactionTrace";
import type { ProjectWindowTarget } from "./hostBridge";
import { createTabActivationRegistry, type TabActivationRegistry } from "./TabActivation";
import type { WorkspaceSurfaceDropDestination } from "./workspaceTabDragGeometry";

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
  | "workspace-material"
  | "sidebar-background"
  | "mode-switcher"
  | "project-view-switcher"
  | "transcript-text-size"
  | "transcript-width"
  | "thread-provider-icons"
  | "open-in-applications"
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
  readonly windowCapability?: string;
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
  /**
   * The surface the person just asked for, by the id it will actually carry
   * once the operation lands: the visible surface's own id when the open
   * deduplicates onto an existing pane, the freshly minted id otherwise. The
   * activation registry keys on this so composer focus follows the surface the
   * user sees, not the discarded duplicate.
   */
  readonly activatedSurfaceId?: WorkspaceTabId;
}

type CodeSurfaceTab = Extract<WorkspaceTab, { readonly mode: "code" }>;
type CodeSurfaceInput = CodeSurfaceTab extends infer Tab
  ? Tab extends CodeSurfaceTab
    ? Omit<Tab, "id" | "mode">
    : never
  : never;

type SideChatTab = Extract<WorkspaceTab, { readonly kind: "side-chat" }>;
/**
 * Input for opening a persistent preview surface. The renderer receives the
 * opaque target identity from the host preview service; it never synthesizes
 * paths, credentials, or authority tokens. The host reauthorizes the opaque
 * target on every open/chunk/refresh after the surface is journaled.
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
 * The source thread a Side Chat surface asks about. Opening Side Chat from the
 * surface launcher binds the pane's visible thread; a pane showing no thread
 * has nothing to ask about, so the surface is refused rather than opened
 * unbound.
 */
interface SideChatSource {
  readonly threadId: MentionableThreadId;
  readonly title: string;
}

type WorkspaceIntent =
  | { readonly kind: "activate-pane"; readonly paneId: PaneId }
  | { readonly kind: "clear-focus" }
  | { readonly kind: "close-pane"; readonly paneId: PaneId }
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
  | { readonly kind: "focus-pane"; readonly paneId: PaneId }
  | {
      readonly kind: "open-surface";
      readonly surface: WorkspaceSurfaceKind;
      readonly paneId: PaneId | undefined;
      /** The Browser context this surface must show, when it has one of its own. */
      readonly browserContextId: BrowserContextId | undefined;
    }
  | {
      readonly kind: "replace-pane-surface";
      readonly paneId: PaneId;
      readonly surface: WorkspaceTab;
      readonly projectId?: ProjectId;
    }
  | {
      readonly kind: "split-pane";
      readonly targetPaneId: PaneId;
      readonly orientation: "horizontal" | "vertical";
      readonly placement: "before" | "after";
      /** Omitted for an empty split: the new pane opens on the mode welcome. */
      readonly surface?: WorkspaceTab;
      readonly projectId?: ProjectId;
    }
  | {
      readonly kind: "pin-in-pane";
      readonly surface: WorkspaceTab;
      readonly projectId?: ProjectId;
    }
  | { readonly kind: "reset-layout" }
  | {
      readonly kind: "resize-split";
      readonly ratio: SplitRatio;
      readonly splitNodeId: LayoutNodeId;
    }
  | { readonly kind: "set-mode"; readonly mode: OctantMode };

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
  "workspace-material":
    "appearance translucent workspace window translucency material vibrancy glass system opaque",
  "sidebar-background":
    "sidebar background image preset gradient custom upload overlay color opacity vibrancy",
  "mode-switcher": "mode switcher compact buttons dropdown sidebar navigation",
  "project-view-switcher": "project view switcher icons dropdown sidebar code",
  "transcript-text-size": "transcript conversation text font size small medium large",
  "transcript-width": "transcript conversation composer width narrow medium wide centered",
  "thread-provider-icons": "thread provider icon avatar logo sidebar compact visibility",
  "open-in-applications": "open in vscode cursor zed finder terminal ghostty xcode",
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
    () =>
      createShellClient({
        baseUrl: options.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: options.windowCapability ?? "",
      }),
    [options.serverUrl, options.windowCapability],
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
            client.bootstrap(),
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
        noteSurfaceActivation(tabActivation, workspaceMutation);
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
      const introduced = operation === undefined ? undefined : introducedSurface(operation);
      const target =
        requestedTarget ??
        newWindowTargetFromError(error) ??
        (introduced?.kind === "project"
          ? ({ kind: "project", projectId: introduced.projectId } as const)
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
      findChatThreadPane(workspace.layouts.chat, threadId) !== undefined
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
   * Open the Side Chat surface for a sidecar the host has already resolved. The
   * sidecar linkage is the host's answer to "which conversation is this lane",
   * so the surface is journaled with that identity and reopens the same sidecar
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
   * Open one workspace surface, replacing the target pane's content — or, when
   * the same surface is already visible in some pane, focusing that pane.
   *
   * `browserContextId` names a host-owned Browser context opened for exactly
   * one target — a Local servers Open. Surfaces are deduplicated by that
   * identity together with the thread, so the ordinary Browser surface still
   * reuses the thread's visible pane while every Open of a local server gets a
   * view of its own instead of replacing the previous server's page.
   *
   * Resolves to whether a surface bound to `browserContextId` is committed. A
   * caller that minted a context for this Open must release it when this is
   * `false`: a rejected mutation is recovered rather than thrown, so the call
   * settling is no evidence the context has a close path. An Open naming no
   * context has nothing to confirm and resolves `true`.
   */
  async function openSurface(
    surface: WorkspaceSurfaceKind,
    paneId?: PaneId,
    browserContextId?: BrowserContextId,
  ): Promise<boolean> {
    await enqueueMutation({
      kind: "workspace",
      intent: { kind: "open-surface", surface, paneId, browserContextId },
    });
    return (
      browserContextId === undefined ||
      committedBrowserContextSurface(committedShell.current, browserContextId)
    );
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

  /**
   * Make a pane the one this window is about — the pane whose surface the
   * composer, thread controllers, and the right utility dock resolve against.
   * Clicking a pane that is already active, or one showing only the mode
   * welcome, is not a change worth journaling and is skipped here.
   */
  async function activatePane(paneId: PaneId): Promise<void> {
    const shell = committedShell.current;
    if (shell === undefined) return;
    const mode = shell.workspace.activeMode;
    const pane = findPane(shell.workspace.layouts[mode], paneId);
    if (pane === undefined || pane.surface.kind === "welcome") return;
    if (String(shell.workspace.activePaneIds[mode]) === String(paneId)) return;
    markInteraction("renderer", "pane-activation-requested");
    const committed = await enqueueMutation({
      kind: "workspace",
      intent: { kind: "activate-pane", paneId },
    });
    if (committed) markInteractionAfterPaint("pane-activation");
  }

  /**
   * Resolves to whether the pane's surface actually left the workspace. When
   * the pane showed the last remaining welcome surface, closing it recreates
   * the default welcome pane and this reports `false` — nothing was lost.
   */
  async function closePane(paneId: PaneId): Promise<boolean> {
    const before = committedShell.current;
    const surfaceId =
      before === undefined ? undefined : findPaneInWorkspace(before.workspace, paneId)?.surface.id;
    await enqueueMutation({ kind: "workspace", intent: { kind: "close-pane", paneId } });
    const latest = committedShell.current;
    if (latest === undefined || surfaceId === undefined) return false;
    return !workspaceHasSurfaceId(latest.workspace, surfaceId);
  }

  async function splitPane(
    targetPaneId: PaneId,
    orientation: "horizontal" | "vertical",
    placement: "before" | "after" = "after",
    surface?: WorkspaceTab,
    projectId?: ProjectId,
  ): Promise<void> {
    await enqueueMutation({
      kind: "workspace",
      intent: {
        kind: "split-pane",
        targetPaneId,
        orientation,
        placement,
        ...(surface === undefined ? {} : { surface }),
        ...(projectId === undefined ? {} : { projectId }),
      },
    });
  }

  async function replacePaneSurface(
    paneId: PaneId,
    surface: WorkspaceTab,
    projectId?: ProjectId,
  ): Promise<void> {
    await enqueueMutation({
      kind: "workspace",
      intent: {
        kind: "replace-pane-surface",
        paneId,
        surface,
        ...(projectId === undefined ? {} : { projectId }),
      },
    });
  }

  /**
   * Places a thread in a new split pane beside the one this window is about.
   * A thread already visible is activated instead of duplicated. Cross-mode,
   * cross-Project, and cross-host placement is refused so the server never
   * journals a mixed-authority tree.
   */
  async function pinInPane(surface: WorkspaceTab, projectId?: ProjectId): Promise<void> {
    if (committedShell.current?.workspace.focusedPaneId !== undefined) {
      await enqueueMutation({ kind: "workspace", intent: { kind: "clear-focus" } });
    }
    await enqueueMutation({
      kind: "workspace",
      intent: {
        kind: "pin-in-pane",
        surface,
        ...(projectId === undefined ? {} : { projectId }),
      },
    });
  }

  async function dropSurface(
    surface: WorkspaceTab,
    destination: WorkspaceSurfaceDropDestination,
    projectId?: ProjectId,
  ): Promise<void> {
    // Cross-Project denial for preview surfaces: a preview carries its own
    // opaque Project binding. Dropping it into a pane whose mode context is
    // bound to a different Project (or no Project) would violate the
    // one-Project invariant. Deny at the renderer so the host never journals
    // a cross-context open; the server still re-checks authority on restore.
    const workspace = authoritative?.workspace;
    if (workspace !== undefined) {
      const targetMode = findPaneMode(workspace, destination.targetPaneId);
      if (
        surface.kind === "preview" &&
        targetMode !== undefined &&
        workspace.contextByMode[targetMode].projectId !== surface.projectId
      ) {
        announce("Preview belongs to a different Project. Open it there instead.");
        return;
      }
      if (
        surface.kind === "canvas" &&
        targetMode !== undefined &&
        workspace.contextByMode[targetMode].projectId !== null &&
        workspace.contextByMode[targetMode].projectId !== surface.projectId
      ) {
        announce("Canvas belongs to a different Project. Open it there instead.");
        return;
      }
    }
    if (destination.kind === "center") {
      await replacePaneSurface(destination.targetPaneId, surface, projectId);
      return;
    }
    const orientation =
      destination.edge === "left" || destination.edge === "right" ? "horizontal" : "vertical";
    const placement =
      destination.edge === "left" || destination.edge === "top" ? "before" : "after";
    await splitPane(destination.targetPaneId, orientation, placement, surface, projectId);
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

  async function focusPane(paneId: PaneId): Promise<void> {
    await enqueueMutation({ kind: "workspace", intent: { kind: "focus-pane", paneId } });
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
    authoritative?.workspace.focusedPaneId,
    authoritative === undefined
      ? undefined
      : authoritative.workspace.activePaneIds[authoritative.workspace.activeMode],
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
    activatePane,
    announcement: announcementEvent.message,
    announcementSequence: announcementEvent.sequence,
    availableSurfaces,
    clearFocus,
    clearPendingSettingsDeepLink,
    closeSettings,
    environmentPresentation: authoritative?.environmentPresentation,
    presentationVersion: authoritative?.presentationVersion,
    closePane,
    commitSplitResize,
    crossContextOffer,
    dismissCrossContextOffer,
    openCrossContextInNewWindow,
    canOpenCrossContextInNewWindow: options.nativeHost?.openInNewWindow !== undefined,
    dropSurface,
    errorMessage,
    focusPane,
    pinInPane,
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
    replacePaneSurface,
    resetActiveLayout,
    resetNativeBounds,
    retry: () => load("retry"),
    setEnvironmentPresentation,
    setMode,
    setSettingsSearch,
    settings: authoritative?.settings,
    settingsOpen,
    settingsSearch,
    splitPane,
    status,
    tabActivation,
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
 * Records the surface a workspace intent brings to the front. Every intent is a
 * gesture in this window, so opening, switching to, or focusing a surface is
 * the person asking for it. A restored layout arrives through bootstrap instead
 * and is deliberately never recorded.
 */
function noteSurfaceActivation(registry: TabActivationRegistry, mutation: WorkspaceMutation): void {
  if (mutation.activatedSurfaceId !== undefined) {
    registry.noteActivated(mutation.activatedSurfaceId);
  }
}

function createWorkspaceMutation(
  latest: AuthoritativeShell,
  intent: WorkspaceIntent,
): WorkspaceMutation {
  const mode = latest.workspace.activeMode;
  const layout = latest.workspace.layouts[mode];
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
    case "open-draft-thread": {
      if (intent.mode !== mode) {
        throw {
          category: "invalid",
          message: `Draft mode ${intent.mode} does not match the active workspace.`,
        };
      }
      const surface: WorkspaceTab = {
        kind: "draft-thread",
        id: newTabId(),
        mode,
        title: `New ${modeLabel(mode)} thread`,
        ...(intent.projectId === undefined ? {} : { projectId: intent.projectId }),
      };
      const existing = findVisibleSurfacePane(layout, surface);
      return {
        operation: {
          kind: "open-surface",
          mode,
          paneId: (existing ?? preferredPane(latest.workspace, mode)).paneId,
          surface,
        },
        message:
          existing === undefined
            ? `New ${modeLabel(mode)} thread draft opened.`
            : `Draft ${modeLabel(mode)} thread selected.`,
        activatedSurfaceId: existing?.surface.id ?? surface.id,
      };
    }
    case "open-chat-thread": {
      if (mode !== "chat") {
        throw { category: "invalid", message: "Chat threads are valid only in Chat mode." };
      }
      const surface: WorkspaceTab = {
        kind: "chat-thread",
        id: newTabId(),
        threadId: intent.threadId,
        mode: "chat",
        title: intent.title,
      };
      if (isDifferentProject(latest.workspace, "chat", intent.projectId)) {
        return {
          operation: { kind: "switch-project-surface", mode: "chat", surface },
          message: `${intent.title} opened in this window.`,
        };
      }
      const existing = findVisibleSurfacePane(layout, surface);
      return {
        operation: {
          kind: "open-surface",
          mode: "chat",
          paneId: threadTargetPane(latest.workspace, "chat", existing, intent.projectId),
          surface,
        },
        message: existing === undefined ? `${intent.title} opened.` : `${intent.title} selected.`,
        activatedSurfaceId: existing?.surface.id ?? surface.id,
      };
    }
    case "open-code-thread": {
      if (mode !== "code") {
        throw { category: "invalid", message: "Code threads are valid only in Code mode." };
      }
      const surface: WorkspaceTab = {
        kind: "code-overview",
        id: newTabId(),
        threadId: intent.threadId,
        mode: "code",
        title: intent.title,
        ...(intent.hostId === undefined ? {} : { hostId: intent.hostId }),
      };
      const newWindowTarget =
        intent.projectId === undefined
          ? {}
          : {
              newWindowTarget: {
                kind: "project-thread" as const,
                projectId: intent.projectId,
                mode: "code" as const,
                threadId: intent.threadId,
              },
            };
      if (isDifferentProject(latest.workspace, "code", intent.projectId)) {
        return {
          operation: { kind: "switch-project-surface", mode: "code", surface },
          message: `${intent.title} opened in this window.`,
          ...newWindowTarget,
        };
      }
      const existing = findVisibleSurfacePane(layout, surface);
      return {
        operation: {
          kind: "open-surface",
          mode: "code",
          paneId: threadTargetPane(latest.workspace, "code", existing, intent.projectId),
          surface,
        },
        message: existing === undefined ? `${intent.title} opened.` : `${intent.title} selected.`,
        activatedSurfaceId: existing?.surface.id ?? surface.id,
        ...newWindowTarget,
      };
    }
    case "open-work-thread": {
      if (mode !== "work") {
        throw { category: "invalid", message: "Work threads are valid only in Work mode." };
      }
      const surface: WorkspaceTab = {
        kind: "work-thread",
        id: newTabId(),
        threadId: intent.threadId,
        mode: "work",
        title: intent.title,
        ...(intent.hostId === undefined ? {} : { hostId: intent.hostId }),
      };
      const newWindowTarget =
        intent.projectId === undefined
          ? {}
          : {
              newWindowTarget: {
                kind: "project-thread" as const,
                projectId: intent.projectId,
                mode: "work" as const,
                threadId: intent.threadId,
              },
            };
      if (isDifferentProject(latest.workspace, "work", intent.projectId)) {
        return {
          operation: { kind: "switch-project-surface", mode: "work", surface },
          message: `${intent.title} opened in this window.`,
          ...newWindowTarget,
        };
      }
      const existing = findVisibleSurfacePane(layout, surface);
      return {
        operation: {
          kind: "open-surface",
          mode: "work",
          paneId: threadTargetPane(latest.workspace, "work", existing, intent.projectId),
          surface,
        },
        message: existing === undefined ? `${intent.title} opened.` : `${intent.title} selected.`,
        activatedSurfaceId: existing?.surface.id ?? surface.id,
        ...newWindowTarget,
      };
    }
    case "open-code-surface": {
      if (mode !== "code") {
        throw { category: "invalid", message: "Code surfaces are valid only in Code mode." };
      }
      // A second terminal for the same thread would otherwise arrive with the
      // same title as the first, leaving two panes nobody can tell apart.
      const title =
        intent.tab.kind === "code-terminal"
          ? unusedCodeTerminalTitle(layout, intent.tab.threadId)
          : intent.tab.title;
      const surface = { ...intent.tab, title, id: newTabId(), mode: "code" } as Extract<
        WorkspaceTab,
        { readonly mode: "code" }
      >;
      const existing = findVisibleSurfacePane(layout, surface);
      return {
        operation: {
          kind: "open-surface",
          mode: "code",
          paneId: (existing ?? preferredPane(latest.workspace, "code")).paneId,
          surface,
        },
        message: existing === undefined ? `${title} opened.` : `${intent.tab.title} selected.`,
        activatedSurfaceId: existing?.surface.id ?? surface.id,
      };
    }
    case "open-project": {
      if (intent.mode !== mode) {
        throw { category: "invalid", message: "Project mode does not match the active workspace." };
      }
      const surface: WorkspaceTab = {
        kind: "project",
        id: newTabId(),
        projectId: intent.projectId,
        mode,
        title: intent.title,
      };
      if (isDifferentProject(latest.workspace, mode, intent.projectId)) {
        return {
          operation: { kind: "switch-project-surface", mode, surface },
          message: `${intent.title} opened in this window.`,
          newWindowTarget: { kind: "project", projectId: intent.projectId },
        };
      }
      const existing = findVisibleSurfacePane(layout, surface);
      return {
        operation: {
          kind: "open-surface",
          mode,
          paneId: (existing ?? preferredPane(latest.workspace, mode)).paneId,
          surface,
        },
        message: existing === undefined ? `${intent.title} opened.` : `${intent.title} selected.`,
        activatedSurfaceId: existing?.surface.id ?? surface.id,
        newWindowTarget: { kind: "project", projectId: intent.projectId },
      };
    }
    case "open-preview": {
      if (intent.tab.mode !== mode) {
        throw {
          category: "invalid",
          message: "Preview surface mode does not match the active workspace.",
        };
      }
      const surface: WorkspaceTab = {
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
      const existing = findVisibleSurfacePane(layout, surface);
      return {
        operation: {
          kind: "open-surface",
          mode,
          paneId: (existing ?? preferredPane(latest.workspace, mode)).paneId,
          surface,
        },
        message:
          existing === undefined ? `${intent.tab.title} opened.` : `${intent.tab.title} selected.`,
        activatedSurfaceId: existing?.surface.id ?? surface.id,
      };
    }
    case "open-canvas": {
      if (intent.tab.mode !== mode) {
        throw {
          category: "invalid",
          message: "Canvas surface mode does not match the active workspace.",
        };
      }
      const surface: WorkspaceTab = {
        kind: "canvas",
        id: newTabId(),
        mode,
        title: intent.tab.title,
        canvasId: intent.tab.canvasId,
        projectId: intent.tab.projectId,
      };
      const existing = findVisibleSurfacePane(layout, surface);
      return {
        operation: {
          kind: "open-surface",
          mode,
          paneId: (existing ?? preferredPane(latest.workspace, mode)).paneId,
          surface,
        },
        message:
          existing === undefined ? `${intent.tab.title} opened.` : `${intent.tab.title} selected.`,
        activatedSurfaceId: existing?.surface.id ?? surface.id,
      };
    }
    case "open-side-chat": {
      if (intent.sidecar.sourceMode !== mode) {
        throw {
          category: "invalid",
          message: "Side Chat surface mode does not match the active workspace.",
        };
      }
      const existing = findSideChatPane(layout, intent.sidecar.sourceThreadId);
      // A launcher-opened surface names the source thread but not the sidecar.
      // Record the identity the host just answered so a restart can fail
      // closed instead of silently swapping in a fresh conversation. A surface
      // that already names a different sidecar stays as it is — the pane
      // itself says the restored conversation is gone.
      if (
        existing !== undefined &&
        existing.surface.kind === "side-chat" &&
        existing.surface.sidecarThreadId === undefined
      ) {
        return {
          operation: {
            kind: "set-side-chat-sidecar",
            mode,
            paneId: existing.paneId,
            sidecarThreadId: intent.sidecar.sidecarThreadId,
          },
          message: `${intent.sidecar.title} selected.`,
          activatedSurfaceId: existing.surface.id,
        };
      }
      const surface: SideChatTab = {
        kind: "side-chat",
        id: newTabId(),
        mode,
        title: intent.sidecar.title,
        sourceThreadId: intent.sidecar.sourceThreadId,
        sidecarThreadId: intent.sidecar.sidecarThreadId,
      };
      return {
        operation: {
          kind: "open-surface",
          mode,
          paneId: (existing ?? preferredPane(latest.workspace, mode)).paneId,
          surface,
        },
        message: existing === undefined ? `${surface.title} opened.` : `${surface.title} selected.`,
        activatedSurfaceId: existing?.surface.id ?? surface.id,
      };
    }
    case "open-surface": {
      const pane =
        intent.paneId === undefined
          ? preferredPane(latest.workspace, mode)
          : (findPane(layout, intent.paneId) ?? preferredPane(latest.workspace, mode));
      const surface = surfaceTab(
        intent.surface,
        mode,
        boundThreadId(pane.surface),
        sideChatSource(pane.surface),
        intent.browserContextId,
      );
      if (surface === undefined) {
        throw { category: "unsupported", message: "This surface is not available here." };
      }
      const existing = findVisibleSurfacePane(layout, surface);
      return {
        operation: { kind: "open-surface", mode, paneId: pane.paneId, surface },
        message: `${surface.title} ${existing === undefined ? "opened" : "selected"}.`,
        activatedSurfaceId: existing?.surface.id ?? surface.id,
      };
    }
    case "activate-pane": {
      const pane = findPane(layout, intent.paneId);
      if (pane === undefined || pane.surface.kind === "welcome") {
        throw { category: "invalid", message: "That pane has nothing to focus." };
      }
      // Re-opening the pane's own surface is the activation gesture: the
      // surface is visible, so the host focuses its pane without replacing
      // anything.
      return {
        operation: { kind: "open-surface", mode, paneId: pane.paneId, surface: pane.surface },
        message: `${pane.surface.title} selected.`,
        activatedSurfaceId: pane.surface.id,
      };
    }
    case "close-pane":
      return {
        operation: { kind: "close-pane", mode, paneId: intent.paneId },
        message: "Pane closed.",
      };
    case "replace-pane-surface": {
      refuseCrossAuthority(latest.workspace, mode, intent.surface, intent.projectId);
      const existing = findVisibleSurfacePane(layout, intent.surface);
      return {
        operation: {
          kind: "replace-pane-surface",
          mode,
          paneId: intent.paneId,
          surface: intent.surface,
        },
        message:
          existing === undefined
            ? `${intent.surface.title} opened.`
            : `${intent.surface.title} moved.`,
        activatedSurfaceId: existing?.surface.id ?? intent.surface.id,
        ...windowTargetForSurface(intent.surface, intent.projectId),
      };
    }
    case "split-pane": {
      const surface = intent.surface ?? workspaceWelcomeSurface(mode, newTabId());
      refuseCrossAuthority(latest.workspace, mode, surface, intent.projectId);
      const existing = findVisibleSurfacePane(layout, surface);
      return {
        operation: {
          kind: "split-pane",
          mode,
          targetPaneId: intent.targetPaneId,
          surface,
          splitNodeId: newLayoutNodeId(),
          newPaneNodeId: newLayoutNodeId(),
          newPaneId: newPaneId(),
          orientation: intent.orientation,
          placement: intent.placement,
          ratio: 0.5 as SplitRatio,
        },
        message: `${intent.orientation === "horizontal" ? "Horizontal" : "Vertical"} split created.`,
        activatedSurfaceId: existing?.surface.id ?? surface.id,
        ...windowTargetForSurface(surface, intent.projectId),
      };
    }
    case "pin-in-pane": {
      refuseCrossAuthority(latest.workspace, mode, intent.surface, intent.projectId);
      const existing = findVisibleSurfacePane(layout, intent.surface);
      if (existing !== undefined) {
        return {
          operation: {
            kind: "open-surface",
            mode,
            paneId: existing.paneId,
            surface: existing.surface,
          },
          message: `${intent.surface.title} selected.`,
          activatedSurfaceId: existing.surface.id,
        };
      }
      const targetPane = preferredPane(latest.workspace, mode);
      return {
        operation: {
          kind: "split-pane",
          mode,
          targetPaneId: targetPane.paneId,
          surface: intent.surface,
          splitNodeId: newLayoutNodeId(),
          newPaneNodeId: newLayoutNodeId(),
          newPaneId: newPaneId(),
          orientation: "horizontal",
          placement: "after",
          ratio: 0.5 as SplitRatio,
        },
        message: `${intent.surface.title} pinned.`,
        activatedSurfaceId: intent.surface.id,
        ...windowTargetForSurface(intent.surface, intent.projectId),
      };
    }
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
    case "focus-pane":
      return {
        operation: { kind: "focus-pane", mode, paneId: intent.paneId },
        message: "Pane focused.",
      };
    case "clear-focus":
      return {
        operation: { kind: "unfocus-pane", mode },
        message: "Full workspace restored.",
      };
    case "reset-layout":
      return {
        operation: { kind: "reset-mode", mode },
        message: `${modeLabel(mode)} layout reset.`,
      };
  }
}

/**
 * The surface a workspace operation would introduce, for recovering a
 * cross-context refusal into a "open in a new window" offer.
 */
function introducedSurface(operation: WorkspaceOperation): WorkspaceTab | undefined {
  switch (operation.kind) {
    case "open-surface":
    case "switch-project-surface":
    case "replace-pane-surface":
    case "split-pane":
      return operation.surface;
    default:
      return undefined;
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

function preferredPane(workspace: WindowWorkspace, mode: OctantMode): WorkspacePane {
  const layout = workspace.layouts[mode];
  return (
    (workspace.focusedPaneId === undefined
      ? undefined
      : findPane(layout, workspace.focusedPaneId)) ??
    findPane(layout, workspace.activePaneIds[mode]) ??
    firstPane(layout)
  );
}

/**
 * Where a thread opened from the sidebar lands when it is not already visible:
 * the pane holding the matching draft, so a thread minted from that draft
 * rebinds the same pane, and otherwise the pane the person is working in.
 */
function threadTargetPane(
  workspace: WindowWorkspace,
  mode: OctantMode,
  existing: WorkspacePane | undefined,
  projectId: ProjectId | undefined,
): PaneId {
  if (existing !== undefined) return existing.paneId;
  const draft = findDraftPane(workspace.layouts[mode], projectId);
  return (draft ?? preferredPane(workspace, mode)).paneId;
}

function firstPane(layout: WorkspaceLayoutNode): WorkspacePane {
  return layout.kind === "pane" ? layout : firstPane(layout.first);
}

function findPane(layout: WorkspaceLayoutNode, paneId: PaneId): WorkspacePane | undefined {
  if (layout.kind === "pane") {
    return String(layout.paneId) === String(paneId) ? layout : undefined;
  }
  return findPane(layout.first, paneId) ?? findPane(layout.second, paneId);
}

function findPaneInWorkspace(
  workspace: WindowWorkspace,
  paneId: PaneId,
): WorkspacePane | undefined {
  for (const mode of ["chat", "work", "code"] as const) {
    const found = findPane(workspace.layouts[mode], paneId);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findPaneMode(workspace: WindowWorkspace, paneId: PaneId): OctantMode | undefined {
  for (const mode of ["chat", "work", "code"] as const) {
    if (findPane(workspace.layouts[mode], paneId) !== undefined) return mode;
  }
  return undefined;
}

function findVisibleSurfacePane(
  layout: WorkspaceLayoutNode,
  surface: WorkspaceTab,
): WorkspacePane | undefined {
  if (layout.kind === "pane") {
    return sameWorkspaceSurface(layout.surface, surface) ? layout : undefined;
  }
  return (
    findVisibleSurfacePane(layout.first, surface) ?? findVisibleSurfacePane(layout.second, surface)
  );
}

function findChatThreadPane(
  layout: WorkspaceLayoutNode,
  threadId: ChatThreadId,
): WorkspacePane | undefined {
  if (layout.kind === "pane") {
    return layout.surface.kind === "chat-thread" &&
      String(layout.surface.threadId) === String(threadId)
      ? layout
      : undefined;
  }
  return findChatThreadPane(layout.first, threadId) ?? findChatThreadPane(layout.second, threadId);
}

function findDraftPane(
  layout: WorkspaceLayoutNode,
  projectId: ProjectId | undefined,
): WorkspacePane | undefined {
  if (layout.kind === "pane") {
    const surface = layout.surface;
    if (surface.kind !== "draft-thread") return undefined;
    const matches =
      projectId === undefined
        ? surface.projectId === undefined
        : String(surface.projectId) === String(projectId);
    return matches ? layout : undefined;
  }
  return findDraftPane(layout.first, projectId) ?? findDraftPane(layout.second, projectId);
}

function findSideChatPane(
  layout: WorkspaceLayoutNode,
  sourceThreadId: MentionableThreadId,
): WorkspacePane | undefined {
  if (layout.kind === "pane") {
    return layout.surface.kind === "side-chat" &&
      String(layout.surface.sourceThreadId) === String(sourceThreadId)
      ? layout
      : undefined;
  }
  return (
    findSideChatPane(layout.first, sourceThreadId) ??
    findSideChatPane(layout.second, sourceThreadId)
  );
}

/**
 * Whether the committed workspace holds a Browser surface bound to exactly this
 * dedicated context.
 *
 * Every mode is searched: the surface lands in whichever mode was authoritative
 * when the mutation committed, and all the caller needs to know is that some
 * pane now owns this context's close path.
 */
function committedBrowserContextSurface(
  shell: AuthoritativeShell | undefined,
  contextId: BrowserContextId,
): boolean {
  if (shell === undefined) return false;
  return Object.values(shell.workspace.layouts).some((layout) =>
    layoutHasBrowserContext(layout, contextId),
  );
}

function layoutHasBrowserContext(
  layout: WorkspaceLayoutNode,
  contextId: BrowserContextId,
): boolean {
  if (layout.kind === "pane") {
    return (
      layout.surface.kind === "browser" && String(layout.surface.contextId) === String(contextId)
    );
  }
  return (
    layoutHasBrowserContext(layout.first, contextId) ||
    layoutHasBrowserContext(layout.second, contextId)
  );
}

function workspaceHasSurfaceId(workspace: WindowWorkspace, surfaceId: WorkspaceTabId): boolean {
  const inLayout = (layout: WorkspaceLayoutNode): boolean =>
    layout.kind === "pane"
      ? String(layout.surface.id) === String(surfaceId)
      : inLayout(layout.first) || inLayout(layout.second);
  return (["chat", "work", "code"] as const).some((mode) => inLayout(workspace.layouts[mode]));
}

/**
 * A terminal title for this thread that no visible terminal pane already uses.
 *
 * The first terminal is simply "Terminal"; the next free ordinal names each
 * one after it. Closing a terminal returns its number to the pool, which is
 * what a user reading the workspace expects — the numbers describe the
 * terminals that are open, not how many have ever existed.
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
  if (layout.kind === "pane") {
    const surface = layout.surface;
    return surface.kind === "code-terminal" && String(surface.threadId) === String(threadId)
      ? [surface.title]
      : [];
  }
  return [
    ...codeTerminalTitles(layout.first, threadId),
    ...codeTerminalTitles(layout.second, threadId),
  ];
}

function presentationLayout(
  layout: WorkspaceLayoutNode | undefined,
  focusedPaneId: PaneId | undefined,
  activePaneId: PaneId | undefined,
  narrow: boolean,
): WorkspaceLayoutNode | undefined {
  if (layout === undefined) return undefined;
  if (focusedPaneId !== undefined) return findPane(layout, focusedPaneId) ?? firstPane(layout);
  return narrow && activePaneId !== undefined
    ? (findPane(layout, activePaneId) ?? firstPane(layout))
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

function refuseCrossAuthority(
  workspace: WindowWorkspace,
  mode: OctantMode,
  surface: WorkspaceTab,
  projectId: ProjectId | undefined,
): void {
  const offer = windowTargetForSurface(surface, projectId);
  if ("mode" in surface && surface.mode !== mode) {
    throw {
      category: "cross-context",
      message: "This surface belongs to a different mode. Open it in a new window to switch modes.",
      ...offer,
    };
  }
  if (
    "hostId" in surface &&
    surface.hostId !== undefined &&
    String(surface.hostId) !== String(workspace.contextByMode[mode].host)
  ) {
    throw {
      category: "cross-context",
      message: "This surface belongs to a different host. Open it in a new window to switch hosts.",
      ...offer,
    };
  }
  if (isDifferentProject(workspace, mode, projectId)) {
    throw {
      category: "cross-context",
      message:
        "This surface belongs to a different Project. Open it in a new window to keep its authority.",
      ...offer,
    };
  }
}

function windowTargetForSurface(
  surface: WorkspaceTab,
  projectId: ProjectId | undefined,
): { readonly newWindowTarget: ProjectWindowTarget } | Record<string, never> {
  if (projectId === undefined) return {};
  if (surface.kind === "code-overview" || surface.kind === "work-thread") {
    return {
      newWindowTarget: {
        kind: "project-thread",
        projectId,
        mode: surface.kind === "code-overview" ? "code" : "work",
        threadId: String(surface.threadId),
      },
    };
  }
  return { newWindowTarget: { kind: "project", projectId } };
}

function newWindowTargetFromError(error: unknown): ProjectWindowTarget | undefined {
  if (typeof error !== "object" || error === null || !("newWindowTarget" in error)) {
    return undefined;
  }
  const target = error.newWindowTarget;
  if (typeof target !== "object" || target === null || !("kind" in target)) return undefined;
  if (target.kind === "project" && "projectId" in target && typeof target.projectId === "string") {
    return { kind: "project", projectId: decodeProjectId(target.projectId) };
  }
  if (
    target.kind === "project-thread" &&
    "projectId" in target &&
    typeof target.projectId === "string" &&
    "mode" in target &&
    (target.mode === "code" || target.mode === "work") &&
    "threadId" in target &&
    typeof target.threadId === "string"
  ) {
    return {
      kind: "project-thread",
      projectId: decodeProjectId(target.projectId),
      mode: target.mode,
      threadId: target.threadId,
    };
  }
  return undefined;
}

function newTabId(): WorkspaceTabId {
  return decodeWorkspaceTabId(crypto.randomUUID());
}

function surfaceTab(
  surface: WorkspaceSurfaceKind,
  mode: OctantMode,
  threadId?: BrowserThreadId,
  sideChat?: SideChatSource,
  browserContextId?: BrowserContextId,
): WorkspaceTab | undefined {
  if (surface === "thread") {
    return workspaceWelcomeSurface(mode, newTabId());
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
    // Side Chat is always about one thread. With no thread visible in this
    // pane there is nothing to ask about, so the surface is refused rather
    // than opened as a lane that could never name its sidecar.
    if (sideChat === undefined) return undefined;
    return {
      kind: "side-chat",
      id: newTabId(),
      mode,
      title: sideChatTitle(sideChat.title),
      sourceThreadId: sideChat.threadId,
    };
  }
  // terminal and git-review require an active Code thread context and are
  // not advertised by the launcher catalog; they are opened via code surface
  // controls within a Code thread.
  return undefined;
}

function boundThreadId(surface: WorkspaceTab): BrowserThreadId | undefined {
  if (
    surface.kind !== "work-thread" &&
    surface.kind !== "code-overview" &&
    surface.kind !== "code-file" &&
    surface.kind !== "code-terminal" &&
    surface.kind !== "code-test" &&
    surface.kind !== "code-git" &&
    surface.kind !== "code-pr" &&
    surface.kind !== "code-local-review" &&
    surface.kind !== "browser"
  ) {
    return undefined;
  }
  return surface.threadId as unknown as BrowserThreadId;
}

/**
 * The thread a Side Chat opened from this pane would ask about: the pane's
 * visible thread surface, in any mode. A pane showing no thread yields nothing,
 * so the launcher refuses Side Chat instead of opening a lane about nothing.
 */
function sideChatSource(surface: WorkspaceTab): SideChatSource | undefined {
  if (
    surface.kind !== "chat-thread" &&
    surface.kind !== "work-thread" &&
    surface.kind !== "code-overview" &&
    surface.kind !== "code-file" &&
    surface.kind !== "code-terminal" &&
    surface.kind !== "code-test" &&
    surface.kind !== "code-git" &&
    surface.kind !== "code-pr" &&
    surface.kind !== "code-local-review"
  ) {
    return undefined;
  }
  let threadId: MentionableThreadId;
  try {
    threadId = decodeMentionableThreadId(String(surface.threadId));
  } catch {
    return undefined;
  }
  return { threadId, title: surface.title };
}

function newLayoutNodeId(): LayoutNodeId {
  return decodeLayoutNodeId(crypto.randomUUID());
}

function newPaneId(): PaneId {
  return decodePaneId(crypto.randomUUID());
}
