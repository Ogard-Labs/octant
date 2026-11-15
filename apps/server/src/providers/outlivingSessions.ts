import type { ProviderFailure, ProviderSessionId } from "@octant/contracts";
import type {
  ProviderBackgroundTask,
  ProviderBackgroundWork,
  ProviderConnection,
  ProviderSessionHandle,
  ProviderSessionResume,
  ProviderSessionStart,
} from "@octant/provider-sdk/driver";
import { Effect, Exit, Scope } from "effect";

/**
 * Keeps a thread's provider session past the turn that opened it while its
 * runtime still runs background work (maintainer decision, 2026-11-14). A
 * turn completes when the model's reply is done; a dev server or a watch the
 * turn started keeps running and shows as a live task in the thread. When
 * the runtime starts a turn by itself afterwards (a task ended, a watch
 * reported), the host opens a runtime-started turn for the thread, which
 * reattaches to the same session.
 *
 * The session is always stopped, never orphaned: when its last task has
 * ended and no turn runs, when the person stops the thread, when it has sat
 * past the idle limit, when the host cannot open a turn for the runtime's
 * own, when the next turn needs a session started differently (another
 * level, model, or tool set), and at shutdown. A connection whose runtime
 * keeps no background work past a turn is stopped at turn end, as before.
 */

/** Opens the runtime-started turn for a thread; `busy` asks again shortly. */
export type RuntimeTurnStarter = (
  key: string,
) => Promise<
  | { readonly status: "started" }
  | { readonly status: "busy" }
  | { readonly status: "refused"; readonly message: string }
>;

export interface OutlivingSessionsOptions {
  /** Read whenever a session is left with only background work; null keeps it until another bound. */
  readonly idleLimitMs: () => number | null;
  readonly startRuntimeTurn: RuntimeTurnStarter;
  /** Told whenever a thread's live tasks change, so its view refreshes. */
  readonly onChanged?: (key: string) => void;
  readonly onError?: (message: string, error: unknown) => void;
  /** How long to wait before asking again when the thread was busy. */
  readonly busyRetryMs?: number;
  /**
   * The terms a thread's session would be started on now (its level, model,
   * checkout, lifecycle), or undefined when the thread can run no turn. A
   * kept session started on other terms is stopped: the person changed the
   * thread, and the session would otherwise go on acting as it was before.
   */
  readonly currentTerms?: (key: string) => string | undefined;
  /**
   * How long a session whose last task just ended waits for the runtime's
   * own follow-up turn before it is stopped as idle.
   */
  readonly taskEndGraceMs?: number;
  /** How long an opened runtime turn may take to take up the session. */
  readonly leaseDeadlineMs?: number;
}

/** What a thread's live tasks look like to the person. */
export interface LiveTasks {
  readonly tasks: ReadonlyArray<ProviderBackgroundTask>;
  /** A turn holds the session now (the person's, or one the runtime started). */
  readonly turnRunning: boolean;
}

const BUSY_RETRIES = 20;
/**
 * A task's end reaches the host before the runtime reports the turn it
 * starts for it, so a session left with no task is given this long to start
 * one before it counts as idle.
 */
const TASK_END_GRACE_MS = 5_000;
/**
 * A runtime turn the host opened that has not taken up the session by then
 * never will (it failed or was refused before reaching the provider), and
 * the session would otherwise wait for the idle limit, or forever with none.
 */
const LEASE_DEADLINE_MS = 60_000;

interface Kept {
  readonly key: string;
  readonly connection: ProviderConnection;
  readonly scope: Scope.CloseableScope;
  /** The folder, folders, and permission setting the connection was acquired for. */
  readonly acquiredFor: string;
  /** The thread's terms (see {@link OutlivingSessionsOptions.currentTerms}) its last turn ran on. */
  terms?: string | undefined;
  session?:
    | {
        readonly sessionId: ProviderSessionId;
        readonly handle: ProviderSessionHandle;
        /** How the session was started; a turn needing anything else starts another. */
        readonly startedAs: string;
        unwatch?: () => void;
      }
    | undefined;
  work?: ProviderBackgroundWork | undefined;
  /** A host turn reads the connection now. */
  leased: boolean;
  idleTimer?: ReturnType<typeof setTimeout> | undefined;
  /** Stops the session if no runtime turn starts after its last task ended. */
  graceTimer?: ReturnType<typeof setTimeout> | undefined;
  /** Stops the session if the runtime turn the host opened never takes it up. */
  leaseTimer?: ReturnType<typeof setTimeout> | undefined;
  runtimeTurnRequested: boolean;
  disposed?: Promise<void>;
}

export class OutlivingSessions {
  readonly #kept = new Map<string, Kept>();
  /** Sessions taken out of `#kept` that are still stopping, by thread. */
  readonly #closing = new Map<string, Promise<void>>();
  readonly #options: OutlivingSessionsOptions;
  #closed = false;

  constructor(options: OutlivingSessionsOptions) {
    this.#options = options;
  }

  /**
   * The connection a thread's turn uses: the one its kept session lives on,
   * or a new one from `open`. The connection belongs to this keeper, not to
   * the turn's scope; the turn's `stop` decides whether it is kept, and a
   * turn whose scope closes while it still holds the connection stops it.
   */
  acquire<R>(
    key: string,
    acquiredFor: string,
    open: Effect.Effect<ProviderConnection, ProviderFailure, R | Scope.Scope>,
    terms?: string,
  ): Effect.Effect<ProviderConnection, ProviderFailure, Exclude<R, Scope.Scope> | Scope.Scope> {
    return Effect.gen(this, function* () {
      if (this.#closed) {
        return yield* Effect.fail<ProviderFailure>({
          category: "unavailable",
          message: "The host is shutting down.",
        });
      }
      // A session of this thread still stopping holds its native history.
      yield* Effect.promise(() => this.#closingSettled(key));
      if (this.#closed) {
        return yield* Effect.fail<ProviderFailure>({
          category: "unavailable",
          message: "The host is shutting down.",
        });
      }
      const existing = this.#kept.get(key);
      if (existing !== undefined && existing.leased) {
        return yield* Effect.fail<ProviderFailure>({
          category: "unavailable",
          message: "Another turn of this thread holds its provider session.",
        });
      }
      let kept = existing;
      if (kept !== undefined && kept.acquiredFor !== acquiredFor) {
        yield* Effect.promise(() => this.#dispose(existing as Kept));
        kept = undefined;
      }
      if (kept === undefined) {
        const scope = yield* Scope.make();
        const connection = yield* Scope.extend(open, scope).pipe(
          Effect.tapError(() => Scope.close(scope, Exit.void)),
        ) as Effect.Effect<ProviderConnection, ProviderFailure, Exclude<R, Scope.Scope>>;
        kept = { key, connection, scope, acquiredFor, leased: false, runtimeTurnRequested: false };
        this.#kept.set(key, kept);
      }
      const leased = kept;
      leased.terms = terms;
      this.#lease(leased);
      // A turn that ends without settling the session (a failure before its
      // stop, an interruption) never leaves it running unseen.
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          if (leased.leased) await this.#dispose(leased);
        }),
      );
      return this.#leasedConnection(leased);
    });
  }

  /** The live tasks a thread's kept session runs, or undefined when none is kept. */
  liveTasks(key: string): LiveTasks | undefined {
    const kept = this.#kept.get(key);
    if (kept === undefined || kept.work === undefined || kept.work.ended) return undefined;
    if (kept.work.tasks.length === 0 && !kept.leased) return undefined;
    return { tasks: kept.work.tasks, turnRunning: kept.leased || kept.work.turnRunning };
  }

  /**
   * The person stopped the thread with no turn running: its kept session,
   * and every background task in it, is stopped. Answers whether one was.
   */
  async stopThread(key: string): Promise<boolean> {
    const kept = this.#kept.get(key);
    // A session already stopping is waited for, so a Stop answers only once
    // the runtime and its tasks are gone.
    if (kept === undefined) return this.#closingSettled(key);
    if (kept.leased) return false;
    await this.#dispose(kept);
    return true;
  }

  /**
   * The thread changed: its kept session is stopped when the thread would now
   * start one on other terms (another level, model, checkout) or can run no
   * turn (archived, moved, deleted). A turn holding the session settles it
   * when it ends. Answers whether one was stopped.
   *
   * `committed` carries the thread's terms as the change that was just
   * journaled states them. A caller whose own read of the thread is applied
   * only after the journal tells its listeners passes them, so the check
   * never reads the thread as it was before.
   */
  async stopThreadIfChanged(
    key: string,
    committed?: { readonly terms: string | undefined },
  ): Promise<boolean> {
    const kept = this.#kept.get(key);
    if (kept === undefined || kept.leased) return false;
    const current =
      committed === undefined
        ? this.#termsCurrent(kept)
        : committed.terms !== undefined && committed.terms === kept.terms;
    if (current) return false;
    await this.#dispose(kept);
    return true;
  }

  /** The keys of the threads whose session is kept now. */
  keptKeys(): ReadonlyArray<string> {
    return [...this.#kept.keys()];
  }

  /** Stops every kept session; nothing is kept after it. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#kept.values()].map((kept) => this.#dispose(kept)));
    // A session already stopping (an idle limit, a Stop) has left `#kept`;
    // shutdown is not done until its runtime and tasks are gone too.
    await Promise.all([...this.#closing.values()].map((closing) => closing.catch(() => undefined)));
  }

  #lease(kept: Kept): void {
    kept.leased = true;
    kept.runtimeTurnRequested = false;
    clearTimers(kept);
  }

  #termsCurrent(kept: Kept): boolean {
    const current = this.#options.currentTerms;
    if (current === undefined) return true;
    const terms = current(kept.key);
    return terms !== undefined && terms === kept.terms;
  }

  #leasedConnection(kept: Kept): ProviderConnection {
    const { connection } = kept;
    const begin = (
      input: ProviderSessionStart | ProviderSessionResume,
      opened: (
        withOutlive: ProviderSessionStart | ProviderSessionResume,
      ) => Effect.Effect<ProviderSessionHandle, ProviderFailure>,
    ) =>
      Effect.gen(this, function* () {
        const startedAs = sessionShape(input);
        const live = kept.session;
        if (
          live !== undefined &&
          String(live.sessionId) === String(input.sessionId) &&
          live.startedAs === startedAs &&
          kept.work !== undefined &&
          !kept.work.ended
        ) {
          return live.handle;
        }
        // The next turn needs a session started differently, so the kept one
        // and its background work stop first: a level change applies from
        // the next session, never inside a running one.
        if (live !== undefined) yield* Effect.promise(() => this.#stopSession(kept));
        const handle = yield* opened({ ...input, outlivesTurn: true });
        const watched = connection.backgroundWork?.(handle.sessionId);
        kept.session = { sessionId: handle.sessionId, handle, startedAs };
        if (watched !== undefined) {
          kept.work = watched.current();
          kept.session.unwatch = watched.watch((work) => this.#observe(kept, work));
        } else {
          kept.work = undefined;
        }
        return handle;
      });
    return {
      ...connection,
      start: (input) => begin(input, (next) => connection.start(next as ProviderSessionStart)),
      resume: (input) => begin(input, (next) => connection.resume(next as ProviderSessionResume)),
      stop: (sessionId) =>
        Effect.promise(async () => {
          if (this.#keepsPastTurn(kept, sessionId)) {
            kept.leased = false;
            this.#armIdleLimit(kept);
            // A task may have ended, or the runtime started its own turn,
            // while the turn was settling.
            if (kept.work !== undefined) this.#observe(kept, kept.work);
            return;
          }
          await this.#dispose(kept);
        }),
    };
  }

  #keepsPastTurn(kept: Kept, sessionId: ProviderSessionId): boolean {
    const work = kept.work;
    return (
      !this.#closed &&
      this.#termsCurrent(kept) &&
      kept.session !== undefined &&
      String(kept.session.sessionId) === String(sessionId) &&
      work !== undefined &&
      !work.ended &&
      (work.tasks.length > 0 || work.runtimeTurnWaiting)
    );
  }

  #observe(kept: Kept, work: ProviderBackgroundWork): void {
    if (this.#kept.get(kept.key) !== kept) return;
    const taskEnded = (kept.work?.tasks.length ?? 0) > work.tasks.length;
    kept.work = work;
    this.#options.onChanged?.(kept.key);
    if (work.ended) {
      void this.#dispose(kept);
      return;
    }
    if (kept.leased) return;
    if (work.runtimeTurnWaiting) {
      if (kept.graceTimer !== undefined) clearTimeout(kept.graceTimer);
      kept.graceTimer = undefined;
      if (!kept.runtimeTurnRequested) {
        kept.runtimeTurnRequested = true;
        void this.#requestRuntimeTurn(kept, BUSY_RETRIES);
      }
      return;
    }
    if (work.tasks.length > 0 || work.turnRunning || kept.runtimeTurnRequested) return;
    // The runtime starts a turn for the task that just ended; the session
    // waits a bounded moment for it rather than stop it before it opens.
    if (taskEnded || kept.graceTimer !== undefined) {
      kept.graceTimer ??= unref(
        setTimeout(() => {
          kept.graceTimer = undefined;
          const now = kept.work;
          if (
            this.#kept.get(kept.key) === kept &&
            !kept.leased &&
            !kept.runtimeTurnRequested &&
            (now === undefined ||
              (now.tasks.length === 0 && !now.turnRunning && !now.runtimeTurnWaiting))
          ) {
            void this.#dispose(kept);
          }
        }, this.#options.taskEndGraceMs ?? TASK_END_GRACE_MS),
      );
      return;
    }
    void this.#dispose(kept);
  }

  async #requestRuntimeTurn(kept: Kept, retries: number): Promise<void> {
    let outcome: Awaited<ReturnType<RuntimeTurnStarter>>;
    try {
      outcome = await this.#options.startRuntimeTurn(kept.key);
    } catch (error) {
      outcome = { status: "refused", message: "The runtime's turn could not be opened." };
      this.#options.onError?.("A runtime-started turn could not be opened.", error);
    }
    if (this.#kept.get(kept.key) !== kept || kept.leased) return;
    if (outcome.status === "busy" && retries > 0) {
      setTimeout(() => {
        if (this.#kept.get(kept.key) === kept && !kept.leased) {
          void this.#requestRuntimeTurn(kept, retries - 1);
        }
      }, this.#options.busyRetryMs ?? 1_000).unref?.();
      return;
    }
    // A runtime turn nobody can read never runs on unseen.
    if (outcome.status !== "started") {
      await this.#dispose(kept);
      return;
    }
    // The turn the host opened takes the session up when it reaches the
    // provider; one that never does leaves nothing to read the runtime's.
    kept.leaseTimer = unref(
      setTimeout(() => {
        kept.leaseTimer = undefined;
        if (this.#kept.get(kept.key) === kept && !kept.leased) void this.#dispose(kept);
      }, this.#options.leaseDeadlineMs ?? LEASE_DEADLINE_MS),
    );
  }

  #armIdleLimit(kept: Kept): void {
    if (kept.idleTimer !== undefined) clearTimeout(kept.idleTimer);
    const limit = this.#options.idleLimitMs();
    if (limit === null) return;
    kept.idleTimer = unref(
      setTimeout(() => {
        if (this.#kept.get(kept.key) === kept && !kept.leased) void this.#dispose(kept);
      }, limit),
    );
  }

  async #stopSession(kept: Kept): Promise<void> {
    const session = kept.session;
    if (session === undefined) return;
    kept.session = undefined;
    kept.work = undefined;
    session.unwatch?.();
    await Effect.runPromise(
      kept.connection.stop(session.sessionId).pipe(Effect.catchAll(() => Effect.void)),
    );
  }

  #dispose(kept: Kept): Promise<void> {
    if (kept.disposed !== undefined) return kept.disposed;
    const current = this.#kept.get(kept.key) === kept;
    kept.disposed = (async () => {
      if (this.#kept.get(kept.key) === kept) this.#kept.delete(kept.key);
      kept.leased = false;
      clearTimers(kept);
      try {
        await this.#stopSession(kept);
      } finally {
        await Effect.runPromise(Scope.close(kept.scope, Exit.void)).catch((error: unknown) =>
          this.#options.onError?.("A kept provider connection did not close cleanly.", error),
        );
        this.#options.onChanged?.(kept.key);
      }
    })();
    // The entry left the map above, before the provider stop and the scope
    // close finish. Until they do, the thread's next turn and another Stop
    // wait for this one: a turn that saw no kept session would otherwise
    // resume the same native history on a new connection while the old
    // runtime and its tasks were still shutting down.
    if (current) {
      const closing = kept.disposed;
      this.#closing.set(kept.key, closing);
      void closing.finally(() => {
        if (this.#closing.get(kept.key) === closing) this.#closing.delete(kept.key);
      });
    }
    return kept.disposed;
  }

  /** Waits until no session of this thread is still stopping. */
  async #closingSettled(key: string): Promise<boolean> {
    let waited = false;
    for (let closing = this.#closing.get(key); closing !== undefined;) {
      waited = true;
      await closing.catch(() => undefined);
      closing = this.#closing.get(key);
    }
    return waited;
  }
}

function clearTimers(kept: Kept): void {
  for (const timer of [kept.idleTimer, kept.graceTimer, kept.leaseTimer]) {
    if (timer !== undefined) clearTimeout(timer);
  }
  kept.idleTimer = undefined;
  kept.graceTimer = undefined;
  kept.leaseTimer = undefined;
}

function unref(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  timer.unref?.();
  return timer;
}

/**
 * What a session was started with, beyond its id and cursor. Functions (the
 * wake-up schedule) are the host's own and do not change the session.
 */
function sessionShape(input: ProviderSessionStart | ProviderSessionResume): string {
  const {
    sessionId: _sessionId,
    wakeups: _wakeups,
    outlivesTurn: _outlivesTurn,
    ...rest
  } = input as ProviderSessionStart & Partial<ProviderSessionResume>;
  const { resumeCursor: _cursor, current: _current, ...shape } = rest;
  return JSON.stringify(shape, (_key, value: unknown) =>
    typeof value === "function" ? undefined : value,
  );
}
