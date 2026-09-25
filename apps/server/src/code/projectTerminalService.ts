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
  type CodeProject,
  type CodeTerminalId,
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
import type { Journal } from "../persistence/journal";
import type { TerminalService, TerminalSnapshot } from "./terminalService";

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

export interface ProjectTerminalServiceOptions {
  readonly terminals: Pick<
    TerminalService,
    "launch" | "observe" | "readSince" | "write" | "resize" | "terminate"
  >;
  readonly readProject: (projectId: ProjectId) => Project | undefined;
  /** The window's own Code Project binding; see `windowCanAccessCodeProject`. */
  readonly canAccessProject: (windowId: WindowId, projectId: ProjectId) => boolean;
  /**
   * The Project's bound root as the host verifies it now, or undefined when the
   * folder is gone, moved, or no longer the one the binding names.
   */
  readonly resolveRoot: (project: CodeProject) => Promise<string | undefined>;
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
}

type Authority =
  | {
      readonly kind: "allowed";
      readonly project: CodeProject;
      readonly bindingRevisionId: BindingRevisionId;
    }
  | {
      readonly kind: "refused";
      readonly reason: ProjectTerminalRefusalReason;
      readonly message: string;
    };

/**
 * Terminals a person opens for a Code Project without a thread.
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
      return refused("unauthorized", "Project terminals open only from this Mac's own window.");
    }
    if (command.kind === "start") return this.#start(windowId, command);

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
      }
    } catch {
      return refused("unavailable", "This terminal is no longer running.");
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
      this.#authority(windowId, projectId).kind === "allowed"
    );
  }

  /**
   * End every running terminal of a Project that is no longer what its shells
   * were opened against: archived, or relinked to another root. Called when
   * the journal commits a Project lifecycle or binding change, so a shell does
   * not keep running in a folder the Project no longer names.
   */
  async settleProject(projectId: ProjectId): Promise<void> {
    const project = this.#options.readProject(projectId);
    const current =
      project?.type === "code" && project.lifecycle === "active"
        ? project.bindingHistory.at(-1)?.revisionId
        : undefined;
    const ending: Array<Promise<void>> = [];
    for (const owner of this.#owners.values()) {
      if (owner.ended || String(owner.projectId) !== String(projectId)) continue;
      if (current !== undefined && String(current) === String(owner.bindingRevisionId)) continue;
      ending.push(this.#end(owner.terminalId, owner, "authority-revoked"));
    }
    await Promise.allSettled(ending);
  }

  async #start(
    windowId: WindowId,
    command: Extract<ProjectTerminalCommand, { readonly kind: "start" }>,
  ): Promise<ProjectTerminalResult> {
    const authority = this.#authority(windowId, command.projectId);
    if (authority.kind === "refused") return refused(authority.reason, authority.message);
    if (this.#owners.has(String(command.terminalId))) {
      return refused("unavailable", "This terminal id is already in use.");
    }
    const root = await this.#options.resolveRoot(authority.project);
    if (root === undefined) {
      return refused("unavailable", "This Project's folder is unavailable. Relink the Project.");
    }
    // The root was resolved across an await. A relink or archive in between
    // must not start a shell in a folder the Project no longer names.
    const settled = this.#authority(windowId, command.projectId);
    if (
      settled.kind === "refused" ||
      String(settled.bindingRevisionId) !== String(authority.bindingRevisionId)
    ) {
      return refused("authority-revoked", "This Project changed while its terminal was starting.");
    }
    const posture: ProjectTerminalPosture =
      authority.project.codeAccessPersistence === "project-default"
        ? "full-access"
        : "approval-gated";
    try {
      await this.#options.terminals.launch({
        terminalId: String(command.terminalId),
        shell: this.#options.shell ?? "/bin/zsh",
        cwd: root,
        // Its own shell history and state, apart from every thread's shells in
        // the same repository.
        stateScope: `project:${String(command.projectId)}`,
        columns: command.columns,
        rows: command.rows,
        credentialReferences: [],
        executionPolicy: posture,
      });
    } catch {
      return refused("unavailable", "The terminal could not start.");
    }
    const owner: Owner = {
      terminalId: command.terminalId,
      windowId,
      projectId: command.projectId,
      bindingRevisionId: authority.bindingRevisionId,
      posture,
      stopObserving: undefined,
      ended: false,
    };
    try {
      this.#append(command.terminalId, 0, PROJECT_TERMINAL_EVENT_NAMES.started, {
        kind: "project-terminal-started",
        projectId: command.projectId,
        terminalId: command.terminalId,
        windowId,
        bindingRevisionId: authority.bindingRevisionId,
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
        owner.stopObserving?.();
        this.#safeJournalEnded(
          command.projectId,
          command.terminalId,
          "exited",
          emission.snapshot.exitCode,
        );
      },
    );
    return this.#view(command.terminalId, owner, 0);
  }

  #authority(windowId: WindowId, projectId: ProjectId): Authority {
    const project = this.#options.readProject(projectId);
    if (project === undefined || project.type !== "code") {
      return {
        kind: "refused",
        reason: "unavailable",
        message: "Only a Code Project has a Project terminal.",
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
    owner.ended = true;
    owner.stopObserving?.();
    let snapshot: TerminalSnapshot | undefined;
    try {
      snapshot = await this.#options.terminals.terminate(String(terminalId));
    } catch {
      snapshot = undefined;
    }
    this.#safeJournalEnded(owner.projectId, terminalId, reason, snapshot?.exitCode);
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
        state: snapshot.status,
        ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
        posture: owner.posture,
      },
      ...(afterCharacters === undefined
        ? {}
        : {
            output: { text: read.text, replace: read.replace, characters: read.characters },
          }),
    });
  }
}

function refused(reason: ProjectTerminalRefusalReason, message: string): ProjectTerminalResult {
  return { kind: "project-terminal-refused", reason, message };
}
