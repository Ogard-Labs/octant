import {
  decodeCodeRuntimeWork,
  decodeCodeRuntimeWorkId,
  type CodeRuntimeWork,
  type CodeRuntimeWorkKind,
  type CodeRuntimeWorkState,
  type CodeOperationCommand,
  type CodeOperationResult,
  type CodeOperationId,
  type CodeTerminalId,
  type CodeTestRunId,
  type CodeGitOperationId,
  type CodeThreadId,
  type EventActor,
} from "@octant/contracts";
import type { Journal } from "../persistence/journal";

export const CODE_RUNTIME_WORK_UPDATED = "code.runtime-work-updated@1";
const CODE_RUNTIME_AGGREGATE_TYPE = "code-runtime";

type JournalPort = {
  readonly append: (...args: Parameters<Journal["append"]>) => unknown;
};

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
export type CodeRuntimeWorkUnitId =
  | CodeOperationId
  | CodeTerminalId
  | CodeTestRunId
  | CodeGitOperationId;

export type CodeRuntimeWorkRecordFailureKind = "invalid-runtime-work" | "journal-unavailable";

export type CodeRuntimeWorkRecordOutcome =
  | { readonly status: "recorded" }
  | { readonly status: "unchanged" }
  | { readonly status: "not-owned" }
  | { readonly status: "failed"; readonly kind: CodeRuntimeWorkRecordFailureKind };

export type CodeRuntimeWorkRecordFailure = Extract<
  CodeRuntimeWorkRecordOutcome,
  { readonly status: "failed" }
>;

export interface CodeRuntimeWorkPlan {
  readonly id: CodeRuntimeWorkUnitId;
  readonly kind: CodeRuntimeWorkKind;
  readonly starts: boolean;
  readonly reachesNetwork: boolean;
}

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
    CodeRuntimeWorkUnitId,
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
  }): CodeRuntimeWorkRecordOutcome {
    return this.#record(input.id, input.threadId, input.kind, "running");
  }

  /**
   * Move an already-open record to a new state. A terminal state closes the
   * record and releases its version, so a unit id that is never reused cannot
   * grow this map without bound.
   *
   * Settling a record this recorder never opened returns `not-owned`: the work
   * either belongs to a different host process or was never observed starting,
   * and inventing an opening event for it would report work that did not run.
   */
  settle(input: {
    readonly id: CodeRuntimeWorkUnitId;
    readonly threadId: CodeThreadId;
    readonly kind: CodeRuntimeWorkKind;
    readonly state: CodeRuntimeWorkState;
  }): CodeRuntimeWorkRecordOutcome {
    if (!this.#open.has(input.id)) return { status: "not-owned" };
    const outcome = this.#record(input.id, input.threadId, input.kind, input.state);
    if (outcome.status === "recorded" && input.state !== "running" && input.state !== "waiting")
      this.#open.delete(input.id);
    return outcome;
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
  ): CodeRuntimeWorkRecordOutcome {
    const current = this.#open.get(id);
    // One record per state change. A turn that reports `running` again after it
    // was opened has not moved, and a row saying so would push its work past
    // work that actually finished in between.
    if (current?.state === state) return { status: "unchanged" };
    const expectedVersion = current?.version ?? 0;
    let work: CodeRuntimeWork;
    try {
      work = decodeCodeRuntimeWork({
        id: decodeCodeRuntimeWorkId(String(id)),
        threadId,
        kind,
        state,
        updatedAt: this.#clock(),
      });
    } catch {
      // A unit id that is not a work identity is a wiring mistake, not a
      // runtime condition. The work itself still ran, so the operation keeps
      // its own result rather than failing on its board record.
      return { status: "failed", kind: "invalid-runtime-work" };
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
      return { status: "failed", kind: "journal-unavailable" };
    }
    this.#open.set(id, { version: expectedVersion + 1, state });
    return { status: "recorded" };
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
  const plan = codeRuntimeWorkPlan(command);
  return plan?.starts === true ? { id: plan.id, kind: plan.kind } : undefined;
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
  const plan = codeRuntimeWorkPlan(command);
  return plan === undefined ? undefined : { id: plan.id, kind: plan.kind };
}

/**
 * Classifies every command that can open or observe a runtime work record.
 * Keeping identity, lifecycle role, and network reach in one plan means the
 * recorder and state mapping cannot drift into different command switches.
 */
export function codeRuntimeWorkPlan(
  command: CodeOperationCommand,
): CodeRuntimeWorkPlan | undefined {
  switch (command.kind) {
    case "start-terminal":
      return { id: command.terminalId, kind: "terminal", starts: true, reachesNetwork: false };
    case "attach-terminal":
    case "write-terminal":
    case "resize-terminal":
    case "stop-terminal":
      return { id: command.terminalId, kind: "terminal", starts: false, reachesNetwork: false };
    case "run-repository-test":
      return { id: command.testRunId, kind: "test", starts: true, reachesNetwork: false };
    case "cancel-repository-test":
      return { id: command.testRunId, kind: "test", starts: false, reachesNetwork: false };
    case "commit-git":
    case "push-git":
    case "discard-git-changes":
    case "restore-git-checkpoint":
    case "merge-run":
      return {
        id: command.gitOperationId,
        kind: "git",
        starts: true,
        reachesNetwork: command.kind === "push-git",
      };
    case "create-pull-request":
      return { id: command.operationId, kind: "delivery", starts: true, reachesNetwork: true };
    default:
      return undefined;
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
      return codeRuntimeWorkPlan(command)?.reachesNetwork === true &&
        result.failure.category === "unavailable"
        ? "ambiguous"
        : "failed";
    default:
      return "failed";
  }
}
