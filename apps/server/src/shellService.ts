import {
  ActorId,
  AggregateVersion,
  CorrelationId,
  type WorkThread,
  type WorkThreadId,
  EventId,
  LOCAL_HOST_ID,
  UtcTimestamp,
  decodeShellCommand,
  type ProjectId,
  type ShellBootstrap,
  type ShellCommandResult,
  type ShellFailure,
  type WindowWorkspace,
  type WorkspaceContextKey,
  type WorkspaceLayoutNode,
  type WindowId,
} from "@octant/contracts";
import {
  ShellPolicyRejected,
  WorkspaceContextRejected,
  applyWorkspaceOperation,
  buildSurfaceCatalog,
  classifyPreviewTabAuthority,
  classifyCanvasTabRestore,
  defaultShellSettings,
  defaultWindowWorkspace,
  enabledModes,
  normalizeEnvironmentPresentationState,
  reconcileWorkspaceWithSettings,
  replaceShellSettings,
  resolveWorkspaceContext,
  type WorkspaceContextResolves,
} from "@octant/domain";
import { Schema } from "effect";
import { ConcurrencyConflict, JournalWriteFailed } from "./persistence/journalErrors";
import type { PersistenceService } from "./persistence/persistenceService";
import { ProjectionApplicationFailed } from "./persistence/projection";
import { SHELL_SETTINGS_AGGREGATE_ID } from "./persistence/shellProjection";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export const OCTANT_LOCAL_ACTOR_ID = decodeActorId("00000000-0000-4000-8000-000000000002");

export interface ShellServiceApi {
  readonly bootstrap: (windowId: WindowId) => ShellBootstrap;
  readonly execute: (command: unknown) => ShellCommandResult;
}

export interface ShellServiceOptions {
  readonly persistence: PersistenceService;
  readonly readWorkThread?: (threadId: WorkThreadId) => WorkThread | undefined;
  readonly uuid: () => string;
  readonly clock: () => string;
}

export class ShellServiceError extends Error {
  override readonly name = "ShellServiceError";

  constructor(readonly failure: ShellFailure) {
    super(failure.message);
  }
}

export class ShellService implements ShellServiceApi {
  readonly #persistence: PersistenceService;
  readonly #readWorkThread: ShellServiceOptions["readWorkThread"];
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #registeredWindowIds = new Set<WindowId>();

  constructor(options: ShellServiceOptions) {
    this.#persistence = options.persistence;
    this.#readWorkThread = options.readWorkThread;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
  }

  bootstrap(windowId: WindowId): ShellBootstrap {
    this.#assertReady();
    try {
      const projectedSettings = this.#persistence.readShellSettings();
      const projectedWorkspace = this.#persistence.readWindowWorkspace(windowId);
      const projectedPresentation = this.#persistence.readEnvironmentPresentation(windowId);
      const settings = projectedSettings?.settings ?? defaultShellSettings();
      const workspace = reconcileWorkspaceWithSettings(
        reconcileCanvasTabs(
          reconcilePreviewTabs(
            inferContextFromProjectTabs(
              reconcileContextWithProjects(
                reconcileProjectTabs(
                  projectedWorkspace?.workspace ?? defaultWindowWorkspace(windowId),
                  this.#persistence,
                ),
                this.#persistence,
              ),
              this.#persistence,
            ),
            this.#persistence,
          ),
          this.#persistence,
        ),
        settings,
      );
      const presentation = normalizeEnvironmentPresentationState({
        byTab: projectedPresentation?.presentation.byTab ?? [],
        byMode: settings.environmentPresentationByMode,
      });
      const bootstrap = {
        settings,
        workspace,
        availableSurfaces: buildSurfaceCatalog(workspace.contextByMode),
        connectionStatus: "connected",
        settingsVersion: projectedSettings?.aggregateVersion ?? decodeAggregateVersion(0),
        workspaceVersion: projectedWorkspace?.aggregateVersion ?? decodeAggregateVersion(0),
        environmentPresentation: presentation,
        presentationVersion: projectedPresentation?.aggregateVersion ?? decodeAggregateVersion(0),
      } as const;
      this.#registeredWindowIds.add(windowId);
      return bootstrap;
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  execute(input: unknown): ShellCommandResult {
    let command: ReturnType<typeof decodeShellCommand>;
    try {
      command = decodeShellCommand(input);
    } catch {
      throw new ShellServiceError({
        category: "invalid",
        message: "Shell command is invalid.",
      });
    }

    this.#assertReady();
    try {
      if (!this.#registeredWindowIds.has(command.windowId)) {
        throw new ShellServiceError({
          category: "invalid",
          message: "Shell command window is not registered with this server session.",
        });
      }
      if (command.kind === "replace-settings") {
        const current = this.#persistence.readShellSettings()?.settings ?? defaultShellSettings();
        const settings = replaceShellSettings(current, command.settings);
        const activeWorkspace = reconcileWorkspaceWithSettings(
          this.#persistence.readWindowWorkspace(command.windowId)?.workspace ??
            defaultWindowWorkspace(command.windowId),
          current,
        );
        const disabledActiveWorkspace = [
          activeWorkspace,
          ...this.#persistence
            .readWindowWorkspaces()
            .map(({ workspace }) => reconcileWorkspaceWithSettings(workspace, current))
            .filter((workspace) => this.#registeredWindowIds.has(workspace.windowId)),
        ].find((workspace) => !enabledModes(settings).includes(workspace.activeMode));
        if (disabledActiveWorkspace !== undefined) {
          throw new ShellServiceError({
            category: "unsupported",
            message: `Switch away from the active ${disabledActiveWorkspace.activeMode} workspace before disabling it.`,
          });
        }
        const committed = this.#persistence.journal.append({
          aggregate: {
            aggregateType: "shell-settings",
            aggregateId: SHELL_SETTINGS_AGGREGATE_ID,
          },
          expectedVersion: command.expectedVersion,
          events: [this.#pendingEvent("shell.settings-replaced", { settings })],
        });
        return { kind: "settings-replaced", settings, version: committed.aggregateVersion };
      }

      if (command.kind === "set-environment-presentation") {
        const presentation = normalizeEnvironmentPresentationState(command.presentation);
        const committed = this.#persistence.journal.append({
          aggregate: {
            aggregateType: "environment-presentation",
            aggregateId: command.windowId,
          },
          expectedVersion: command.expectedVersion,
          events: [this.#pendingEvent("shell.environment-presentation-replaced", { presentation })],
        });
        return {
          kind: "environment-presentation-replaced",
          presentation,
          version: committed.aggregateVersion,
        };
      }

      const settings = this.#persistence.readShellSettings()?.settings ?? defaultShellSettings();
      if (!enabledModes(settings).includes(command.operation.mode)) {
        throw new ShellServiceError({
          category: "unsupported",
          message: `${command.operation.mode} mode is disabled.`,
        });
      }
      const projected = this.#persistence.readWindowWorkspace(command.windowId);
      const current = reconcileWorkspaceWithSettings(
        reconcileContextWithProjects(
          projected?.workspace ?? defaultWindowWorkspace(command.windowId),
          this.#persistence,
        ),
        settings,
      );
      if (
        (command.operation.kind === "open-tab" ||
          command.operation.kind === "switch-project-tab") &&
        command.operation.tab.kind === "project"
      ) {
        const project = this.#persistence.readProject(command.operation.tab.projectId);
        if (
          project === undefined ||
          project.lifecycle !== "active" ||
          project.type !== command.operation.mode ||
          project.type !== command.operation.tab.mode
        ) {
          throw new ShellServiceError({
            category: "invalid",
            message: "Project tab requires an active matching Project.",
          });
        }
      }
      if (command.operation.kind === "open-tab" && command.operation.tab.kind === "preview") {
        // Preview tabs carry their own opaque Project binding. Validate the
        // Project is still active and matches the operation mode before the
        // pure context policy enforces the one-Project invariant. The host
        // reauthorizes the opaque target on every open/chunk/refresh after
        // the tab is journaled.
        const project = this.#persistence.readProject(command.operation.tab.projectId);
        if (
          project === undefined ||
          project.lifecycle !== "active" ||
          project.type !== command.operation.mode ||
          project.type !== command.operation.tab.mode
        ) {
          throw new ShellServiceError({
            category: "invalid",
            message: "Preview tab requires an active matching Project.",
          });
        }
      }
      if (command.operation.kind === "open-tab" && command.operation.tab.kind === "canvas") {
        const project = this.#persistence.readProject(command.operation.tab.projectId);
        const canvas = this.#persistence.canvasProjection.getById(command.operation.tab.canvasId);
        if (
          project === undefined ||
          project.lifecycle !== "active" ||
          project.type !== command.operation.mode ||
          project.type !== command.operation.tab.mode ||
          canvas === undefined ||
          String(canvas.currentVersion.definition.provenance.projectId) !==
            String(command.operation.tab.projectId)
        ) {
          throw new ShellServiceError({
            category: "invalid",
            message: "Canvas tab requires an active matching Project and Canvas.",
          });
        }
      }
      const resolved = resolveWorkspaceContext(current, command.operation, this.#contextResolves());
      const workspace = applyWorkspaceOperation(resolved, command.operation);
      const committed = this.#persistence.journal.append({
        aggregate: { aggregateType: "window-workspace", aggregateId: command.windowId },
        expectedVersion: command.expectedVersion,
        events: [this.#pendingEvent("workspace.layout-replaced", { workspace })],
      });
      const presentation = reconcileCanvasTabs(
        reconcilePreviewTabs(reconcileProjectTabs(workspace, this.#persistence), this.#persistence),
        this.#persistence,
      );
      return {
        kind: "workspace-replaced",
        workspace: presentation,
        version: committed.aggregateVersion,
      };
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  #contextResolves(): WorkspaceContextResolves {
    const persistence = this.#persistence;
    return {
      tabContext: (tab) => resolveTabContext(tab, persistence, this.#readWorkThread),
    };
  }

  #pendingEvent(eventName: string, payload: unknown) {
    return {
      eventId: decodeEventId(this.#uuid()),
      eventName,
      eventVersion: 1,
      correlationId: decodeCorrelationId(this.#uuid()),
      actor: { kind: "system" as const, actorId: OCTANT_LOCAL_ACTOR_ID },
      occurredAt: decodeTimestamp(this.#clock()),
      payload,
    };
  }

  #assertReady(): void {
    try {
      const status = this.#persistence.status();
      if (status.state !== "current" || status.integrity !== "ok") {
        throw new ShellServiceError({
          category: "recovery-required",
          message: "Octant storage requires recovery before shell commands can run.",
        });
      }
    } catch (error) {
      if (error instanceof ShellServiceError) throw error;
      throw new ShellServiceError({
        category: "unavailable",
        message: "Octant storage is unavailable.",
      });
    }
  }

  #mapFailure(error: unknown): ShellServiceError {
    if (error instanceof ShellServiceError) return error;
    if (error instanceof WorkspaceContextRejected) {
      return new ShellServiceError({
        category: "cross-context",
        message: error.message,
        offerNewWindow: true,
      });
    }
    if (error instanceof ShellPolicyRejected) {
      return new ShellServiceError({ category: "invalid", message: error.message });
    }
    if (error instanceof ConcurrencyConflict) {
      return new ShellServiceError({
        category: "conflict",
        message: "Shell state changed; reload and retry.",
        expectedVersion: decodeAggregateVersion(error.expectedVersion),
        actualVersion: decodeAggregateVersion(error.actualVersion),
      });
    }
    if (error instanceof JournalWriteFailed || error instanceof ProjectionApplicationFailed) {
      return new ShellServiceError({
        category: "unavailable",
        message: "Octant could not save shell state.",
      });
    }
    return new ShellServiceError({
      category: "unavailable",
      message: "Octant shell state is unavailable.",
    });
  }
}

function reconcileProjectTabs(
  workspace: WindowWorkspace,
  persistence: PersistenceService,
): WindowWorkspace {
  const visit = (
    layout: WorkspaceLayoutNode,
    mode: "chat" | "work" | "code",
  ): WorkspaceLayoutNode => {
    if (layout.kind === "split") {
      return { ...layout, first: visit(layout.first, mode), second: visit(layout.second, mode) };
    }
    return {
      ...layout,
      tabs: layout.tabs.map((tab) => {
        if (tab.kind !== "project") return { ...tab };
        const project = persistence.readProject(tab.projectId);
        if (project !== undefined && project.type === tab.mode && project.type === mode) {
          return { ...tab };
        }
        return {
          kind: "unavailable" as const,
          id: tab.id,
          title: tab.title,
          reason: "Project is unavailable. Reopen it from Projects.",
        };
      }),
    };
  };
  return {
    ...workspace,
    layouts: {
      chat: visit(workspace.layouts.chat, "chat"),
      work: visit(workspace.layouts.work, "work"),
      code: visit(workspace.layouts.code, "code"),
    },
  };
}

/**
 * Convert persisted preview tabs whose Project binding is no longer
 * authoritative into unavailable placeholders. A preview tab is restorable
 * only when the active mode context is bound to the same active Project; a
 * stale, archived, or cross-Project preview never guesses a replacement
 * file. The host still reauthorizes the opaque target on every
 * open/chunk/refresh after the tab is presented.
 */
function reconcilePreviewTabs(
  workspace: WindowWorkspace,
  persistence: PersistenceService,
): WindowWorkspace {
  const visit = (
    layout: WorkspaceLayoutNode,
    mode: "chat" | "work" | "code",
    activeProjectId: ProjectId | null,
  ): WorkspaceLayoutNode => {
    if (layout.kind === "split") {
      return {
        ...layout,
        first: visit(layout.first, mode, activeProjectId),
        second: visit(layout.second, mode, activeProjectId),
      };
    }
    return {
      ...layout,
      tabs: layout.tabs.map((tab) => {
        if (tab.kind !== "preview") return { ...tab };
        const authority = classifyPreviewTabAuthority({
          tabProjectId: tab.projectId,
          activeProjectId,
        });
        if (authority === "bound") {
          // The Project is still active and matches the mode context. The
          // host reauthorizes the opaque target on restore; keep the tab
          // durable so the renderer can reopen it.
          return { ...tab };
        }
        return {
          kind: "unavailable" as const,
          id: tab.id,
          title: tab.title,
          reason: "Preview is unavailable. Reopen it from the Project.",
        };
      }),
    };
  };
  return {
    ...workspace,
    layouts: {
      chat: visit(workspace.layouts.chat, "chat", workspace.contextByMode.chat.projectId),
      work: visit(workspace.layouts.work, "work", workspace.contextByMode.work.projectId),
      code: visit(workspace.layouts.code, "code", workspace.contextByMode.code.projectId),
    },
  };
}

function reconcileCanvasTabs(
  workspace: WindowWorkspace,
  persistence: PersistenceService,
): WindowWorkspace {
  const visit = (
    layout: WorkspaceLayoutNode,
    mode: "chat" | "work" | "code",
    activeProjectId: ProjectId | null,
  ): WorkspaceLayoutNode => {
    if (layout.kind === "split") {
      return {
        ...layout,
        first: visit(layout.first, mode, activeProjectId),
        second: visit(layout.second, mode, activeProjectId),
      };
    }
    return {
      ...layout,
      tabs: layout.tabs.map((tab) => {
        if (tab.kind !== "canvas") return { ...tab };
        const projection = persistence.canvasProjection.getById(tab.canvasId);
        const canvasProjectId =
          projection === undefined
            ? null
            : projection.currentVersion.definition.provenance.projectId;
        const authority = classifyCanvasTabRestore({
          tabProjectId: tab.projectId,
          activeProjectId,
          canvasProjectId,
        });
        if (authority === "bound") return { ...tab };
        return {
          kind: "unavailable" as const,
          id: tab.id,
          title: tab.title,
          reason: "Canvas is unavailable. Reopen it from the Project.",
        };
      }),
    };
  };
  return {
    ...workspace,
    layouts: {
      chat: visit(workspace.layouts.chat, "chat", workspace.contextByMode.chat.projectId),
      work: visit(workspace.layouts.work, "work", workspace.contextByMode.work.projectId),
      code: visit(workspace.layouts.code, "code", workspace.contextByMode.code.projectId),
    },
  };
}

function reconcileContextWithProjects(
  workspace: WindowWorkspace,
  persistence: PersistenceService,
): WindowWorkspace {
  // Clear stale context bindings: if a bound Project is archived, deleted, or
  // no longer matches the mode, drop its projectId/boundRoot so the surface
  // catalog fails closed for root-backed surfaces until a fresh Project opens.
  // Root-backed tabs (browser/files) whose context is being cleared are first
  // converted to unavailable so validateTabContext does not reject the layout
  // during reconcileWorkspaceWithSettings.
  const visit = (
    layout: WorkspaceLayoutNode,
    mode: "chat" | "work" | "code",
    staleProjectId: ProjectId | null,
  ): WorkspaceLayoutNode => {
    if (layout.kind === "split") {
      return {
        ...layout,
        first: visit(layout.first, mode, staleProjectId),
        second: visit(layout.second, mode, staleProjectId),
      };
    }
    if (staleProjectId === null) return layout;
    return {
      ...layout,
      tabs: layout.tabs.map((tab) =>
        tab.kind === "browser" || tab.kind === "files"
          ? {
              kind: "unavailable" as const,
              id: tab.id,
              title: tab.title,
              reason: "Project is unavailable. Reopen it to restore this surface.",
            }
          : tab,
      ),
    };
  };
  const reconcileMode = (
    context: WorkspaceContextKey,
    mode: "chat" | "work" | "code",
    layout: WorkspaceLayoutNode,
  ): { context: WorkspaceContextKey; layout: WorkspaceLayoutNode } => {
    if (context.projectId === null) return { context, layout };
    const project = persistence.readProject(context.projectId);
    // Missing or archived Project: clear the context and convert root-backed
    // tabs to unavailable so the layout remains restorable.
    if (project === undefined || project.lifecycle !== "active" || project.type !== mode) {
      const cleared: WorkspaceContextKey = {
        host: context.host,
        mode,
        projectId: null,
        boundRoot: null,
      };
      return {
        context: cleared,
        layout: visit(layout, mode, context.projectId),
      };
    }
    // Same active Project relinked to a new canonical root: rebind the context
    // to the new root instead of clearing, so root-backed tabs keep authority.
    if (project.type !== "chat" && project.binding.canonicalRoot !== context.boundRoot) {
      return {
        context: {
          host: context.host,
          mode,
          projectId: project.id,
          boundRoot: project.binding.canonicalRoot,
        },
        layout,
      };
    }
    return { context, layout };
  };
  const chat = reconcileMode(workspace.contextByMode.chat, "chat", workspace.layouts.chat);
  const work = reconcileMode(workspace.contextByMode.work, "work", workspace.layouts.work);
  const code = reconcileMode(workspace.contextByMode.code, "code", workspace.layouts.code);
  return {
    ...workspace,
    contextByMode: { chat: chat.context, work: work.context, code: code.context },
    layouts: { chat: chat.layout, work: work.layout, code: code.layout },
  };
}

function inferContextFromProjectTabs(
  workspace: WindowWorkspace,
  persistence: PersistenceService,
): WindowWorkspace {
  // For workspaces upcasted before contextByMode existed, or whose context was
  // cleared after a stale Project was archived, infer the mode context from an
  // active Project tab in that mode's layout so the launcher catalog reflects
  // the bound Project and root-backed surfaces remain available. When multiple
  // Project tabs exist in the same mode, only the first active matching one
  // becomes the authority; the rest are converted to unavailable so activating
  // them cannot bypass the open-tab context guard.
  const quarantineExtraProjects = (
    layout: WorkspaceLayoutNode,
    mode: "chat" | "work" | "code",
    boundProjectId: ProjectId | null,
  ): WorkspaceLayoutNode => {
    if (boundProjectId === null) return layout;
    if (layout.kind === "split") {
      return {
        ...layout,
        first: quarantineExtraProjects(layout.first, mode, boundProjectId),
        second: quarantineExtraProjects(layout.second, mode, boundProjectId),
      };
    }
    return {
      ...layout,
      tabs: layout.tabs.map((tab) => {
        if (tab.kind !== "project" || tab.mode !== mode) return tab;
        if (tab.projectId === boundProjectId) return tab;
        return {
          kind: "unavailable" as const,
          id: tab.id,
          title: tab.title,
          reason: "Only one Project can be active per mode. Reopen this Project in a new window.",
        };
      }),
    };
  };
  const inferMode = (
    context: WorkspaceContextKey,
    mode: "chat" | "work" | "code",
    layout: WorkspaceLayoutNode,
  ): { context: WorkspaceContextKey; layout: WorkspaceLayoutNode } => {
    if (context.projectId !== null) return { context, layout };
    const projectTab = firstProjectTab(layout, mode);
    if (projectTab === undefined) return { context, layout };
    const project = persistence.readProject(projectTab.projectId);
    if (project === undefined || project.lifecycle !== "active" || project.type !== mode) {
      return { context, layout };
    }
    return {
      context: {
        host: context.host,
        mode,
        projectId: project.id,
        boundRoot: project.type === "chat" ? null : project.binding.canonicalRoot,
      },
      layout: quarantineExtraProjects(layout, mode, project.id),
    };
  };
  const chat = inferMode(workspace.contextByMode.chat, "chat", workspace.layouts.chat);
  const work = inferMode(workspace.contextByMode.work, "work", workspace.layouts.work);
  const code = inferMode(workspace.contextByMode.code, "code", workspace.layouts.code);
  return {
    ...workspace,
    contextByMode: { chat: chat.context, work: work.context, code: code.context },
    layouts: { chat: chat.layout, work: work.layout, code: code.layout },
  };
}

function firstProjectTab(
  layout: WorkspaceLayoutNode,
  mode: "chat" | "work" | "code",
): { readonly projectId: ProjectId } | undefined {
  if (layout.kind === "split") {
    return firstProjectTab(layout.first, mode) ?? firstProjectTab(layout.second, mode);
  }
  return layout.tabs.find((tab) => tab.kind === "project" && tab.mode === mode) as
    | { readonly projectId: ProjectId }
    | undefined;
}

function resolveTabContext(
  tab: Parameters<WorkspaceContextResolves["tabContext"]>[0],
  persistence: PersistenceService,
  readWorkThread: ShellServiceOptions["readWorkThread"],
): WorkspaceContextKey | undefined {
  if (tab.kind === "project") {
    const project = persistence.readProject(tab.projectId);
    if (project === undefined) return undefined;
    const boundRoot = project.type === "chat" ? null : project.binding.canonicalRoot;
    return {
      host: LOCAL_HOST_ID,
      mode: tab.mode,
      projectId: project.id,
      boundRoot,
    };
  }
  if (tab.kind === "chat-thread") {
    const thread = persistence.readChatThread(tab.threadId);
    if (thread === undefined) return undefined;
    const projectId = thread.projectId ?? null;
    if (projectId !== null) {
      const project = persistence.readProject(projectId);
      if (project === undefined || project.lifecycle !== "active" || project.type !== "chat") {
        return undefined;
      }
    }
    return {
      host: LOCAL_HOST_ID,
      mode: "chat",
      projectId,
      boundRoot: null,
    };
  }
  if (tab.kind === "work-thread") {
    const thread = readWorkThread?.(tab.threadId);
    if (thread === undefined) return undefined;
    const project = persistence.readProject(thread.projectId);
    if (project === undefined || project.lifecycle !== "active" || project.type !== "work") {
      return undefined;
    }
    return {
      host: LOCAL_HOST_ID,
      mode: "work",
      projectId: thread.projectId,
      boundRoot: project.binding.canonicalRoot,
    };
  }
  if (tab.kind === "browser" && tab.mode === "work" && tab.threadId !== undefined) {
    const thread = readWorkThread?.(tab.threadId as never);
    if (thread === undefined) return undefined;
    const project = persistence.readProject(thread.projectId);
    if (project === undefined || project.lifecycle !== "active" || project.type !== "work") {
      return undefined;
    }
    return {
      host: LOCAL_HOST_ID,
      mode: "work",
      projectId: thread.projectId,
      boundRoot: project.binding.canonicalRoot,
    };
  }
  if ("threadId" in tab && tab.threadId !== undefined && tab.mode === "code") {
    // Browser tabs carry the provider-neutral BrowserThreadId brand while the
    // persisted owner keeps its mode-specific brand. The UUID is the same
    // server-issued thread identity; rebrand only after the mode check above.
    const thread = persistence.readCodeThread(tab.threadId as never);
    if (thread === undefined) return undefined;
    const project = persistence.readProject(thread.projectId);
    if (project === undefined || project.lifecycle !== "active" || project.type !== "code") {
      return undefined;
    }
    // Reject stale Code threads whose binding revision no longer matches the
    // Project's latest binding, so a relinked repository cannot be opened
    // under the wrong authority.
    const latestRevision = project.bindingHistory[project.bindingHistory.length - 1];
    if (latestRevision === undefined || latestRevision.revisionId !== thread.bindingRevisionId) {
      return undefined;
    }
    return {
      host: LOCAL_HOST_ID,
      mode: "code",
      projectId: thread.projectId,
      boundRoot: project.binding.canonicalRoot,
    };
  }
  return undefined;
}
