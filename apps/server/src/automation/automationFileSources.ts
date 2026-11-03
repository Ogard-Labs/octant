import type {
  AutomationDefinition,
  AutomationId,
  AutomationFileSourceCheckpoint,
  UtcTimestamp,
} from "@octant/contracts";
import type { WorkFilesystemPort } from "../work/workFilesystemPort";
import type { WorkFileWatchPort, WorkFileWatchSubscription } from "../work/workFileWatchPort";
import type { AutomationProjection } from "./automationProjection";
import type { AutomationSchedulerService } from "./automationSchedulerService";
import {
  AutomationFileSourceScanError,
  prepareAutomationFileSource,
  scanAutomationFileSource,
} from "./automationFileSourceScan";
import { reconcileAutomationFileObservation } from "./automationFileSourceState";

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
  #scanning = 0;
  #closed = false;
  #nextSource = 0;

  constructor(options: AutomationFileSourcesOptions) {
    this.#options = options;
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
      if (!present.has(id)) {
        this.#retire(source);
        this.#sources.delete(id);
      }
    if (definitions.length === 0) return;
    // Round robin bounds simultaneous filesystem work without starving later definitions.
    const start = this.#nextSource % definitions.length;
    for (let offset = 0; offset < definitions.length; offset += 1) {
      const index = (start + offset) % definitions.length;
      const definition = definitions[index];
      if (definition === undefined) continue;
      const checkpoint = this.#options.projection.getFileSource(definition.id);
      if (checkpoint === undefined) continue; // No captured source identity is never a read grant.
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
    const ownerCurrent = () =>
      !this.#closed &&
      !source.controller.signal.aborted &&
      this.#sources.get(definition.id) === source &&
      this.#options.projection.getDefinition(definition.id)?.version === definition.version &&
      this.#options.projection.getFileSource(definition.id) === checkpoint;
    const current = () => ownerCurrent() && authority !== undefined && authority.current();
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
      const outcome = this.#options.scheduler.commitFileObservation({
        automationId: definition.id,
        expectedVersion: definition.version,
        previousObservationRevision: checkpoint.observationRevision,
        decision,
        current,
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
