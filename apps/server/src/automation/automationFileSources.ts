import { currentProtectedFilesChoice } from "../process/secretGuard";
import type {
  AutomationDefinition,
  AutomationId,
  AutomationFileSourceCheckpoint,
  UtcTimestamp,
  AutomationCommand,
} from "@octant/contracts";
import type { WorkFilesystemPort } from "../work/workFilesystemPort";
import type { WorkFileWatchPort, WorkFileWatchSubscription } from "../work/workFileWatchPort";
import type { AutomationProjection } from "./automationProjection";
import type { AutomationSchedulerService } from "./automationSchedulerService";
import {
  AutomationFileSourceScanError,
  automationFileSourceCurrent,
  prepareAutomationFileSource,
  scanAutomationFileSource,
} from "./automationFileSourceScan";
import { reconcileAutomationFileObservation } from "./automationFileSourceState";
import type { AutomationFileSourceRearmPreparation } from "./automationFileSourceAuthority";

export interface AutomationFileSourceAuthority {
  readonly canonicalRoot: string;
  readonly bindingIdentity: string;
  /** Re-evaluates existing host Project/profile/provider/policy facts synchronously. */
  readonly current: () => boolean;
}

export interface AutomationFileSourcesOptions {
  readonly projection: AutomationProjection;
  readonly scheduler: Pick<AutomationSchedulerService, "commitFileObservation">;
  readonly filesystem: WorkFilesystemPort;
  readonly watch: WorkFileWatchPort;
  readonly authority: (
    definition: AutomationDefinition,
  ) => AutomationFileSourceAuthority | undefined;
  readonly activity: (input: {
    readonly definition: AutomationDefinition;
    readonly canonicalRoot: string;
    readonly checkpoint: AutomationFileSourceCheckpoint;
  }) => Promise<"busy" | "quiet" | "unknown">;
  readonly now: () => UtcTimestamp;
  readonly monotonic: () => number;
  readonly wake: () => void;
}

export class AutomationFileSourceReviewError extends Error {
  override readonly name = "AutomationFileSourceReviewError";
}

interface SourceObservation {
  readonly signature: string;
  readonly controller: AbortController;
  watch?: WorkFileWatchSubscription | undefined;
  scanning: boolean;
  hints: number;
  coverageGap: boolean;
  candidateDigest?: string | undefined;
  quietSince?: number | undefined;
}

/** Scan ownership attached to the existing scheduler, without another timer/dispatch loop. */
export class AutomationFileSources {
  readonly #options: AutomationFileSourcesOptions;
  readonly #sources = new Map<AutomationId, SourceObservation>();
  readonly #reviews = new Set<AutomationId>();
  #scanning = 0;
  #closed = false;
  #nextSource = 0;

  constructor(options: AutomationFileSourcesOptions) {
    this.#options = options;
  }

  /** A current person decision, not an automatic retry of a previous run. */
  async prepareRearm(input: {
    readonly command: Extract<AutomationCommand, { readonly kind: "rearm-file-automation" }>;
    readonly current: () => boolean;
    readonly signal: AbortSignal;
  }): Promise<AutomationFileSourceRearmPreparation> {
    const { command } = input;
    if (command.principal.kind !== "local-window")
      throw new AutomationFileSourceReviewError("File re-arm requires the current local window.");
    const definition = this.#options.projection.getDefinition(command.automationId);
    const checkpoint = this.#options.projection.getFileSource(command.automationId);
    let source = this.#sources.get(command.automationId);
    // A paused observer must not own (and abort) the person's new review proof.
    if (definition?.lifecycle === "paused" && source !== undefined) {
      this.#retire(source);
      this.#sources.delete(command.automationId);
      source = undefined;
    }
    if (
      definition?.trigger.kind !== "file-arrival" ||
      definition.version !== command.expectedVersion ||
      checkpoint === undefined ||
      checkpoint.sourceIdentity !== command.sourceIdentity ||
      checkpoint.observationRevision !== command.observationRevision ||
      (checkpoint.held?.digest ?? checkpoint.baselineDigest) !== command.batchDigest ||
      source?.scanning === true ||
      this.#reviews.has(command.automationId) ||
      this.#scanning >= 2 ||
      !checkpoint.baselineReady ||
      (checkpoint.phase !== "held" &&
        !(checkpoint.phase === "needs-rearm" && checkpoint.reason === "automatic-start-limit"))
    )
      throw new AutomationFileSourceReviewError(
        "The input is still settling or the review changed. Refresh and try again.",
      );
    const authority = this.#options.authority(definition);
    if (authority === undefined)
      throw new AutomationFileSourceReviewError(
        "The Project authority changed. Edit this routine first.",
      );
    const protectedChoice = currentProtectedFilesChoice();
    const hint = source?.hints;
    const signal =
      source === undefined
        ? input.signal
        : AbortSignal.any([input.signal, source.controller.signal]);
    const current = () =>
      !this.#closed &&
      !signal.aborted &&
      currentProtectedFilesChoice() === protectedChoice &&
      input.current() &&
      authority.current() &&
      this.#sources.get(command.automationId) === source &&
      source?.hints === hint &&
      this.#options.projection.getDefinition(command.automationId)?.version ===
        command.expectedVersion &&
      this.#options.projection.getFileSource(command.automationId) === checkpoint;
    if (source !== undefined) source.scanning = true;
    this.#reviews.add(command.automationId);
    this.#scanning += 1;
    try {
      if (!current()) throw new AutomationFileSourceReviewError("The review authority changed.");
      const root = await prepareAutomationFileSource({
        filesystem: this.#options.filesystem,
        canonicalRoot: authority.canonicalRoot,
        bindingIdentity: authority.bindingIdentity,
        trigger: definition.trigger,
        current,
        signal,
      });
      if (!current() || root.sourceIdentity !== command.sourceIdentity)
        throw new AutomationFileSourceReviewError(
          "The input folder changed. Edit the routine before re-arming it.",
        );
      const before = await this.#options.activity({
        definition,
        canonicalRoot: root.canonicalRoot,
        checkpoint,
      });
      if (!current() || before !== "quiet")
        throw new AutomationFileSourceReviewError(
          "Known Project activity or uncertain cleanup still holds this input. Finish it before re-arming.",
        );
      const observation = await scanAutomationFileSource({
        filesystem: this.#options.filesystem,
        root,
        trigger: definition.trigger,
        signal,
        current,
      });
      if (!current() || observation.digest !== command.batchDigest)
        throw new AutomationFileSourceReviewError(
          "The input changed after the review. Refresh the held batch and try again.",
        );
      const after = await this.#options.activity({
        definition,
        canonicalRoot: root.canonicalRoot,
        checkpoint,
      });
      if (!current() || after !== "quiet")
        throw new AutomationFileSourceReviewError(
          "Known Project activity or uncertain cleanup still holds this input. Finish it before re-arming.",
        );
      const files = checkpoint.held?.files ?? [];
      if (command.disposition === "run-once" && files.length === 0)
        throw new AutomationFileSourceReviewError(
          "No changed surviving input remains. Choose Skip these changes and re-arm.",
        );
      const review = {
        expectedDefinitionVersion: command.expectedVersion,
        previousSourceIdentity: command.sourceIdentity,
        previousObservationRevision: command.observationRevision,
        previousBatchDigest: command.batchDigest,
        disposition: command.disposition,
        reviewedWindowId: command.principal.windowId,
        reviewedCapabilityGeneration: command.principal.capabilityGeneration,
        reviewedAt: this.#options.now(),
      };
      const next: AutomationFileSourceCheckpoint = {
        sourceIdentity: checkpoint.sourceIdentity,
        observationRevision: checkpoint.observationRevision + 1,
        armGeneration: checkpoint.armGeneration + 1,
        automaticStarts: command.disposition === "run-once" ? 1 : 0,
        baselineReady: true,
        baseline: observation.snapshot,
        baselineDigest: observation.digest,
        observedAt: this.#options.now(),
        phase:
          command.disposition === "run-once" && definition.trigger.automaticStartLimit === 1
            ? "needs-rearm"
            : "watching",
        ...(command.disposition === "run-once" && definition.trigger.automaticStartLimit === 1
          ? { reason: "automatic-start-limit" as const }
          : {}),
        coverageGap: checkpoint.coverageGap,
        activityWindow: [],
        busyChangeObserved: false,
      };
      const retained = () =>
        current() && automationFileSourceCurrent(this.#options.filesystem, root) && current();
      if (!retained())
        throw new AutomationFileSourceReviewError(
          "The input folder changed. Edit it before re-arming.",
        );
      return {
        kind: "rearm",
        automationId: command.automationId,
        expectedVersion: command.expectedVersion,
        checkpoint: next,
        review,
        files,
        current: retained,
      };
    } finally {
      if (source !== undefined) source.scanning = false;
      this.#reviews.delete(command.automationId);
      this.#scanning -= 1;
      if (
        source !== undefined &&
        this.#options.projection.getDefinition(command.automationId)?.lifecycle !== "enabled"
      ) {
        this.#retire(source);
        this.#sources.delete(command.automationId);
      }
    }
  }

  /** Called by the existing host scheduler. It never awaits filesystem work. */
  async reconcile(): Promise<void> {
    if (this.#closed) return;
    const pending: Array<Promise<void>> = [];
    const definitions = this.#options.projection
      .listDefinitions()
      .filter(
        (definition) =>
          definition.lifecycle === "enabled" && definition.trigger.kind === "file-arrival",
      );
    const present = new Set(definitions.map((definition) => definition.id));
    for (const [id, source] of this.#sources)
      if (!present.has(id) && !this.#reviews.has(id)) {
        this.#retire(source);
        this.#sources.delete(id);
      }
    if (definitions.length === 0) return;
    // Round robin bounds simultaneous filesystem work without starving later definitions.
    const start = this.#nextSource % definitions.length;
    for (let offset = 0; offset < definitions.length; offset += 1) {
      const index = (start + offset) % definitions.length;
      const definition = definitions[index];
      if (definition === undefined || this.#reviews.has(definition.id)) continue;
      const pendingRun = this.#options.projection.latestRun(definition.id);
      if (
        pendingRun?.occurrence.kind === "file-arrival" &&
        !this.#options.projection.isOccurrenceConsumed(definition.id, pendingRun.occurrenceKey)
      )
        continue;
      const checkpoint = this.#options.projection.getFileSource(definition.id);
      if (checkpoint === undefined || checkpoint.reason === "activity-history-limit") continue; // No captured source identity is never a read grant.
      const signature = JSON.stringify([
        definition.definitionRevision,
        definition.trigger,
        checkpoint.sourceIdentity,
      ]);
      let source = this.#sources.get(definition.id);
      if (source !== undefined && source.signature !== signature) {
        this.#retire(source);
        this.#sources.delete(definition.id);
        source = undefined;
      }
      if (source === undefined) {
        source = {
          signature,
          controller: new AbortController(),
          scanning: false,
          hints: 0,
          coverageGap: checkpoint.baselineReady,
        };
        this.#sources.set(definition.id, source);
      }
      if (source.scanning || this.#scanning >= 2) continue;
      source.scanning = true;
      this.#scanning += 1;
      this.#nextSource = index + 1;
      const owned = source;
      const job = this.#observe(definition, checkpoint, owned)
        .catch(() => {
          /* One source cannot stop its siblings. */
        })
        .finally(() => {
          owned.scanning = false;
          this.#scanning -= 1;
          if (
            !this.#closed &&
            this.#options.projection.getDefinition(definition.id)?.version !== definition.version
          )
            this.#options.wake();
        });
      pending.push(job);
    }
    await Promise.all(pending);
  }

  /** Revoke synchronously; a noncooperative old scan cannot publish after close. */
  close(): void {
    this.#closed = true;
    for (const source of this.#sources.values()) this.#retire(source);
    this.#sources.clear();
  }

  #retire(source: SourceObservation): void {
    source.controller.abort();
    source.watch?.close();
    source.watch = undefined;
  }

  async #observe(
    definition: AutomationDefinition,
    checkpoint: AutomationFileSourceCheckpoint,
    source: SourceObservation,
  ): Promise<void> {
    if (definition.trigger.kind !== "file-arrival") return;
    const authority = this.#options.authority(definition);
    const protectedChoice = currentProtectedFilesChoice();
    const ownerCurrent = () =>
      !this.#closed &&
      !source.controller.signal.aborted &&
      this.#sources.get(definition.id) === source &&
      this.#options.projection.getDefinition(definition.id)?.version === definition.version &&
      this.#options.projection.getFileSource(definition.id) === checkpoint;
    const current = () =>
      ownerCurrent() &&
      currentProtectedFilesChoice() === protectedChoice &&
      authority !== undefined &&
      authority.current();
    if (!ownerCurrent()) return;
    if (authority === undefined || !authority.current()) {
      this.#fail(definition, checkpoint, source, "authority-changed", ownerCurrent);
      return;
    }
    const hint = source.hints;
    try {
      const root = await prepareAutomationFileSource({
        filesystem: this.#options.filesystem,
        canonicalRoot: authority.canonicalRoot,
        bindingIdentity: authority.bindingIdentity,
        trigger: definition.trigger,
        current,
        signal: source.controller.signal,
      });
      if (!current()) return;
      if (root.sourceIdentity !== checkpoint.sourceIdentity)
        throw new AutomationFileSourceScanError("source-changed");
      if (source.watch === undefined) {
        let failed = false;
        const watch = this.#options.watch.watch(
          root.canonicalDirectory,
          () => {
            source.hints += 1;
            source.candidateDigest = undefined;
            source.quietSince = undefined;
            this.#options.wake();
          },
          () => {
            failed = true;
            const wasWatching = source.watch !== undefined;
            const firstGap = !source.coverageGap;
            source.coverageGap = true;
            if (wasWatching) {
              source.hints += 1;
              source.candidateDigest = undefined;
              source.quietSince = undefined;
              source.watch?.close();
              source.watch = undefined;
            }
            if (firstGap) this.#options.wake();
          },
        );
        if (failed) watch.close();
        else source.watch = watch;
      }
      const before = await this.#options.activity({
        definition,
        canonicalRoot: root.canonicalRoot,
        checkpoint,
      });
      if (!current()) return;
      const observation = await scanAutomationFileSource({
        filesystem: this.#options.filesystem,
        root,
        trigger: definition.trigger,
        current,
        signal: source.controller.signal,
      });
      if (!current()) return;
      const after = await this.#options.activity({
        definition,
        canonicalRoot: root.canonicalRoot,
        checkpoint,
      });
      if (!current()) return;
      const activity =
        before === "unknown" || after === "unknown"
          ? "unknown"
          : before === "busy" || after === "busy"
            ? "busy"
            : "quiet";
      const now = this.#options.monotonic();
      if (activity !== "quiet" || hint !== source.hints) {
        source.candidateDigest = undefined;
        source.quietSince = undefined;
      } else if (source.candidateDigest !== observation.digest) {
        source.candidateDigest = observation.digest;
        source.quietSince = now;
      }
      const settled =
        source.quietSince !== undefined &&
        now - source.quietSince >= definition.trigger.settleSeconds * 1_000;
      const decision = reconcileAutomationFileObservation({
        trigger: definition.trigger,
        previous: checkpoint,
        snapshot: observation.snapshot,
        observedAt: this.#options.now(),
        settled,
        activity,
        coverageGap: source.coverageGap,
        missedRunPolicy: definition.missedRunPolicy,
      });
      if (!current()) return;
      const retained = () =>
        current() && automationFileSourceCurrent(this.#options.filesystem, root) && current();
      if (!retained()) throw new AutomationFileSourceScanError("source-changed");
      const outcome = this.#options.scheduler.commitFileObservation({
        automationId: definition.id,
        expectedVersion: definition.version,
        previousObservationRevision: checkpoint.observationRevision,
        decision,
        current: retained,
      });
      if (outcome === "committed" && settled) source.coverageGap = false;
    } catch (error) {
      if (!current()) return;
      const reason =
        error instanceof AutomationFileSourceScanError ? error.reason : "source-unavailable";
      this.#fail(definition, checkpoint, source, reason, current);
    }
  }

  #fail(
    definition: AutomationDefinition,
    previous: AutomationFileSourceCheckpoint,
    source: SourceObservation,
    reason: "source-unavailable" | "source-changed" | "source-limit" | "authority-changed",
    current: () => boolean,
  ): void {
    source.coverageGap = true;
    source.candidateDigest = undefined;
    source.quietSince = undefined;
    if (previous.reason === reason && previous.coverageGap) return;
    this.#options.scheduler.commitFileObservation({
      automationId: definition.id,
      expectedVersion: definition.version,
      previousObservationRevision: previous.observationRevision,
      current,
      decision: {
        kind: "checkpoint",
        checkpoint: {
          ...previous,
          observationRevision: previous.observationRevision + 1,
          phase:
            reason === "source-changed" || reason === "authority-changed"
              ? "needs-rearm"
              : "unavailable",
          reason,
          coverageGap: true,
          observedAt: this.#options.now(),
        },
      },
    });
  }
}
