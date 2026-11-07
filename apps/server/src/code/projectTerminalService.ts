import type { ChildWorktreeSourceService } from "./childWorktreeSourceService";
import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  EventName,
  PROJECT_TERMINAL_EVENT_NAMES,
  UtcTimestamp,
  decodeProjectTerminalEnded,
  decodeProjectTerminalResult,
  decodeProjectTerminalStarted,
  type BindingRevisionId,
  type BoundProject,
  type CodeTerminalId,
  type ProjectAction,
  type CodeThreadId,
  type CodeCheckoutId,
  type ProviderExecutionPolicy,
  type ProjectActionSuggestion,
  type EventActor as EventActorValue,
  type Project,
  type ProjectId,
  type ProjectTerminalCommand,
  type ProjectTerminalEndReason,
  type ProjectTerminalPosture,
  type ProjectTerminalRefusalReason,
  type ProjectTerminalResult,
  type WindowId,
} from "@octant/contracts";
import { Schema } from "effect";
import { statSync } from "node:fs";
import { projectExtraFolderRoots } from "@octant/domain";
import type { Journal } from "../persistence/journal";
import { LINUX_BUBBLEWRAP_MISSING_NOTICE } from "../process/linuxConfinement";
import { ProcessConfinementError } from "../process/seatbeltProfile";
import type { ServerTerminalLogin } from "../serverProjects/serverTerminal";
import type { TerminalService, TerminalSnapshot } from "./terminalService";
import { defaultTerminalShell } from "./terminalShell";
import type { WorktreePreparationService } from "./worktreePreparationService";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export const PROJECT_TERMINAL_AGGREGATE = "project-terminal";

/** Who is asking. Only the person at a local window may drive a Project terminal. */
export type ProjectTerminalCaller = "local-window" | "remote-device";

interface ActionCheckout {
  readonly workingRoot?: string;
  readonly preparationAccess?: { readonly commands: boolean; readonly network: boolean };
  readonly receiptId?: string;
  readonly preparationThread?: { readonly threadId: string; readonly checkoutId: string };
  readonly root: string;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly branch?: string;
  readonly head?: string;
  readonly current: () => boolean;
  readonly active?: () => boolean;
}
type ActionReceipt = NonNullable<
  Extract<ProjectTerminalResult, { kind: "project-terminal" }>["terminal"]["action"]
>;
export interface ServerProjectActionPlacement {
  readonly kind: "placed-on-server";
  readonly projectVersion: AggregateVersion;
  readonly bindingRevisionId: BindingRevisionId;
  readonly action: ProjectAction;
  readonly receipt: ActionReceipt;
  readonly login: ServerTerminalLogin;
  readonly current: () => boolean;
}
export type ProjectActionPlacementRequest = Extract<
  ProjectTerminalCommand,
  { kind: "preview-action" | "start-action" }
>;

export interface ProjectTerminalServiceOptions {
  readonly placeServerAction?: (
    windowId: WindowId,
    command: ProjectActionPlacementRequest,
  ) => Promise<
    | ServerProjectActionPlacement
    | Extract<ProjectTerminalResult, { kind: "project-terminal-refused" }>
  >;
  readonly suggestServerActions?: (
    projectId: ProjectId,
  ) => Promise<ReadonlyArray<ProjectActionSuggestion> | undefined>;
  readonly worktreePreparation?: WorktreePreparationService;
  readonly childWorktreeSources?: ChildWorktreeSourceService;
  readonly resolveActionWorkThread?: (
    windowId: WindowId,
    projectId: ProjectId,
    threadId: import("@octant/contracts").WorkThreadId,
  ) => Promise<ActionCheckout | undefined>;
  readonly resolveActionCheckout?: (
    windowId: WindowId,
    projectId: ProjectId,
    thread: {
      readonly threadId: CodeThreadId;
      readonly checkoutId: CodeCheckoutId;
      readonly head?: string | undefined;
    },
    childRequestId?: string,
  ) => Promise<ActionCheckout | undefined>;

  readonly terminals: Pick<
    TerminalService,
    "launch" | "observe" | "readSince" | "write" | "resize" | "terminate"
  >;
  readonly readProject: (projectId: ProjectId) => Project | undefined;
  /**
   * The window's own Project binding for that Project's mode; see
   * `windowCanAccessCodeProject`.
   */
  readonly canAccessProject: (windowId: WindowId, projectId: ProjectId) => boolean;
  /**
   * The Project's bound root as the host verifies it now, or undefined when the
   * folder is gone, moved, or no longer the one the binding names.
   */
  readonly resolveRoot: (project: BoundProject) => Promise<string | undefined>;
  /** What the Project's own files at this root suggest saving as actions. */
  readonly suggestActions: (root: string) => Promise<ReadonlyArray<ProjectActionSuggestion>>;
  /** Terminals the journal still records as running, for restart. */
  readonly readRunning: () => ReadonlyArray<{
    readonly projectId: ProjectId;
    readonly terminalId: CodeTerminalId;
  }>;
  readonly journal: Pick<Journal, "append">;
  readonly actor: EventActorValue;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly shell?: string;
  /**
   * A Code Project on a registered server, which the local catalog never
   * holds. Absent for every local Project.
   */
  readonly serverProject?: (projectId: ProjectId) => ServerProjectTerminalTarget | undefined;
}

/** Where a server Project's terminal logs in. Canonical: docs/design/server-projects.md § Threads. */
export interface ServerProjectTerminalTarget {
  /** Derived from the Project, server, and folder, so a rebound Project ends its shells. */
  readonly bindingRevisionId: BindingRevisionId;
  /** The login now, or undefined once its server left the registry. */
  readonly login: () => ServerTerminalLogin | undefined;
}

interface Owner {
  readonly terminalId: CodeTerminalId;
  readonly windowId: WindowId;
  readonly projectId: ProjectId;
  readonly bindingRevisionId: BindingRevisionId;
  readonly posture: ProjectTerminalPosture;
  stopObserving: (() => void) | undefined;
  /** Set once the end is journaled, so an exit racing a stop is recorded once. */
  ended: boolean;
  readonly action?: ActionReceipt;
  readonly actionAuthorized?: () => boolean;
  uncertainty?: "server-transport-lost" | "server-stop-unconfirmed";
}

type Authority =
  | {
      readonly kind: "allowed";
      readonly project: BoundProject;
      readonly bindingRevisionId: BindingRevisionId;
    }
  | {
      readonly kind: "allowed-on-server";
      readonly server: ServerProjectTerminalTarget;
      readonly bindingRevisionId: BindingRevisionId;
    }
  | {
      readonly kind: "refused";
      readonly reason: ProjectTerminalRefusalReason;
      readonly message: string;
    };

/**
 * Terminals a person opens for a Work or Code Project without a thread.
 *
 * The shell is the same confined terminal a Code thread gets, started at the
 * Project's bound root. What differs is who may reach it: nothing but the
 * person at the local window that opened it. No provider, tool, or thread is
 * handed a way to name one, which is why it needs no approval prompt — the
 * person opening their own shell is the approval, exactly as it is for a
 * user-started terminal in an approval-gated Code thread.
 */
export class ProjectTerminalService {
  readonly #options: ProjectTerminalServiceOptions;
  readonly #actor: EventActorValue;
  readonly #owners = new Map<string, Owner>();

  constructor(options: ProjectTerminalServiceOptions) {
    this.#options = options;
    const actor = decodeActor(options.actor);
    decodeActorId(actor.actorId);
    this.#actor = actor;
  }

  /**
   * End every terminal the journal still records as running. A host restart
   * does not carry a shell over, so the record says what happened to it rather
   * than leaving it running on paper. Call before serving commands.
   */
  reconcile(): void {
    for (const running of this.#options.readRunning()) {
      if (this.#owners.has(String(running.terminalId))) continue;
      try {
        this.#journalEnded(running.projectId, running.terminalId, "host-restarted", undefined);
      } catch {
        // Another start of this host already recorded the end. Replay settles
        // on the same record either way.
      }
    }
  }

  async execute(
    windowId: WindowId,
    caller: ProjectTerminalCaller,
    command: ProjectTerminalCommand,
  ): Promise<ProjectTerminalResult> {
    // A remote Code terminal is gated as an agent and waits on an approval the
    // thread holds. A Project terminal has no thread to hold one, so a paired
    // device is refused here rather than given a shell with nothing gating it.
    if (caller !== "local-window") {
      return refused(
        "unauthorized",
        "Project terminals open only from this computer's own window.",
      );
    }
    if (command.kind === "start") return this.#start(windowId, command);
    if (command.kind === "preview-action") return this.#previewAction(windowId, command);
    if (command.kind === "start-action") return this.#startAction(windowId, command);
    if (command.kind === "child-worktree-source") return this.#childSource(windowId, command);
    if (command.kind === "worktree-preparation") return this.#preparation(windowId, command);
    if (command.kind === "suggest-actions") return this.#suggest(windowId, command.projectId);

    const owner = this.#owners.get(String(command.terminalId));
    if (owner === undefined) {
      return refused("unavailable", "This terminal is not running on this host.");
    }
    if (
      String(owner.windowId) !== String(windowId) ||
      String(owner.projectId) !== String(command.projectId)
    ) {
      return refused("unauthorized", "This terminal belongs to another window or Project.");
    }
    if (owner.actionAuthorized?.() === false) {
      await this.#end(command.terminalId, owner, "authority-revoked");
      return refused("authority-revoked", "This task no longer authorizes its action.");
    }
    const authority = this.#authority(windowId, command.projectId);
    if (authority.kind === "refused") {
      if (authority.reason === "authority-revoked") {
        await this.#end(command.terminalId, owner, "authority-revoked");
      }
      return refused(authority.reason, authority.message);
    }
    if (String(authority.bindingRevisionId) !== String(owner.bindingRevisionId)) {
      await this.#end(command.terminalId, owner, "authority-revoked");
      return refused("authority-revoked", "This Project's folder changed, so its terminal ended.");
    }

    try {
      switch (command.kind) {
        case "attach":
          return this.#view(command.terminalId, owner, 0);
        case "read-output":
          return this.#view(command.terminalId, owner, command.afterCharacters);
        case "write":
          this.#options.terminals.write(String(command.terminalId), command.data);
          return this.#view(command.terminalId, owner);
        case "resize":
          this.#options.terminals.resize(String(command.terminalId), command.columns, command.rows);
          return this.#view(command.terminalId, owner);
        case "stop":
          await this.#end(command.terminalId, owner, "stopped");
          return this.#view(command.terminalId, owner);
        case "run-action":
          return refused(
            "unavailable",
            "Review the action and start a dedicated run. Saved commands are never typed into an existing shell.",
          );
      }
    } catch {
      return refused("unavailable", "This terminal is no longer running.");
    }
  }

  async #childSource(
    windowId: WindowId,
    command: Extract<ProjectTerminalCommand, { kind: "child-worktree-source" }>,
  ): Promise<ProjectTerminalResult> {
    const authority = this.#authority(windowId, command.projectId);
    if (authority.kind !== "allowed" || authority.project.type !== "code")
      return refused(
        "unauthorized",
        "Child source review requires this Code Project's local window.",
      );
    const checkout = await this.#options
      .resolveActionCheckout?.(windowId, command.projectId, command.thread)
      .catch(() => undefined);
    const service = this.#options.childWorktreeSources;
    if (service === undefined || checkout?.head === undefined || !checkout.current())
      return refused("unavailable", "This checkout cannot capture an authorized committed base.");
    try {
      const result = await service.command(
        {
          threadId: String(command.thread.threadId),
          checkoutId: String(command.thread.checkoutId),
          bindingRevisionId: String(authority.bindingRevisionId),
          root: checkout.root,
          head: checkout.head,
          executionPolicy: checkout.executionPolicy,
          current: checkout.current,
        },
        command.action,
        command.snapshotId,
      );
      return result.status === "refused"
        ? refused("unavailable", result.message)
        : decodeProjectTerminalResult({ kind: "child-worktree-source", review: result.review });
    } catch {
      return refused(
        "unavailable",
        "Child source could not be recorded. Inspect the checkout and review the source again.",
      );
    }
  }

  async #preparation(
    windowId: WindowId,
    command: Extract<ProjectTerminalCommand, { kind: "worktree-preparation" }>,
  ): Promise<ProjectTerminalResult> {
    const authority = this.#authority(windowId, command.projectId);
    if (authority.kind !== "allowed")
      return refused("unauthorized", "Worktree setup requires this Project's local window.");
    const service = this.#options.worktreePreparation;
    const checkout = await this.#options
      .resolveActionCheckout?.(windowId, command.projectId, command.thread, command.childRequestId)
      .catch(() => undefined);
    if (service === undefined || checkout?.receiptId === undefined || !checkout.current())
      return refused("unavailable", "This checkout has no available managed preparation.");
    const context = await service.context({
      commandAccess: checkout.preparationAccess?.commands ?? true,
      networkAllowed: checkout.preparationAccess?.network ?? true,
      receiptId: checkout.receiptId,
      root: checkout.root,
      executionPolicy: checkout.executionPolicy,
      current: checkout.active ?? checkout.current,
      threadId: checkout.preparationThread?.threadId ?? String(command.thread.threadId),
      checkoutId: checkout.preparationThread?.checkoutId ?? String(command.thread.checkoutId),
      projectId: String(command.projectId),
    });
    if (context === undefined)
      return refused("authority-revoked", "Worktree preparation ownership changed.");
    try {
      const result = await service.command(context, command.action, command.attemptId);
      return result.status === "refused"
        ? refused("unavailable", result.message)
        : decodeProjectTerminalResult({ kind: "worktree-preparation", ...result.view });
    } catch {
      return refused(
        "unavailable",
        "Setup cannot perform that action. Cancel a running preparation first; retry needs the reviewed recipe, write access, and confirmed process cleanup.",
      );
    }
  }

  /**
   * Whether this window owns this Project terminal right now. The Zen card
   * asks before it is written, so a card can only name a shell its window
   * already has.
   */
  owns(windowId: WindowId, projectId: ProjectId, terminalId: CodeTerminalId): boolean {
    const owner = this.#owners.get(String(terminalId));
    return (
      owner !== undefined &&
      String(owner.windowId) === String(windowId) &&
      String(owner.projectId) === String(projectId) &&
      this.#authority(windowId, projectId).kind !== "refused"
    );
  }

  /**
   * End every running terminal of a Project that is no longer what its shells
   * were opened against: archived, or relinked to another root. Called when
   * the journal commits a Project lifecycle or binding change, so a shell does
   * not keep running in a folder the Project no longer names.
   */
  async settleActionAuthorities(): Promise<void> {
    await Promise.allSettled(
      [...this.#owners.values()]
        .filter((owner) => !owner.ended && owner.actionAuthorized?.() === false)
        .map((owner) => this.#end(owner.terminalId, owner, "authority-revoked")),
    );
  }

  async settleProject(projectId: ProjectId): Promise<void> {
    const project = this.#options.readProject(projectId);
    const current =
      (project?.type === "code" || project?.type === "work") && project.lifecycle === "active"
        ? project.bindingHistory.at(-1)?.revisionId
        : this.#options.serverProject?.(projectId)?.bindingRevisionId;
    const ending: Array<Promise<void>> = [];
    for (const owner of this.#owners.values()) {
      if (owner.ended || String(owner.projectId) !== String(projectId)) continue;
      if (current !== undefined && String(current) === String(owner.bindingRevisionId)) continue;
      ending.push(this.#end(owner.terminalId, owner, "authority-revoked"));
    }
    await Promise.allSettled(ending);
  }

  /**
   * End every running terminal of a Project that is gone, without reading
   * the catalog: a server Project's removal is committed to the journal
   * before its catalog forgets it, so a settle at that moment would still
   * find the Project and keep its shells.
   */
  async revokeProject(projectId: ProjectId): Promise<void> {
    const ending: Array<Promise<void>> = [];
    for (const owner of this.#owners.values()) {
      if (owner.ended || String(owner.projectId) !== String(projectId)) continue;
      ending.push(this.#end(owner.terminalId, owner, "authority-revoked"));
    }
    await Promise.allSettled(ending);
  }

  async #suggest(windowId: WindowId, projectId: ProjectId): Promise<ProjectTerminalResult> {
    const authority = this.#authority(windowId, projectId);
    if (authority.kind === "refused") return refused(authority.reason, authority.message);
    // A server Project's files are read through its remote boundary, never
    // handed to the local folder resolver.
    if (authority.kind === "allowed-on-server") {
      const suggestions = await this.#options
        .suggestServerActions?.(projectId)
        .catch(() => undefined);
      const latest = this.#authority(windowId, projectId);
      return suggestions === undefined ||
        latest.kind !== "allowed-on-server" ||
        latest.bindingRevisionId !== authority.bindingRevisionId
        ? refused("unavailable", "This server Project could not be read. Nothing was read locally.")
        : decodeProjectTerminalResult({
            kind: "project-action-suggestions",
            projectId,
            suggestions,
          });
    }
    const root = await this.#options.resolveRoot(authority.project);
    if (root === undefined) {
      return refused("unavailable", "This Project's folder is unavailable. Relink the Project.");
    }
    return decodeProjectTerminalResult({
      kind: "project-action-suggestions",
      projectId,
      suggestions: await this.#options.suggestActions(root).catch(() => []),
    });
  }

  /**
   * The folder a start or an action names, or undefined when the Project does
   * not list it. Compared as the exact string the Project record holds, so a
   * caller cannot reach a folder by describing it another way.
   */
  #folderRoot(project: BoundProject, mainRoot: string, folder: string | undefined) {
    if (folder === undefined || folder === mainRoot) return mainRoot;
    return projectExtraFolderRoots(project).includes(folder) && isDirectory(folder)
      ? folder
      : undefined;
  }

  async #previewAction(
    windowId: WindowId,
    command: Extract<ProjectTerminalCommand, { kind: "preview-action" }>,
  ): Promise<ProjectTerminalResult> {
    const placed = await this.#placeAction(windowId, command);
    if (placed.kind === "project-terminal-refused") return placed;
    return decodeProjectTerminalResult({
      kind: "project-action-preview",
      projectId: command.projectId,
      projectVersion:
        placed.kind === "placed-on-server" ? placed.projectVersion : placed.project.version,
      action: placed.receipt,
    });
  }

  async #placeAction(
    windowId: WindowId,
    command: Extract<ProjectTerminalCommand, { kind: "preview-action" | "start-action" }>,
  ) {
    const authority = this.#authority(windowId, command.projectId);
    if (authority.kind === "allowed-on-server")
      return (
        (await this.#options.placeServerAction?.(windowId, command)) ??
        refused("unavailable", "Saved actions are unavailable for this server Project.")
      );
    if (authority.kind !== "allowed")
      return refused("unauthorized", "Open a local Project to run its action.");
    const action = authority.project.actions?.find(
      (candidate) => String(candidate.id) === String(command.actionId),
    );
    if (action === undefined) return refused("unavailable", "This Project has no such action.");
    if (command.thread !== undefined && command.workThreadId !== undefined)
      return refused("unauthorized", "Choose one task for this action.");
    const checkout =
      command.workThreadId !== undefined
        ? await this.#options
            .resolveActionWorkThread?.(windowId, command.projectId, command.workThreadId)
            .catch(() => undefined)
        : command.thread === undefined
          ? undefined
          : await (
              this.#options.resolveActionCheckout?.(windowId, command.projectId, command.thread) ??
              Promise.resolve(undefined)
            ).catch(() => undefined);
    if (
      (command.thread !== undefined || command.workThreadId !== undefined) &&
      (checkout === undefined ||
        !checkout.current() ||
        (command.kind === "start-action" && checkout.executionPolicy === "plan"))
    )
      return refused(
        "authority-revoked",
        "This checkout changed or cannot run an action. Review it again.",
      );
    const projectRoot = await this.#options.resolveRoot(authority.project);
    if (projectRoot === undefined)
      return refused("unavailable", "This Project's folder is unavailable.");
    const folder =
      command.folder === undefined
        ? (checkout?.workingRoot ?? checkout?.root ?? projectRoot)
        : this.#folderRoot(authority.project, projectRoot, command.folder);
    const settled = this.#authority(windowId, command.projectId);
    if (folder === undefined)
      return refused("unavailable", "That folder is not one of this Project's folders.");
    if (
      settled.kind !== "allowed" ||
      settled.project.version !== authority.project.version ||
      checkout?.current() === false
    )
      return refused("authority-revoked", "This Project changed. Review its action again.");
    const receipt: ActionReceipt = {
      actionId: action.id,
      ...(command.workThreadId === undefined ? {} : { workThreadId: command.workThreadId }),
      name: action.name,
      folder: action.directory === "." ? folder : `${folder}/${action.directory}`,
      ...(checkout?.branch === undefined || folder !== checkout.root
        ? {}
        : { branch: checkout.branch }),
      ...(command.thread === undefined
        ? {}
        : {
            thread: {
              threadId: command.thread.threadId,
              checkoutId: command.thread.checkoutId,
              ...(checkout?.head === undefined ? {} : { head: checkout.head }),
            },
          }),
    };
    return {
      kind: "placed" as const,
      project: authority.project,
      action,
      checkout,
      folder,
      receipt,
    };
  }

  async #startAction(
    windowId: WindowId,
    command: Extract<ProjectTerminalCommand, { kind: "start-action" }>,
  ): Promise<ProjectTerminalResult> {
    const placed = await this.#placeAction(windowId, command);
    if (placed.kind === "project-terminal-refused") return placed;
    if (placed.kind === "placed-on-server")
      return this.#startServerAction(windowId, command, placed);
    if (
      placed.action.preparesWorktrees === true &&
      placed.checkout?.receiptId !== undefined &&
      command.folder === undefined
    )
      return refused(
        "unavailable",
        "Open Worktrees → Setup to run this recipe through its recorded preparation lifecycle.",
      );
    if (
      command.projectVersion !== undefined &&
      String(command.projectVersion) !== String(placed.project.version)
    )
      return refused("authority-revoked", "This action changed. Review it again.");
    return this.#start(windowId, { ...command, kind: "start" }, placed.action, placed);
  }

  async #start(
    windowId: WindowId,
    command: Extract<ProjectTerminalCommand, { readonly kind: "start" }>,
    action?: ProjectAction,
    placed?: {
      readonly checkout: ActionCheckout | undefined;
      readonly folder: string;
      readonly receipt: ActionReceipt;
    },
  ): Promise<ProjectTerminalResult> {
    const authority = this.#authority(windowId, command.projectId);
    if (authority.kind === "refused") return refused(authority.reason, authority.message);
    if (this.#owners.has(String(command.terminalId))) {
      return refused("unavailable", "This terminal id is already in use.");
    }
    if (authority.kind === "allowed-on-server")
      return this.#startOnServer(windowId, command, authority);
    const root = await this.#options.resolveRoot(authority.project);
    if (root === undefined) {
      return refused("unavailable", "This Project's folder is unavailable. Relink the Project.");
    }
    // The root was resolved across an await. A relink or archive in between
    // must not start a shell in a folder the Project no longer names.
    const settled = this.#authority(windowId, command.projectId);
    if (
      settled.kind !== "allowed" ||
      String(settled.bindingRevisionId) !== String(authority.bindingRevisionId)
    ) {
      return refused("authority-revoked", "This Project changed while its terminal was starting.");
    }
    const workThread =
      placed?.checkout ??
      (command.workThreadId === undefined
        ? undefined
        : await this.#options
            .resolveActionWorkThread?.(windowId, command.projectId, command.workThreadId)
            .catch(() => undefined));
    if (command.workThreadId !== undefined && (workThread === undefined || !workThread.current()))
      return refused(
        "unavailable",
        "This task's working folder is unavailable. Nothing was redirected.",
      );
    const folder =
      placed?.folder ??
      (command.folder === undefined && workThread !== undefined
        ? (workThread.workingRoot ?? workThread.root)
        : this.#folderRoot(authority.project, root, command.folder));
    if (folder === undefined) {
      return refused("unavailable", "That folder is not one of this Project's folders.");
    }
    // A Work Project's terminal is confined as a Code Project's is when the
    // Project remembers no Full access; Work Projects remember none.
    const posture: ProjectTerminalPosture =
      workThread !== undefined
        ? workThread.executionPolicy === "full-access"
          ? "full-access"
          : "approval-gated"
        : authority.project.type === "code" &&
            authority.project.codeAccessPersistence === "project-default"
          ? "full-access"
          : "approval-gated";
    if (action !== undefined) {
      try {
        this.#append(command.terminalId, 0, PROJECT_TERMINAL_EVENT_NAMES.started, {
          kind: "project-terminal-started",
          projectId: command.projectId,
          terminalId: command.terminalId,
          windowId,
          bindingRevisionId: authority.bindingRevisionId,
          posture,
          startedAt: this.#options.clock(),
          action: placed?.receipt,
        });
      } catch {
        return refused(
          "unavailable",
          "This action request was already recorded or could not be saved. Inspect its run before trying again.",
        );
      }
    }
    try {
      await this.#options.terminals.launch({
        terminalId: String(command.terminalId),
        ...(action === undefined
          ? workThread === undefined
            ? {}
            : { admit: () => workThread.current() }
          : {
              command: actionShellCommand(folder, action),
              admit: () => {
                const current = this.#authority(windowId, command.projectId);
                return (
                  current.kind === "allowed" &&
                  placed?.checkout?.current() !== false &&
                  String(current.bindingRevisionId) === String(authority.bindingRevisionId) &&
                  current.project.actions?.some(
                    (candidate) =>
                      candidate.id === action.id &&
                      candidate.command === action.command &&
                      candidate.directory === action.directory,
                  ) === true
                );
              },
            }),
        shell: this.#options.shell ?? defaultTerminalShell(),
        cwd: folder,
        // Every folder of the Project is bound like the main one, so the
        // shell can move between them; the pick only chooses where it starts.
        // One missing on disk is left out, as from a runtime's profile.
        extraFolders: [
          ...(command.workThreadId !== undefined
            ? [root, ...(workThread === undefined ? [] : [workThread.root])]
            : [workThread?.root ?? root]),
          ...projectExtraFolderRoots(authority.project).filter(isDirectory),
        ].filter((candidate) => candidate !== folder),
        // Its own shell history and state, apart from every thread's shells in
        // the same repository.
        stateScope: `project:${String(command.projectId)}`,
        columns: command.columns,
        rows: command.rows,
        credentialReferences: [],
        executionPolicy: workThread?.executionPolicy ?? posture,
      });
    } catch (error) {
      if (action !== undefined)
        this.#safeJournalEnded(command.projectId, command.terminalId, "stopped", undefined);
      console.warn(
        `Octant Project terminal could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
      // The person can fix a host without bubblewrap, so they get that reason;
      // any other confinement message may carry paths and stays in the log.
      return refused(
        "unavailable",
        error instanceof ProcessConfinementError && error.userFixable === "linux-bubblewrap-missing"
          ? LINUX_BUBBLEWRAP_MISSING_NOTICE
          : "The terminal could not start.",
      );
    }
    return this.#own(
      windowId,
      command,
      authority.bindingRevisionId,
      posture,
      placed?.receipt,
      action !== undefined,
      workThread?.active,
    );
  }

  /**
   * A server Project's shell: a login on its server, in its folder, through
   * the same connection rules as a thread terminal there. It carries nothing
   * of this host's (no credential, Browser grant, or other folder), and no
   * sandbox holds it on the server, which its posture says.
   */
  async #startOnServer(
    windowId: WindowId,
    command: Extract<ProjectTerminalCommand, { readonly kind: "start" }>,
    authority: Extract<Authority, { readonly kind: "allowed-on-server" }>,
  ): Promise<ProjectTerminalResult> {
    if (command.folder !== undefined) {
      return refused("unavailable", "That folder is not one of this Project's folders.");
    }
    const login = authority.server.login();
    if (login === undefined) {
      return refused(
        "unavailable",
        "This Project's server is not registered. Register it again in Settings › Access › Servers.",
      );
    }
    try {
      await this.#options.terminals.launch({
        terminalId: String(command.terminalId),
        // The server's own shell and folder; neither is opened on this host.
        shell: "/bin/sh",
        cwd: "/",
        stateScope: `project:${String(command.projectId)}`,
        columns: command.columns,
        rows: command.rows,
        credentialReferences: [],
        server: login,
      });
    } catch {
      return refused("unavailable", "The terminal could not start.");
    }
    return this.#own(windowId, command, authority.bindingRevisionId, "full-access");
  }

  async #startServerAction(
    windowId: WindowId,
    command: Extract<ProjectTerminalCommand, { kind: "start-action" }>,
    placed: ServerProjectActionPlacement,
  ): Promise<ProjectTerminalResult> {
    const server = placed.receipt.server;
    if (
      server === undefined ||
      command.projectVersion !== placed.projectVersion ||
      command.placementRevision !== server.placementRevision ||
      !placed.current()
    )
      return refused(
        "authority-revoked",
        "This server action's placement or authority changed. Review it again.",
      );
    if (this.#owners.has(String(command.terminalId)))
      return refused("unavailable", "This terminal id is already in use.");
    const current = () => {
      const authority = this.#authority(windowId, command.projectId);
      return (
        placed.current() &&
        authority.kind === "allowed-on-server" &&
        authority.bindingRevisionId === placed.bindingRevisionId
      );
    };
    try {
      this.#append(command.terminalId, 0, PROJECT_TERMINAL_EVENT_NAMES.started, {
        kind: "project-terminal-started",
        projectId: command.projectId,
        terminalId: command.terminalId,
        windowId,
        bindingRevisionId: placed.bindingRevisionId,
        posture: "full-access",
        startedAt: this.#options.clock(),
        action: placed.receipt,
      });
    } catch {
      return refused(
        "unavailable",
        "This action request was already recorded or could not be saved. Inspect its run before trying again.",
      );
    }
    try {
      await this.#options.terminals.launch({
        terminalId: String(command.terminalId),
        shell: "/bin/sh",
        cwd: "/",
        stateScope: `project:${String(command.projectId)}`,
        columns: command.columns,
        rows: command.rows,
        credentialReferences: [],
        server: placed.login,
        admit: current,
      });
    } catch {
      this.#safeJournalEnded(command.projectId, command.terminalId, "start-unconfirmed", undefined);
      return refused(
        "unavailable",
        "The server action's start could not be confirmed. Inspect this run and the server before preparing another; nothing was retried.",
      );
    }
    return this.#own(
      windowId,
      { ...command, kind: "start" },
      placed.bindingRevisionId,
      "full-access",
      placed.receipt,
      true,
      current,
    );
  }

  /** Records a launched shell and follows it until it ends. */
  async #own(
    windowId: WindowId,
    command: Extract<ProjectTerminalCommand, { readonly kind: "start" }>,
    bindingRevisionId: BindingRevisionId,
    posture: ProjectTerminalPosture,
    action?: ActionReceipt,
    recorded = false,
    actionAuthorized?: () => boolean,
  ): Promise<ProjectTerminalResult> {
    const owner: Owner = {
      terminalId: command.terminalId,
      windowId,
      projectId: command.projectId,
      bindingRevisionId,
      posture,
      stopObserving: undefined,
      ended: false,
      ...(action === undefined ? {} : { action }),
      ...(actionAuthorized === undefined ? {} : { actionAuthorized }),
    };
    try {
      if (!recorded)
        this.#append(command.terminalId, 0, PROJECT_TERMINAL_EVENT_NAMES.started, {
          kind: "project-terminal-started",
          projectId: command.projectId,
          terminalId: command.terminalId,
          windowId,
          bindingRevisionId,
          posture,
          startedAt: this.#options.clock(),
        });
    } catch {
      // A shell nobody can find in the journal is a shell nobody can account
      // for, so it does not keep running.
      await this.#options.terminals.terminate(String(command.terminalId)).catch(() => undefined);
      return refused("unavailable", "The terminal could not be recorded, so it was not started.");
    }
    this.#owners.set(String(command.terminalId), owner);
    owner.stopObserving = this.#options.terminals.observe(
      String(command.terminalId),
      (emission) => {
        if (emission.snapshot.status === "running" || owner.ended) return;
        owner.ended = true;
        if (owner.action?.server !== undefined && emission.snapshot.exitCode === 255)
          owner.uncertainty = "server-transport-lost";
        owner.stopObserving?.();
        this.#safeJournalEnded(
          command.projectId,
          command.terminalId,
          owner.uncertainty === "server-transport-lost" ? "transport-lost" : "exited",
          emission.snapshot.exitCode,
        );
      },
    );
    // A command can exit before its receipt is persisted. Terminal observers
    // start at the launch snapshot, so that already-exited snapshot has no
    // status delta to emit; settle it explicitly before returning the run.
    const snapshot = this.#options.terminals.readSince(String(command.terminalId), 0).snapshot;
    if (snapshot.status !== "running" && !owner.ended) {
      owner.ended = true;
      if (owner.action?.server !== undefined && snapshot.exitCode === 255)
        owner.uncertainty = "server-transport-lost";
      this.#safeJournalEnded(
        command.projectId,
        command.terminalId,
        owner.uncertainty === "server-transport-lost" ? "transport-lost" : "exited",
        snapshot.exitCode,
      );
    }
    if (owner.ended) owner.stopObserving?.();
    if (owner.actionAuthorized?.() === false && !owner.ended) {
      await this.#end(command.terminalId, owner, "authority-revoked");
      return refused("authority-revoked", "This task changed while its action was starting.");
    }
    // The launch awaited the process receipt, and an archive or relink that
    // committed meanwhile settled the Project before this shell had an owner
    // to find. Checked again now that it has one, so that end is not missed.
    const launched = this.#authority(windowId, command.projectId);
    if (
      launched.kind === "refused" ||
      String(launched.bindingRevisionId) !== String(bindingRevisionId)
    ) {
      await this.#end(command.terminalId, owner, "authority-revoked");
      return refused("authority-revoked", "This Project changed while its terminal was starting.");
    }
    return this.#view(command.terminalId, owner, 0);
  }

  #authority(windowId: WindowId, projectId: ProjectId): Authority {
    const project = this.#options.readProject(projectId);
    if (project === undefined) {
      const server = this.#options.serverProject?.(projectId);
      if (server !== undefined) {
        if (!this.#options.canAccessProject(windowId, projectId)) {
          return {
            kind: "refused",
            reason: "unauthorized",
            message: "Open this Project in this window to use its terminal.",
          };
        }
        return {
          kind: "allowed-on-server",
          server,
          bindingRevisionId: server.bindingRevisionId,
        };
      }
    }
    // Work shares Code's shell at the thread's level, so a Work Project has a
    // terminal too; whether a Work window shows it is the Project's Developer
    // tools switch, which is presentation and is not read here.
    if (project === undefined || (project.type !== "code" && project.type !== "work")) {
      return {
        kind: "refused",
        reason: "unavailable",
        message: "Only a Work or Code Project has a Project terminal.",
      };
    }
    if (project.lifecycle !== "active") {
      return {
        kind: "refused",
        reason: "authority-revoked",
        message: "This Project is archived, so its terminal ended.",
      };
    }
    // The window's own Code Project binding is checked, never a scope the
    // caller names, so a window cannot drive another Project's shell.
    if (!this.#options.canAccessProject(windowId, projectId)) {
      return {
        kind: "refused",
        reason: "unauthorized",
        message: "Open this Project in this window to use its terminal.",
      };
    }
    const revision = project.bindingHistory.at(-1);
    if (revision === undefined) {
      return {
        kind: "refused",
        reason: "unavailable",
        message: "This Project has no folder bound.",
      };
    }
    return { kind: "allowed", project, bindingRevisionId: revision.revisionId };
  }

  async #end(terminalId: CodeTerminalId, owner: Owner, reason: ProjectTerminalEndReason) {
    if (owner.ended) return;
    if (owner.action?.server !== undefined) owner.uncertainty = "server-stop-unconfirmed";
    owner.ended = true;
    owner.stopObserving?.();
    let snapshot: TerminalSnapshot | undefined;
    try {
      snapshot = await this.#options.terminals.terminate(String(terminalId));
    } catch {
      snapshot = undefined;
    }
    this.#safeJournalEnded(
      owner.projectId,
      terminalId,
      owner.uncertainty === "server-stop-unconfirmed" ? "server-stop-unconfirmed" : reason,
      snapshot?.exitCode,
    );
  }

  #safeJournalEnded(
    projectId: ProjectId,
    terminalId: CodeTerminalId,
    reason: ProjectTerminalEndReason,
    exitCode: number | undefined,
  ): void {
    try {
      this.#journalEnded(projectId, terminalId, reason, exitCode);
    } catch {
      // The shell has ended either way. A running record left behind is ended
      // as host-restarted on the next start, which is the truth by then.
    }
  }

  #journalEnded(
    projectId: ProjectId,
    terminalId: CodeTerminalId,
    reason: ProjectTerminalEndReason,
    exitCode: number | undefined,
  ): void {
    this.#append(terminalId, 1, PROJECT_TERMINAL_EVENT_NAMES.ended, {
      kind: "project-terminal-ended",
      projectId,
      terminalId,
      reason,
      ...(exitCode === undefined ? {} : { exitCode }),
      endedAt: this.#options.clock(),
    });
  }

  #append(
    terminalId: CodeTerminalId,
    expectedVersion: number,
    eventName: string,
    payload: unknown,
  ): void {
    const decoded =
      eventName === PROJECT_TERMINAL_EVENT_NAMES.started
        ? decodeProjectTerminalStarted(payload)
        : decodeProjectTerminalEnded(payload);
    this.#options.journal.append({
      aggregate: {
        aggregateType: PROJECT_TERMINAL_AGGREGATE,
        aggregateId: decodeAggregateId(String(terminalId)),
      },
      expectedVersion: decodeAggregateVersion(expectedVersion),
      events: [
        {
          eventId: decodeEventId(this.#options.uuid()),
          eventName: decodeEventName(eventName),
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#options.uuid()),
          actor: this.#actor,
          occurredAt: decodeTimestamp(this.#options.clock()),
          payload: decoded,
        },
      ],
    });
  }

  #view(terminalId: CodeTerminalId, owner: Owner, afterCharacters?: number): ProjectTerminalResult {
    const read = this.#options.terminals.readSince(String(terminalId), afterCharacters ?? 0);
    const snapshot = read.snapshot;
    return decodeProjectTerminalResult({
      kind: "project-terminal",
      terminal: {
        projectId: owner.projectId,
        terminalId,
        state: owner.uncertainty === undefined ? snapshot.status : "interrupted",
        ...(owner.uncertainty === undefined ? {} : { uncertainty: owner.uncertainty }),
        ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
        posture: owner.posture,
        ...(owner.action === undefined ? {} : { action: owner.action }),
      },
      ...(afterCharacters === undefined
        ? {}
        : {
            output: { text: read.text, replace: read.replace, characters: read.characters },
          }),
    });
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function refused(
  reason: ProjectTerminalRefusalReason,
  message: string,
): Extract<ProjectTerminalResult, { kind: "project-terminal-refused" }> {
  return { kind: "project-terminal-refused", reason, message };
}

function actionShellCommand(folder: string, action: ProjectAction): string {
  const directory = action.directory === "." ? folder : `${folder}/${action.directory}`;
  return `cd '${directory.replaceAll("'", "'\\''")}' && { ${action.command}\n}`;
}
