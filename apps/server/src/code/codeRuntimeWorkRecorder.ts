import {
  decodeCodeRuntimeWork,
  type CodeRuntimeWork,
  type CodeRuntimeWorkKind,
  type CodeRuntimeWorkState,
  type CodeOperationCommand,
  type CodeOperationResult,
  type CodeThreadId,
  type EventActor,
} from "@octant/contracts";
import type { Journal } from "../persistence/journal";

export const CODE_RUNTIME_WORK_UPDATED = "code.runtime-work-updated@1";
const CODE_RUNTIME_AGGREGATE_TYPE = "code-runtime";

type JournalPort = Pick<Journal, "append">;

export interface CodeRuntimeWorkRecorderOptions {
  readonly journal: JournalPort;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly actor: typeof EventActor.Type;
}

/**
 * The id of the unit of work itself — a provider turn's operation id, a
 * terminal id, a test-run id, a Git operation id. A runtime work record is that
 * unit seen from the board, so it carries the unit's own identity rather than a
 * second one nothing else can join on.
 */
export type CodeRuntimeWorkUnitId = string;

/**
 * Appends one `code.runtime-work-updated@1` record per unit of runtime work, so
 * the Code board can tell what a thread is doing and what it owes the person
 * looking at it.
 *
 * A record opens `running` when the work starts and closes on its terminal
 * state; nothing else writes to it afterwards. The unit's own id is the
 * aggregate id, which is what lets a later state land on the record its work
 * opened rather than on a fresh row.
 *
 * Aggregate versions are counted in memory because this process is the only
 * writer while the work is live. After a restart the work is no longer live:
 * `reconcileCodeRestart` reads the projected version instead, and this recorder
 * never touches the record again.
 */
export class CodeRuntimeWorkRecorder {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #actor: typeof EventActor.Type;
  readonly #open = new Map<
    string,
    { readonly version: number; readonly state: CodeRuntimeWorkState }
  >();

  constructor(options: CodeRuntimeWorkRecorderOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#actor = options.actor;
  }

  /** Open a record for work that has started. */
  open(input: {
    readonly id: CodeRuntimeWorkUnitId;
    readonly threadId: CodeThreadId;
    readonly kind: CodeRuntimeWorkKind;
  }): void {
    this.#record(input.id, input.threadId, input.kind, "running");
  }

  /**
   * Move an already-open record to a new state. A terminal state closes the
   * record and releases its version, so a unit id that is never reused cannot
   * grow this map without bound.
   *
   * Settling a record this recorder never opened is a no-op: the work either
   * belongs to a different host process or was never observed starting, and
   * inventing an opening event for it would report work that did not run.
   */
  settle(input: {
    readonly id: CodeRuntimeWorkUnitId;
    readonly threadId: CodeThreadId;
    readonly kind: CodeRuntimeWorkKind;
    readonly state: CodeRuntimeWorkState;
  }): void {
    if (!this.#open.has(input.id)) return;
    this.#record(input.id, input.threadId, input.kind, input.state);
    if (input.state !== "running" && input.state !== "waiting") this.#open.delete(input.id);
  }

  /** Whether this recorder currently owns an open record for the unit. */
  owns(id: CodeRuntimeWorkUnitId): boolean {
    return this.#open.has(id);
  }

  #record(
    id: CodeRuntimeWorkUnitId,
    threadId: CodeThreadId,
    kind: CodeRuntimeWorkKind,
    state: CodeRuntimeWorkState,
  ): void {
    const current = this.#open.get(id);
    // One record per state change. A turn that reports `running` again after it
    // was opened has not moved, and a row saying so would push its work past
    // work that actually finished in between.
    if (current?.state === state) return;
    const expectedVersion = current?.version ?? 0;
    let work: CodeRuntimeWork;
    try {
      work = decodeCodeRuntimeWork({ id, threadId, kind, state, updatedAt: this.#clock() });
    } catch {
      // A unit id that is not a work identity is a wiring mistake, not a
      // runtime condition. The work itself still ran, so the operation keeps
      // its own result rather than failing on its board record.
      return;
    }
    try {
      this.#journal.append({
        aggregate: { aggregateType: CODE_RUNTIME_AGGREGATE_TYPE, aggregateId: work.id },
        expectedVersion,
        events: [
          {
            eventId: this.#uuid(),
            eventName: CODE_RUNTIME_WORK_UPDATED,
            eventVersion: 1,
            correlationId: this.#uuid(),
            actor: this.#actor,
            occurredAt: work.updatedAt,
            payload: { kind: "runtime-work-updated", work },
          },
        ],
      });
    } catch {
      // The work itself is not this record. A push that ran must report what it
      // did even on a host whose journal refused the board's view of it, and
      // the record stays unopened so nothing later settles a row that is not
      // there.
      return;
    }
    this.#open.set(id, { version: expectedVersion + 1, state });
  }
}

/**
 * The unit of runtime work a command starts, or `undefined` when it starts
 * none.
 *
 * A unit is recorded when it can outlive the call that started it or reaches
 * past the checkout — a shell process, a test process, a mutation of the
 * repository, a pull request on GitHub. Reads (`observe-git`,
 * `observe-pull-request`, `review-run`), index-only edits (`stage-git`,
 * `unstage-git`), drafts, and scaffolds are not: they resolve inside the call,
 * leave nothing running, and are fully re-observable afterwards, so a board
 * record for them could only ever say "already finished".
 *
 * The `file` and `review` kinds are deliberately never started here. A file
 * write already has a durable record with a `saving` lifecycle and its own
 * restart reconciliation (`code.file-reference-updated@1`), and a review
 * finding has `code.review-finding-updated@1`; a second record would report the
 * same unfinished work twice and let one of the two waits clear while the
 * other did not.
 */
export function codeRuntimeWorkStarted(
  command: CodeOperationCommand,
): { readonly id: CodeRuntimeWorkUnitId; readonly kind: CodeRuntimeWorkKind } | undefined {
  switch (command.kind) {
    case "start-terminal":
      return { id: String(command.terminalId), kind: "terminal" };
    case "run-repository-test":
      return { id: String(command.testRunId), kind: "test" };
    case "commit-git":
    case "push-git":
    case "discard-git-changes":
    case "restore-git-checkpoint":
    case "merge-run":
      return { id: String(command.gitOperationId), kind: "git" };
    case "create-pull-request":
      return { id: String(command.operationId), kind: "delivery" };
    default:
      return undefined;
  }
}

/**
 * The unit of runtime work a command reports on without starting it: a later
 * read or stop of a terminal that is already open, or a cancel of a running
 * test. These carry the outcome that closes a record — a shell that exited on
 * its own is only ever learned from the next command that looks at it.
 */
export function codeRuntimeWorkObserved(
  command: CodeOperationCommand,
): { readonly id: CodeRuntimeWorkUnitId; readonly kind: CodeRuntimeWorkKind } | undefined {
  switch (command.kind) {
    case "attach-terminal":
    case "write-terminal":
    case "resize-terminal":
    case "stop-terminal":
      return { id: String(command.terminalId), kind: "terminal" };
    case "cancel-repository-test":
      return { id: String(command.testRunId), kind: "test" };
    default:
      return codeRuntimeWorkStarted(command);
  }
}

/**
 * The state a result leaves its unit of work in, or `undefined` when the result
 * says nothing new — a terminal or test still running keeps the record it
 * already has rather than restating it.
 *
 * `waiting` is a decision the host is owed before the work may run.
 * `ambiguous` is reserved for an outcome the host genuinely could not
 * establish, and only the two units that reach the network can produce one: a
 * push and a pull request may have landed on the remote even though this host
 * never learned that they did. Everything else resolves inside the checkout,
 * where "it did not work" is a fact rather than a question, and closes `failed`.
 */
export function codeRuntimeWorkStateFrom(
  command: CodeOperationCommand,
  result: CodeOperationResult,
): CodeRuntimeWorkState | undefined {
  switch (result.kind) {
    case "terminal-state":
      switch (result.state) {
        case "running":
          return undefined;
        case "exited":
          return "completed";
        case "interrupted":
          return "interrupted";
        default:
          return "failed";
      }
    case "repository-test-state":
      switch (result.state) {
        case "running":
          return undefined;
        case "completed":
          // A failing suite is a run that finished. Its verdict is evidence the
          // thread carries elsewhere; it is not work still owed to anyone.
          return "completed";
        case "interrupted":
          return "interrupted";
        default:
          return "failed";
      }
    case "git-mutation-state":
      // A rejection is Git declining to move: the checkout is untouched and the
      // caller was told exactly why, so nothing is left unresolved.
      return result.state === "completed" ? "completed" : "failed";
    case "pull-request-state":
      switch (result.state) {
        case "unavailable":
          return "ambiguous";
        case "failed":
          return "failed";
        default:
          return "completed";
      }
    case "operation-failed":
      // `waiting` is the host refusing until someone approves the effect. The
      // operation's own state event says the same thing, and the person is
      // owed a decision until they give one — an approved retry carries the
      // same unit id, so it continues this record rather than opening another.
      if (result.failure.category === "waiting") return "waiting";
      return reachesNetwork(command) && result.failure.category === "unavailable"
        ? "ambiguous"
        : "failed";
    default:
      return "failed";
  }
}

function reachesNetwork(command: CodeOperationCommand): boolean {
  return command.kind === "push-git" || command.kind === "create-pull-request";
}
