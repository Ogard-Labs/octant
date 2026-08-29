import type {
  CodeProjectPullRequestBackgroundRefreshState,
  ProjectId,
  UtcTimestamp,
} from "@octant/contracts";
import { UtcTimestamp as UtcTimestampSchema } from "@octant/contracts";
import {
  CODE_PROJECT_PULL_REQUEST_CADENCE_FLOOR_MS,
  decidePullRequestCadenceObservation,
  restartPullRequestCadence,
  settlePullRequestCadenceObservation,
  type PullRequestCadenceOutcome,
  type PullRequestCadenceProjectState,
} from "@octant/domain/code-project-pull-request-cadence-policy";
import { Schema } from "effect";
import type { CodeProjectPullRequestCadenceObservation } from "./codeProjectPullRequestService";

const decodeUtcTimestamp = Schema.decodeUnknownSync(UtcTimestampSchema);

export interface CodeProjectPullRequestCadenceProject {
  readonly projectId: ProjectId;
  readonly enabled: boolean;
}

export interface CodeProjectPullRequestCadenceOptions {
  /** Active Code Projects and whether each opted into background refresh. */
  readonly projects: () =>
    | ReadonlyArray<CodeProjectPullRequestCadenceProject>
    | Promise<ReadonlyArray<CodeProjectPullRequestCadenceProject>>;
  /**
   * Whether the Project has at least one board-relevant linked-thread fact.
   * With nothing on any card to keep honest, the cadence does not reach `gh`.
   */
  readonly hasBoardRelevantIdentities: (projectId: ProjectId) => boolean | Promise<boolean>;
  readonly observe: (
    projectId: ProjectId,
    signal: AbortSignal,
  ) => Promise<CodeProjectPullRequestCadenceObservation>;
  /** Sink for per-Project cadence state, surfaced on the list view. */
  readonly onState?: (state: CodeProjectPullRequestBackgroundRefreshState) => void;
  /** False when `gh` is missing or refused validation: the cadence never starts an observation. */
  readonly ghAvailable: boolean;
  /** Epoch milliseconds. */
  readonly clock?: () => number;
  readonly intervalMs?: number;
  readonly wakeMs?: number;
}

/**
 * Timer-owned background refresh of the Project pull-request snapshot.
 *
 * The cadence holds only in-memory pacing state and calls exactly one write
 * surface: `observeForCadence` on the snapshot service, which is itself
 * in-memory. Its dependency surface deliberately exposes no journal and no
 * persistence — however many passes run, the journal cannot change unless a
 * user acts. All pacing decisions live in the domain policy; this class only
 * feeds it the wall clock and the injected sources.
 */
export class CodeProjectPullRequestCadence {
  readonly #projects: CodeProjectPullRequestCadenceOptions["projects"];
  readonly #hasIdentities: CodeProjectPullRequestCadenceOptions["hasBoardRelevantIdentities"];
  readonly #observe: CodeProjectPullRequestCadenceOptions["observe"];
  readonly #onState: CodeProjectPullRequestCadenceOptions["onState"];
  readonly #ghAvailable: boolean;
  readonly #clock: () => number;
  readonly #intervalMs: number | undefined;
  readonly #wakeMs: number;
  readonly #states = new Map<string, PullRequestCadenceProjectState>();
  readonly #previouslyEnabled = new Set<string>();
  readonly #abort = new AbortController();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(options: CodeProjectPullRequestCadenceOptions) {
    this.#projects = options.projects;
    this.#hasIdentities = options.hasBoardRelevantIdentities;
    this.#observe = options.observe;
    this.#onState = options.onState;
    this.#ghAvailable = options.ghAvailable;
    this.#clock = options.clock ?? (() => Date.now());
    this.#intervalMs = options.intervalMs;
    this.#wakeMs = Math.max(options.wakeMs ?? CODE_PROJECT_PULL_REQUEST_CADENCE_FLOOR_MS, 1);
  }

  start(): void {
    if (this.#stopped || this.#timer !== undefined) return;
    this.#scheduleNextPass();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#abort.abort();
  }

  /** One reconciliation over every active Code Project. Passes never overlap: the timer chain schedules the next only after this one settles. */
  async pass(): Promise<void> {
    if (this.#stopped) return;
    let projects: ReadonlyArray<CodeProjectPullRequestCadenceProject>;
    try {
      projects = await this.#projects();
    } catch {
      // An unreadable Project list pauses this pass; the next wake retries.
      return;
    }
    for (const project of projects) {
      if (this.#stopped) return;
      await this.#reconcileProject(project);
    }
  }

  async #reconcileProject(project: CodeProjectPullRequestCadenceProject): Promise<void> {
    const key = String(project.projectId);
    let state = this.#states.get(key) ?? {};

    // Re-enabling is the explicit user signal that restarts a stopped cadence.
    // Nothing else clears a stop: an unauthorized `gh` must not be retried on
    // a timer.
    if (project.enabled && !this.#previouslyEnabled.has(key) && state.stopped !== undefined) {
      state = restartPullRequestCadence(state);
      this.#states.set(key, state);
    }
    if (project.enabled) this.#previouslyEnabled.add(key);
    else this.#previouslyEnabled.delete(key);

    let hasIdentities = false;
    if (project.enabled) {
      try {
        hasIdentities = await this.#hasIdentities(project.projectId);
      } catch {
        hasIdentities = false;
      }
    }

    const decision = decidePullRequestCadenceObservation({
      enabled: project.enabled,
      hasBoardRelevantIdentities: hasIdentities,
      ghAvailable: this.#ghAvailable,
      state,
      nowMs: this.#clock(),
      ...(this.#intervalMs === undefined ? {} : { intervalMs: this.#intervalMs }),
    });

    if (decision.kind === "stopped") {
      this.#report(project.projectId, "unavailable", undefined);
      return;
    }
    if (decision.kind === "idle") {
      this.#report(
        project.projectId,
        decision.reason === "disabled" ? "disabled" : "scheduled",
        undefined,
      );
      return;
    }
    if (decision.kind === "wait") {
      this.#report(
        project.projectId,
        state.backoff !== undefined ? "backing-off" : "scheduled",
        decision.untilMs,
      );
      return;
    }

    const outcome = await this.#observeOutcome(project.projectId);
    const next = settlePullRequestCadenceObservation(state, outcome, this.#clock());
    this.#states.set(key, next);
    if (next.stopped !== undefined) {
      this.#report(project.projectId, "unavailable", undefined);
    } else if (next.backoff !== undefined) {
      this.#report(project.projectId, "backing-off", next.backoff.retryAt);
    } else {
      this.#report(project.projectId, "scheduled", undefined);
    }
  }

  async #observeOutcome(projectId: ProjectId): Promise<PullRequestCadenceOutcome> {
    let observation: CodeProjectPullRequestCadenceObservation;
    try {
      observation = await this.#observe(projectId, this.#abort.signal);
    } catch {
      // The service reports expected failures as values; a throw is a broken
      // collaborator, which the cadence still paces as a plain failure.
      return { status: "failed" };
    }
    switch (observation.status) {
      case "fresh":
        return { status: "fresh" };
      case "empty":
      case "unconnected":
        return { status: "empty" };
      case "unauthorized":
        return { status: "unauthorized" };
      case "failed": {
        const retryAtMs =
          observation.retryAfter === undefined ? undefined : Date.parse(observation.retryAfter);
        return {
          status: "failed",
          ...(retryAtMs === undefined || !Number.isFinite(retryAtMs) ? {} : { retryAtMs }),
        };
      }
    }
  }

  #report(
    projectId: ProjectId,
    state: CodeProjectPullRequestBackgroundRefreshState["state"],
    nextObservationAtMs: number | undefined,
  ): void {
    if (this.#onState === undefined) return;
    let nextObservationAt: UtcTimestamp | undefined;
    if (nextObservationAtMs !== undefined && Number.isFinite(nextObservationAtMs)) {
      try {
        nextObservationAt = decodeUtcTimestamp(new Date(nextObservationAtMs).toISOString());
      } catch {
        nextObservationAt = undefined;
      }
    }
    this.#onState({
      projectId,
      state,
      ...(nextObservationAt === undefined ? {} : { nextObservationAt }),
    });
  }

  #scheduleNextPass(): void {
    if (this.#stopped) return;
    const timer = setTimeout(() => {
      void this.pass()
        .catch(() => {
          // pass() only throws on a broken invariant; the loop must survive it.
        })
        .finally(() => {
          this.#timer = undefined;
          this.#scheduleNextPass();
        });
    }, this.#wakeMs);
    timer.unref?.();
    this.#timer = timer;
  }
}
