import { createHash } from "node:crypto";
import {
  VIDEO_GENERATION_REQUEST_SHAPE,
  AggregateId,
  CorrelationId,
  EventId,
  decodeAggregateVersion,
  decodeSpendCeilingReservationId,
  decodeUsageReconciliationId,
  decodeUtcTimestamp,
  type EventActor,
  type ImageGenerationScopeId,
  type ProviderFailure,
  type ProviderInstance,
  type ProviderInstanceId,
  type ProviderModelId,
  type SpendCeilingRefusal,
  type SpendCeilingReservationId,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  MAX_QUEUED_VIDEO_JOBS,
  MAX_VIDEO_PROMPT_CHARACTERS,
  VIDEO_JOB_AGGREGATE_TYPE,
  VIDEO_JOB_HOST_CONCURRENCY,
  VIDEO_JOB_PROVIDER_COPY_CHANGED,
  VIDEO_JOB_QUEUED,
  VIDEO_JOB_STATUS_CHANGED,
  VIDEO_JOB_TIMEOUT_MS,
  decodeVideoClipId,
  decodeVideoJobId,
  type VideoClipOptions,
  type VideoDriverKind,
  type VideoJob,
  type VideoJobId,
  type VideoJobStatusChanged,
  type VideoJobThreadKind,
  type VideoModelCapabilities,
  type VideoProviderCopy,
} from "@octant/contracts/video-generation";
import { isVideoProfileDriverKind } from "@octant/domain";
import { admittedBundledVideoDriverKinds } from "@octant/plugin-host/provider-drivers";
import {
  checkVideoClipOptions,
  estimateVideoCost,
  estimateVideoPromptTokens,
  settleVideoCostUsdMicros,
  videoFailure,
  type VideoCostEstimate,
  type VideoAdapterPoll,
  type VideoAdapterUsage,
  type VideoGenerationAdapter,
  type VideoGenerationDriver,
} from "@octant/provider-sdk/video-generation";
import type { ImageAdapterReference } from "@octant/provider-sdk/image-generation";
import type { ImageHttpFetch } from "../image/imageHttp";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import { redactHostSecrets } from "../process/secretRedaction";
import type { ProviderCredentialResolver } from "../providers/credentialBrokerClient";
import type { SpendCeilingService } from "../spendCeilingService";
import { geminiVideoDriver } from "./geminiVideoAdapter";
import { falVideoDriver } from "./falVideoAdapter";
import { runwayVideoDriver } from "./runwayVideoAdapter";
import type { VideoClipStore } from "./videoClipStore";
import { makeVideoGenerationPorts, type VideoSendRecord } from "./videoHttp";
import type { VideoJobProjection } from "./videoJobProjection";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
type JournalPort = Pick<Journal, "append">;

const BUNDLED_VIDEO_DRIVERS: ReadonlyArray<VideoGenerationDriver> = [
  geminiVideoDriver,
  runwayVideoDriver,
  falVideoDriver,
];
const FIRST_POLL_MS = 5_000;
const MAX_POLL_MS = 30_000;
/** How long the host waits on a provider's stop once a job's time has run out. */
const VIDEO_TIMEOUT_CLEANUP_MS = 15_000;
/** How often a partial or failed catalog read is retried per profile. */
const VIDEO_DISCOVERY_RETRY_MS = 60_000;

/** A failed status check can leave the already accepted job's outcome unknown. */
function pollFailureLeavesJobUnconfirmed(failure: ProviderFailure): boolean {
  return (
    failure.category === "unavailable" ||
    failure.category === "rate-limited" ||
    failure.category === "unauthenticated" ||
    failure.category === "unauthorized"
  );
}

/**
 * A start that fails as "unavailable" — a network error, a timeout or a 5xx
 * answer that cannot say whether the clip began — may still have reached the
 * provider, so it settles at the estimate. A rate limit or any other
 * definite rejection means the provider refused before starting, and the job
 * is billed nothing.
 */
function startMayHaveReachedProvider(failure: ProviderFailure): boolean {
  return failure.category === "unavailable";
}

/** How often a removal the provider refused is tried again while the host runs. */
export const VIDEO_REMOVAL_RETRY_MS = 15 * 60 * 1000;

export class VideoJobServiceError extends Error {
  readonly category: "invalid" | "ineligible" | "busy" | "spend-ceiling" | "conflict";
  readonly refusal?: SpendCeilingRefusal;

  constructor(
    category: VideoJobServiceError["category"],
    message: string,
    refusal?: SpendCeilingRefusal,
  ) {
    super(message);
    this.name = "VideoJobServiceError";
    this.category = category;
    if (refusal !== undefined) this.refusal = refusal;
  }
}

export interface VideoJobInputs {
  readonly firstFrame?: ImageAdapterReference;
  readonly lastFrame?: ImageAdapterReference;
  readonly references: ReadonlyArray<ImageAdapterReference>;
}

export interface EnqueueVideoJobInput extends VideoJobInputs {
  readonly threadKind: VideoJobThreadKind;
  readonly scopeId: ImageGenerationScopeId;
  readonly profileInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly prompt: string;
  readonly options: VideoClipOptions;
}

/** What the card needs before Generate: the model's declaration, the check, and the price. */
export type VideoQuote =
  | {
      readonly status: "ready";
      readonly driverKind: VideoDriverKind;
      readonly profileName: string;
      /** Who receives and bills the clip, from the driver; never the editable alias. */
      readonly providerName: string;
      readonly model: VideoModelCapabilities;
      readonly estimate: VideoCostEstimate;
    }
  | { readonly status: "refused"; readonly reason: string };

export interface VideoJobServiceOptions {
  readonly journal: JournalPort;
  readonly projection: VideoJobProjection;
  readonly clips: VideoClipStore;
  readonly readProviderInstance: (id: ProviderInstanceId) => ProviderInstance | undefined;
  readonly listProviderInstances?: () => ReadonlyArray<ProviderInstance>;
  readonly credentialResolver: ProviderCredentialResolver;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly actor: typeof EventActor.Type;
  readonly fetch?: ImageHttpFetch;
  readonly drivers?: ReadonlyArray<VideoGenerationDriver>;
  /** Video driver kinds the plugin activation ladder admits; bundled policy by default. */
  readonly admittedDriverKinds?: ReadonlySet<string>;
  readonly spendCeiling?: Pick<SpendCeilingService, "admit" | "settle" | "abandon">;
  readonly resolveThreadProjectId?: (input: {
    readonly threadType: VideoJobThreadKind;
    readonly threadId: string;
  }) => string | undefined;
  /** Waits `ms`, or less when `signal` aborts. Injected so tests run without real time. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly onChanged?: (job: VideoJob) => void;
}

interface Running {
  readonly controller: AbortController;
  readonly reservationId?: SpendCeilingReservationId;
  stopRequested: boolean;
}

function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

function sanitizedFailure(failure: ProviderFailure): ProviderFailure {
  return {
    category: failure.category,
    message: failure.message.slice(0, 2_000),
    ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
  };
}

function reportVideoRemovalFailure(error: unknown): void {
  console.error(
    "Could not finish a video provider copy removal. The host will retry.",
    error instanceof Error ? redactHostSecrets(error.message) : "Unknown failure.",
  );
}

/**
 * Runs video jobs through the video seam. It owns everything provider-neutral
 * (the poll loop and its interval, the 30-minute job time, the reservation and
 * its settlement, clip storage, the journal, restart recovery, and when the
 * provider's copy is cancelled or removed); a driver owns only the wire.
 */
export class VideoJobService {
  readonly #options: VideoJobServiceOptions;
  readonly #drivers: ReadonlyArray<VideoGenerationDriver>;
  readonly #admitted: ReadonlySet<string>;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #now: () => number;
  readonly #running = new Map<string, Running>();
  readonly #sends: VideoSendRecord = { reached: new WeakSet(), sent: new WeakSet() };
  readonly #waiting = new Map<VideoJobId, (admitted: boolean) => void>();
  readonly #terminalWaiters = new Map<string, Array<(job: VideoJob) => void>>();
  readonly #inputs = new Map<string, { readonly prompt: string } & VideoJobInputs>();
  readonly #closing = new AbortController();
  /**
   * Each profile version's declared models, as last read from its adapter. A
   * read the adapter could not complete — fewer models than the profile asks
   * for — is offered but not trusted, so a later call reads again.
   */
  readonly #declared = new Map<
    string,
    { readonly models: ReadonlyArray<VideoModelCapabilities>; readonly complete: boolean }
  >();
  readonly #declaring = new Set<string>();
  /**
   * Profile versions whose key refused a stored-payload removal, for this host
   * run: later jobs on them go straight to the provider's own expiry.
   */
  readonly #removalRefused = new Set<string>();
  /**
   * When a provider-expiring copy is gone anyway: a removal still owed past
   * this is dropped rather than retried. It is derived from the journaled
   * job's own record, not the catalog, so a restart — and a profile whose
   * endpoint has since been removed — keeps the cutoff. A job journaled
   * before the declaration was kept has none, and stays owed.
   */
  #owedCopyExpiry(job: VideoJob): number | undefined {
    if (job.providerRemoval?.kind !== "expires") return undefined;
    // Owed copies only exist on terminal jobs, so updatedAt is when the clip
    // was made — the expiry counts from then, not from when the job started.
    return Date.parse(job.updatedAt) + job.providerRemoval.afterHours * 3_600_000;
  }
  /** When each profile's catalog was last read, bounding a retry to 60 s. */
  readonly #discoveryReadAt = new Map<string, number>();
  #active = 0;
  #removalTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: VideoJobServiceOptions) {
    this.#options = options;
    this.#drivers = options.drivers ?? BUNDLED_VIDEO_DRIVERS;
    this.#admitted = options.admittedDriverKinds ?? admittedBundledVideoDriverKinds();
    this.#sleep = options.sleep ?? realSleep;
    this.#now = options.now ?? Date.now;
  }

  getById(id: VideoJobId): VideoJob | undefined {
    return this.#options.projection.getById(id);
  }

  listByScope(scopeId: ImageGenerationScopeId): ReadonlyArray<VideoJob> {
    return this.#options.projection.listByScope(scopeId);
  }

  /** The video profiles a turn may use: enabled, admitted, and declaring at least one model. */
  async readyProfiles(): Promise<
    ReadonlyArray<{
      readonly instance: ProviderInstance;
      readonly models: ReadonlyArray<VideoModelCapabilities>;
    }>
  > {
    const ready: Array<{
      readonly instance: ProviderInstance;
      readonly models: ReadonlyArray<VideoModelCapabilities>;
    }> = [];
    for (const candidate of this.#candidateInstances()) {
      const adapter = this.#adapterFor(candidate);
      if (adapter === undefined) continue;
      const models = await this.#modelsOf(adapter);
      if (models !== undefined) {
        this.#declared.set(declaredKey(candidate), {
          models,
          complete: models.length >= modelAllowlistOf(candidate.configuration).length,
        });
        if (models.length > 0) ready.push({ instance: candidate, models });
      }
    }
    return ready;
  }

  /**
   * The ready profiles as last read, without waiting: a turn decides whether
   * to offer the video tool synchronously. A profile version not read yet is
   * read in the background and offered from the next turn; `quote` still
   * reads the adapter before anything is reserved or sent.
   */
  readyProfilesNow(): ReadonlyArray<{
    readonly instance: ProviderInstance;
    readonly models: ReadonlyArray<VideoModelCapabilities>;
  }> {
    const ready: Array<{
      readonly instance: ProviderInstance;
      readonly models: ReadonlyArray<VideoModelCapabilities>;
    }> = [];
    for (const candidate of this.#candidateInstances()) {
      const adapter = this.#adapterFor(candidate);
      if (adapter === undefined) continue;
      const key = declaredKey(candidate);
      const entry = this.#declared.get(key);
      if (entry !== undefined && entry.models.length > 0) {
        ready.push({ instance: candidate, models: entry.models });
      }
      if (
        (entry === undefined || !entry.complete) &&
        !this.#declaring.has(key) &&
        this.#now() - (this.#discoveryReadAt.get(key) ?? 0) >= VIDEO_DISCOVERY_RETRY_MS
      ) {
        this.#declaring.add(key);
        this.#discoveryReadAt.set(key, this.#now());
        const wanted = modelAllowlistOf(candidate.configuration).length;
        void adapter
          .models()
          .then((models) => this.#declared.set(key, { models, complete: models.length >= wanted }))
          .catch(() => undefined)
          .finally(() => this.#declaring.delete(key));
      }
    }
    return ready;
  }

  /** Bytes `[start, end]` of a finished clip, clamped to it, for a byte-range response. */
  async readClipRange(
    job: VideoJob,
    range: { readonly start: number; readonly end: number },
  ): Promise<
    | {
        readonly bytes: Uint8Array;
        readonly start: number;
        readonly end: number;
        readonly size: number;
      }
    | undefined
  > {
    if (job.status !== "completed" || job.clip === undefined) return undefined;
    return this.#options.clips.readRange(job.scopeId, job.clip.clipId, range);
  }

  /** A finished clip's bytes, for a save under the turn's folder. */
  async readClip(job: VideoJob): Promise<Uint8Array | undefined> {
    if (job.status !== "completed" || job.clip === undefined) return undefined;
    return this.#options.clips.readAll(job.scopeId, job.clip.clipId);
  }

  /** A finished clip as a bounded stream, for a whole-clip download. */
  async streamClip(
    job: VideoJob,
  ): Promise<{ readonly body: ReadableStream<Uint8Array>; readonly size: number } | undefined> {
    if (job.status !== "completed" || job.clip === undefined) return undefined;
    return this.#options.clips.stream(job.scopeId, job.clip.clipId);
  }

  /**
   * The models a driver declares, or nothing when its discovery failed: a
   * driver may legitimately reject `models`, and a profile that cannot say
   * what it offers is not ready — never a reason to crash the caller.
   */
  async #modelsOf(
    adapter: VideoGenerationAdapter,
  ): Promise<ReadonlyArray<VideoModelCapabilities> | undefined> {
    try {
      return await adapter.models();
    } catch {
      return undefined;
    }
  }

  #candidateInstances(): ReadonlyArray<ProviderInstance> {
    const list = this.#options.listProviderInstances?.() ?? [];
    return list.filter(
      (instance) => instance.enabled && isVideoProfileDriverKind(instance.driverKind),
    );
  }

  /**
   * The card's facts before Generate: the model's declaration, whether the
   * options are within it, and the estimate. A call that skips the card uses
   * this same quote, so nothing outside the declaration is reserved or sent.
   */
  async quote(input: {
    readonly profileInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
    readonly prompt: string;
    readonly options: VideoClipOptions;
    readonly firstFrame: boolean;
    readonly lastFrame: boolean;
    readonly referenceCount: number;
  }): Promise<VideoQuote> {
    if (this.#closing.signal.aborted) {
      return { status: "refused", reason: "The host is shutting down." };
    }
    const instance = this.#options.readProviderInstance(input.profileInstanceId);
    if (instance === undefined || !instance.enabled) {
      return { status: "refused", reason: "That video profile is not available." };
    }
    const driverKind = instance.driverKind;
    if (!isVideoProfileDriverKind(driverKind)) {
      return { status: "refused", reason: "That video profile is not available." };
    }
    const adapter = this.#adapterFor(instance);
    if (adapter === undefined) {
      return { status: "refused", reason: "That video provider's plugin is turned off." };
    }
    const models = await this.#modelsOf(adapter);
    if (this.#closing.signal.aborted) {
      return { status: "refused", reason: "The host is shutting down." };
    }
    if (models === undefined) {
      return { status: "refused", reason: "That video provider cannot be reached." };
    }
    const model = models.find((candidate) => String(candidate.modelId) === String(input.modelId));
    if (model === undefined) {
      return { status: "refused", reason: "That video profile does not offer this model." };
    }
    const check = checkVideoClipOptions(model, input.options, {
      firstFrame: input.firstFrame,
      lastFrame: input.lastFrame,
      referenceCount: input.referenceCount,
    });
    if (check.status === "refused") return { status: "refused", reason: check.reason };
    const estimate = estimateVideoCost(model.price, input.options, {
      promptTokens: estimateVideoPromptTokens(input.prompt),
      imageCount: (input.firstFrame ? 1 : 0) + (input.lastFrame ? 1 : 0) + input.referenceCount,
    });
    if (estimate.kind === "no-rate") {
      return { status: "refused", reason: `${model.displayName} has no price for these options.` };
    }
    return {
      status: "ready",
      driverKind,
      profileName: instance.displayName,
      // The driver is present: `#adapterFor` built this adapter from it.
      providerName:
        this.#drivers.find((candidate) => candidate.driverKind === driverKind)?.providerName ??
        driverKind,
      model,
      estimate,
    };
  }

  /**
   * Queues a job after the same checks the card ran. Refuses when the profile
   * is unavailable, the options are outside the model's declaration, too many
   * video jobs are waiting, or a spend ceiling cannot cover the estimate;
   * nothing is sent in any of those cases.
   */
  async enqueue(input: EnqueueVideoJobInput): Promise<VideoJob> {
    const prompt = input.prompt.trim();
    if (prompt.length === 0) throw new VideoJobServiceError("invalid", "The prompt is empty.");
    if (prompt.length > MAX_VIDEO_PROMPT_CHARACTERS) {
      throw new VideoJobServiceError("invalid", "The prompt is too long.");
    }
    const quote = await this.quote({
      profileInstanceId: input.profileInstanceId,
      modelId: input.modelId,
      prompt,
      options: input.options,
      firstFrame: input.firstFrame !== undefined,
      lastFrame: input.lastFrame !== undefined,
      referenceCount: input.references.length,
    });
    if (this.#closing.signal.aborted) {
      throw new VideoJobServiceError("busy", "The host is shutting down.");
    }
    if (quote.status === "refused") throw new VideoJobServiceError("ineligible", quote.reason);
    if (this.#options.projection.countQueued() >= MAX_QUEUED_VIDEO_JOBS) {
      throw new VideoJobServiceError("busy", "Too many video jobs are queued.");
    }
    const estimatedCostUsdMicros =
      quote.estimate.kind === "estimate" ? quote.estimate.usdMicros : ("unknown" as const);
    const reserved = this.#reserve(input.threadKind, input.scopeId, estimatedCostUsdMicros);
    if (reserved?.status === "refused") {
      throw new VideoJobServiceError(
        "spend-ceiling",
        "A spend ceiling cannot cover this clip.",
        reserved.refusal,
      );
    }
    const reservationId = reserved?.status === "admitted" ? reserved.reservationId : undefined;
    const now = decodeUtcTimestamp(this.#options.clock());
    const job: VideoJob = {
      id: decodeVideoJobId(this.#options.uuid()),
      status: "queued",
      threadKind: input.threadKind,
      scopeId: input.scopeId,
      profileInstanceId: input.profileInstanceId,
      driverKind: quote.driverKind,
      modelId: input.modelId,
      promptHash: hashPrompt(prompt),
      options: input.options,
      imageCount:
        (input.firstFrame === undefined ? 0 : 1) +
        (input.lastFrame === undefined ? 0 : 1) +
        input.references.length,
      estimatedCostUsdMicros,
      providerCopy: "none",
      version: decodeAggregateVersion(1),
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.#append(job.id, 0, [{ eventName: VIDEO_JOB_QUEUED, payload: { job }, occurredAt: now }]);
    } catch (error) {
      if (reservationId !== undefined) this.#options.spendCeiling?.abandon({ reservationId });
      throw error;
    }
    this.#inputs.set(String(job.id), {
      prompt,
      references: input.references,
      ...(input.firstFrame === undefined ? {} : { firstFrame: input.firstFrame }),
      ...(input.lastFrame === undefined ? {} : { lastFrame: input.lastFrame }),
    });
    this.#running.set(String(job.id), {
      controller: new AbortController(),
      stopRequested: false,
      ...(reservationId === undefined ? {} : { reservationId }),
    });
    this.#notify(job);
    void this.#schedule(job.id, () => this.#run(job.id));
    return job;
  }

  /** Resolves when the job reaches a terminal state, or with its current state after `timeoutMs`. */
  async whenTerminal(id: VideoJobId, timeoutMs?: number): Promise<VideoJob | undefined> {
    const current = this.getById(id);
    if (current === undefined || isTerminal(current)) return current;
    return await new Promise((resolve) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => resolve(this.getById(id)), timeoutMs);
      const waiters = this.#terminalWaiters.get(String(id)) ?? [];
      waiters.push((job) => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(job);
      });
      this.#terminalWaiters.set(String(id), waiters);
    });
  }

  /**
   * Stops a job. A queued job is cancelled and billed nothing. A running job is
   * cancelled at the provider when its model can cancel, and the service keeps
   * polling until the provider confirms; otherwise the wait ends here and the
   * job settles at its estimate, because the provider may still finish it.
   */
  stop(id: VideoJobId): void {
    const key = String(id);
    const running = this.#running.get(key);
    if (running === undefined) return;
    const job = this.getById(id);
    if (job?.status === "queued") {
      this.#finish(job, "cancelled", {});
      this.#inputs.delete(key);
      const waiting = this.#waiting.get(id);
      this.#waiting.delete(id);
      waiting?.(false);
      return;
    }
    running.stopRequested = true;
    running.controller.abort();
  }

  /**
   * Reconciles what the journal left unfinished: a queued job (nothing was
   * sent) fails as interrupted and is billed nothing; a running job with a
   * provider id resumes while its resume window and job time allow; one
   * without an id settles at its estimate as interrupted; and every removal
   * still owed is tried again.
   */
  async recover(): Promise<void> {
    // Reads each profile's models in the background so the first turn can offer the tool.
    this.readyProfilesNow();
    await this.#options.clips.recover();
    if (this.#closing.signal.aborted) return;
    for (const job of this.#options.projection.listUnfinished()) {
      if (job.status === "queued") {
        this.#finish(job, "failed", {
          failure: videoFailure("interrupted", "The host restarted before the clip was sent."),
        });
        continue;
      }
      if (job.remoteId === undefined) {
        this.#finish(job, "failed", {
          failure: videoFailure(
            "interrupted",
            "The host restarted while the clip was being sent, so it may have been billed.",
          ),
          settledCostUsdMicros: estimateOrZero(job),
          billed: true,
        });
        continue;
      }
      // A job sent before the restart is resumed under a fresh reservation so
      // its estimate still counts against the ceiling until it settles.
      const reserved = this.#reserve(job.threadKind, job.scopeId, job.estimatedCostUsdMicros);
      this.#running.set(String(job.id), {
        controller: new AbortController(),
        stopRequested: false,
        ...(reserved?.status === "admitted" ? { reservationId: reserved.reservationId } : {}),
      });
      void this.#schedule(job.id, () => this.#resume(job));
    }
    const retryRemovals = () => {
      void this.retryOwedRemovals().catch(reportVideoRemovalFailure);
    };
    retryRemovals();
    if (this.#removalTimer === undefined) {
      this.#removalTimer = setInterval(retryRemovals, VIDEO_REMOVAL_RETRY_MS);
      this.#removalTimer.unref?.();
    }
  }

  /** Tries again to remove each provider copy the host still owes. */
  async retryOwedRemovals(): Promise<void> {
    if (this.#closing.signal.aborted) return;
    for (const job of this.#options.projection.listOwedRemovals()) {
      await this.#forget(job);
    }
  }

  /** Removes a thread's clips, for a thread delete. Owed provider removals stay on their jobs. */
  async purgeScope(scopeId: ImageGenerationScopeId): Promise<void> {
    for (const job of this.listByScope(scopeId)) {
      if (!isTerminal(job)) this.stop(job.id);
    }
    await this.#options.clips.purgeScope(scopeId);
  }

  /** Whether this job's start reached the host's port but was never sent. */
  #knownUnsent(running: Running): boolean {
    const signal = running.controller.signal;
    return this.#sends.reached.has(signal) && !this.#sends.sent.has(signal);
  }

  close(): void {
    if (this.#closing.signal.aborted) return;
    // Recorded before anything is aborted, while the journal is still open: a
    // start still reading its credential never reached the provider, so it is
    // interrupted and billed nothing rather than left for recovery to bill.
    const controllers = [...this.#running.values()].map((running) => running.controller);
    for (const [id, running] of [...this.#running]) {
      const job = this.getById(decodeVideoJobId(id));
      if (job?.status === "running" && job.remoteId === undefined && this.#knownUnsent(running)) {
        this.#finish(job, "failed", {
          failure: videoFailure("interrupted", "The host shut down before the clip was sent."),
        });
      }
    }
    this.#closing.abort();
    for (const waiting of this.#waiting.values()) waiting(false);
    this.#waiting.clear();
    for (const controller of controllers) controller.abort();
    if (this.#removalTimer !== undefined) clearInterval(this.#removalTimer);
  }

  // --- running jobs ---

  async #schedule(id: VideoJobId, work: () => Promise<void>): Promise<void> {
    await this.#withSlot(id, work);
    if (this.#closing.signal.aborted) return;
    const job = this.getById(id);
    if (job !== undefined && isTerminal(job))
      await this.#forget(job).catch(reportVideoRemovalFailure);
  }

  async #withSlot(id: VideoJobId, work: () => Promise<void>): Promise<void> {
    if (this.#closing.signal.aborted) return;
    if (this.#active >= VIDEO_JOB_HOST_CONCURRENCY) {
      const admitted = await new Promise<boolean>((resolve) => this.#waiting.set(id, resolve));
      if (!admitted) return;
    } else {
      this.#active += 1;
    }
    try {
      // A slot can be handed off just before close, then resume after the
      // database has closed. Keep the queued journal state for recovery.
      if (!this.#closing.signal.aborted) await work();
    } finally {
      const next = this.#waiting.entries().next().value;
      if (next === undefined) {
        this.#active -= 1;
      } else {
        this.#waiting.delete(next[0]);
        next[1](true);
      }
    }
  }

  async #run(id: VideoJobId): Promise<void> {
    const job = this.getById(id);
    const running = this.#running.get(String(id));
    const inputs = this.#inputs.get(String(id));
    this.#inputs.delete(String(id));
    if (job === undefined || running === undefined || inputs === undefined) return;
    if (running.stopRequested) {
      this.#finish(job, "cancelled", {});
      return;
    }
    const instance = this.#options.readProviderInstance(job.profileInstanceId);
    const adapter =
      instance === undefined || instance.enabled === false ? undefined : this.#adapterFor(instance);
    if (instance === undefined || adapter === undefined) {
      this.#finish(job, "failed", {
        failure: videoFailure(
          "unsupported",
          instance?.enabled === false
            ? "That video profile was turned off before the clip started."
            : "That video profile is no longer available.",
        ),
      });
      return;
    }
    // Recorded before the provider is called: a restart from here on cannot
    // know whether the provider started the job, so it settles at the estimate.
    const sending = this.#transition(job, "running", {
      startedAt: decodeUtcTimestamp(this.#options.clock()),
    });
    const remainingMs =
      Date.parse(sending.startedAt ?? sending.createdAt) + VIDEO_JOB_TIMEOUT_MS - this.#now();
    // The HTTP port's connection timer ends at the headers. The same signal
    // stays attached to the response body until the start has been decoded.
    let startTimedOut = false;
    const startTimer = setTimeout(
      () => {
        startTimedOut = true;
        running.controller.abort();
      },
      Math.max(1, remainingMs),
    );
    startTimer.unref();
    const started = await adapter
      .start({
        modelId: job.modelId,
        prompt: inputs.prompt,
        options: job.options,
        references: inputs.references,
        ...(inputs.firstFrame === undefined ? {} : { firstFrame: inputs.firstFrame }),
        ...(inputs.lastFrame === undefined ? {} : { lastFrame: inputs.lastFrame }),
        signal: running.controller.signal,
      })
      .finally(() => clearTimeout(startTimer));
    // Keep the journal's sending state when shutdown wins the race with
    // the provider's reply. Recovery accounts for a start it cannot confirm.
    if (this.#closing.signal.aborted) return;
    if (started.status === "refused") {
      this.#finish(sending, "failed", { safetyRefusal: started.safetyRefusal });
      return;
    }
    if (started.status === "failed") {
      if (running.stopRequested && this.#knownUnsent(running)) {
        this.#finish(sending, "cancelled", {});
        return;
      }
      // Stop aborted the start request after it may have reached the
      // provider, which can still make and bill the clip.
      if (running.stopRequested) {
        this.#finish(sending, "cancelled", {
          settledCostUsdMicros: estimateOrZero(sending),
          billed: true,
        });
        return;
      }
      // The provider may bill an unconfirmed start. A timeout while obtaining
      // the key can also report "unavailable", before any request was sent.
      if (
        (startTimedOut || startMayHaveReachedProvider(started.providerFailure)) &&
        !this.#knownUnsent(running)
      ) {
        this.#finish(sending, "failed", {
          failure: videoFailure(
            "interrupted",
            "The provider may have started this clip; the estimate is counted.",
          ),
          settledCostUsdMicros: estimateOrZero(sending),
          billed: true,
        });
        return;
      }
      this.#finish(sending, "failed", {
        failure: startTimedOut
          ? videoFailure("unavailable", "The clip timed out before it was sent.")
          : started.providerFailure,
      });
      return;
    }
    const model = (await this.#modelsOf(adapter))?.find(
      (candidate) => String(candidate.modelId) === String(job.modelId),
    );
    if (this.#closing.signal.aborted) return;
    const recorded = this.#recordRemote(sending, started.remoteId, model);
    await this.#pollToEnd(recorded, adapter, model);
  }

  async #resume(job: VideoJob): Promise<void> {
    const instance = this.#options.readProviderInstance(job.profileInstanceId);
    const adapter = instance === undefined ? undefined : this.#adapterFor(instance);
    const model =
      adapter === undefined
        ? undefined
        : (await this.#modelsOf(adapter))?.find(
            (candidate) => String(candidate.modelId) === String(job.modelId),
          );
    if (this.#closing.signal.aborted) return;
    const startedAt = Date.parse(job.startedAt ?? job.createdAt);
    const windowMs = (model?.job.resumeWindowHours ?? 0) * 3_600_000;
    if (adapter === undefined || model === undefined || this.#now() - startedAt > windowMs) {
      this.#finish(job, "failed", {
        failure: videoFailure(
          "interrupted",
          "The host restarted and can no longer reach this clip at the provider.",
        ),
        settledCostUsdMicros: estimateOrZero(job),
        billed: true,
      });
      return;
    }
    await this.#pollToEnd(job, adapter, model);
  }

  #recordRemote(
    job: VideoJob,
    remoteId: string,
    model: VideoModelCapabilities | undefined,
  ): VideoJob {
    let copy: VideoProviderCopy = "held";
    if (model?.job.removal.kind === "expires") {
      const instance = this.#options.readProviderInstance(job.profileInstanceId);
      if (instance !== undefined && this.#removalRefused.has(declaredKey(instance))) {
        // This profile's key already refused a removal: the provider's own
        // expiry ends this copy, and no DELETE is sent.
        copy = "expires";
      }
      // Otherwise one removal is owed after the terminal state; a refusal or
      // a copy still owed past its own expiry falls back to that expiry.
    }
    return this.#annotate(job, {
      remoteId,
      providerCopy: copy,
      // Cleanup runs long after discovery and without its model: what it
      // needs is journaled on the job itself, so a profile change or a lost
      // endpoint can never change what this copy is owed.
      ...(model?.job.removal === undefined ? {} : { providerRemoval: model.job.removal }),
    });
  }

  async #pollToEnd(
    job: VideoJob,
    adapter: VideoGenerationAdapter,
    model: VideoModelCapabilities | undefined,
  ): Promise<void> {
    const running = this.#running.get(String(job.id));
    const remoteId = job.remoteId;
    if (running === undefined || remoteId === undefined) return;
    const deadline = Date.parse(job.startedAt ?? job.createdAt) + VIDEO_JOB_TIMEOUT_MS;
    let interval = FIRST_POLL_MS;
    let cancelAsked = false;
    while (!this.#closing.signal.aborted) {
      if (running.stopRequested && !cancelAsked) {
        cancelAsked = true;
        if (model?.job.cancel === "running") {
          // Bounded by the job's deadline as well as shutdown, so the request
          // can never hold the job past the time it would settle anyway.
          const answer = await adapter.cancel(
            remoteId,
            AbortSignal.any([
              this.#closing.signal,
              AbortSignal.timeout(Math.max(1, deadline - this.#now())),
            ]),
          );
          // Shutdown aborted the cancel: the job stays running for the next
          // host to resume, never concluded from an answer the abort produced.
          if (this.#closing.signal.aborted) return;
          // A failed answer is a failure of the cancel REQUEST, not proof
          // about the job: it falls through to an immediate poll, and only a
          // terminal answer from there — or the deadline — concludes the job.
          if (
            answer.status !== "running" &&
            (answer.status !== "failed" || answer.billed === true)
          ) {
            await this.#conclude(job, answer, true);
            return;
          }
        } else {
          // The model cannot stop a running job: the wait ends here, and the
          // job settles at its estimate because the provider may still bill it.
          this.#finish(this.#current(job), "cancelled", {
            settledCostUsdMicros: estimateOrZero(job),
            billed: true,
          });
          return;
        }
      }
      if (this.#now() >= deadline) {
        // Settled before the provider is asked to stop, and the stop is
        // bounded: a cancel that finds the clip already finished may download
        // it again, which must not hold the job or its slot.
        this.#finish(this.#current(job), "failed", {
          failure: videoFailure(
            "unavailable",
            "Octant could not confirm the clip's result within 30 minutes.",
          ),
          settledCostUsdMicros: estimateOrZero(job),
          billed: true,
        });
        if (model?.job.cancel === "running") {
          await adapter.cancel(
            remoteId,
            AbortSignal.any([this.#closing.signal, AbortSignal.timeout(VIDEO_TIMEOUT_CLEANUP_MS)]),
          );
        }
        return;
      }
      // Once cancel is asked, Stop's signal stays aborted. Keep polling for
      // the provider's confirmation with shutdown and the deadline as bounds.
      const waitSignal = cancelAsked ? this.#closing.signal : running.controller.signal;
      const poll = await adapter.poll(
        remoteId,
        AbortSignal.any([waitSignal, AbortSignal.timeout(Math.max(1, deadline - this.#now()))]),
      );
      // Shutdown leaves the job running for recovery. A poll interrupted by
      // Stop leaves the provider outcome unknown and must reach cancel first.
      if (this.#closing.signal.aborted) return;
      if (
        poll.status === "failed" &&
        poll.billed !== true &&
        ((!cancelAsked && waitSignal.aborted) || this.#now() >= deadline)
      )
        continue;
      // A provider that rejects the status check may still be running the
      // clip. Retry until the provider reports an outcome or the job expires.
      if (
        poll.status !== "running" &&
        !(
          poll.status === "failed" &&
          poll.billed !== true &&
          pollFailureLeavesJobUnconfirmed(poll.providerFailure)
        )
      ) {
        await this.#conclude(job, poll, running.stopRequested);
        return;
      }
      // A provider that answered with a retry-after wait is honoured before
      // the next poll, still bounded by the job's deadline.
      const coolDown = poll.status === "failed" ? (poll.providerFailure.retryAfterMs ?? 0) : 0;
      await this.#sleep(
        Math.min(Math.max(interval, coolDown), Math.max(0, deadline - this.#now())),
        waitSignal,
      );
      interval = Math.min(Math.round(interval * 1.5), MAX_POLL_MS);
    }
  }

  async #conclude(
    job: VideoJob,
    answer: Exclude<VideoAdapterPoll, { readonly status: "running" }>,
    stopped: boolean,
  ): Promise<void> {
    const current = this.#current(job);
    switch (answer.status) {
      case "completed": {
        const clipId = decodeVideoClipId(this.#options.uuid());
        const written = await this.#options.clips.write(
          current.scopeId,
          clipId,
          answer.video.bytes,
        );
        if (this.#closing.signal.aborted) {
          // The journal may have closed while the file was being written.
          // Recovery will poll the still-running job and record a fresh clip.
          if (written.status === "stored") {
            await this.#options.clips.remove(current.scopeId, clipId).catch((error: unknown) => {
              console.error(
                "Could not remove an unrecorded video clip after shutdown.",
                error instanceof Error ? redactHostSecrets(error.message) : "Unknown failure.",
              );
            });
          }
          return;
        }
        const settled = this.#settled(current, answer.usage);
        if (written.status === "refused" && written.reason === "purged") {
          // The thread was deleted while the provider finished: nothing is
          // written back, and the job ends cancelled rather than failed on a
          // folder that is gone. The billed cost still settles.
          this.#finish(current, "cancelled", {
            settledCostUsdMicros: settled,
            billed: true,
            ...(answer.usage === undefined ? {} : { usage: answer.usage }),
          });
        } else if (written.status !== "stored") {
          this.#finish(current, "failed", {
            failure: videoFailure(
              written.status === "failed" ? "unavailable" : "protocol",
              written.status === "failed"
                ? "The clip could not be saved on this computer; check its free disk space."
                : "The provider returned a clip this host refuses to keep.",
            ),
            settledCostUsdMicros: settled,
            billed: true,
            ...(answer.usage === undefined ? {} : { usage: answer.usage }),
          });
        } else {
          this.#finish(current, "completed", {
            clip: {
              clipId,
              hash: written.hash,
              size: written.size,
              durationSeconds: current.options.durationSeconds,
              resolution: current.options.resolution,
              aspectRatio: current.options.aspectRatio,
            },
            settledCostUsdMicros: settled,
            billed: true,
            ...(answer.usage === undefined ? {} : { usage: answer.usage }),
          });
        }
        break;
      }
      case "refused": {
        // A provider can keep credits without returning the amount charged.
        const reportedCharge = answer.usage?.costUsdMicros;
        this.#finish(current, "failed", {
          safetyRefusal: answer.safetyRefusal,
          ...(answer.billed === true || reportedCharge !== undefined
            ? {
                settledCostUsdMicros:
                  reportedCharge === undefined
                    ? estimateOrZero(current)
                    : Math.max(0, Math.round(reportedCharge)),
                billed: true,
                ...(answer.usage === undefined ? {} : { usage: answer.usage }),
              }
            : {}),
        });
        break;
      }
      case "failed":
        this.#finish(current, stopped ? "cancelled" : "failed", {
          ...(stopped ? {} : { failure: answer.providerFailure }),
          ...(answer.billed === true
            ? {
                billed: true,
                settledCostUsdMicros: this.#settled(current, answer.usage),
                ...(answer.usage === undefined ? {} : { usage: answer.usage }),
              }
            : {}),
        });
        break;
      case "cancelled":
        this.#finish(current, "cancelled", {
          settledCostUsdMicros: this.#settled(current, answer.usage),
          billed: true,
          ...(answer.usage === undefined ? {} : { usage: answer.usage }),
        });
        break;
    }
  }

  #settled(job: VideoJob, usage: VideoAdapterUsage | undefined): number {
    return settleWithKnownPrice(job, usage, this.#priceFor(job));
  }

  #priceFor(job: VideoJob): VideoModelCapabilities["price"] | undefined {
    return this.#priceCache.get(`${String(job.profileInstanceId)}\n${String(job.modelId)}`);
  }

  readonly #priceCache = new Map<string, VideoModelCapabilities["price"]>();

  /**
   * Job ids a provider delete is in flight for, so a removal sweep and a
   * finished job's cleanup never send the same DELETE twice. Released in
   * `finally`: a rejected delete leaves the copy owed for the next sweep.
   */
  readonly #removing = new Set<string>();

  async #forget(candidate: VideoJob): Promise<void> {
    if (this.#closing.signal.aborted) return;
    const job = this.#current(candidate);
    if (job.providerCopy !== "held" || job.remoteId === undefined) return;
    if (this.#removing.has(String(job.id))) return;
    // The journaled expiry can settle a copy even when the profile is gone.
    const expiresAt = this.#owedCopyExpiry(job);
    if (expiresAt !== undefined && this.#now() >= expiresAt) {
      this.#markCopy(job, "expires");
      return;
    }
    this.#removing.add(String(job.id));
    try {
      const instance = this.#options.readProviderInstance(job.profileInstanceId);
      const adapter = instance === undefined ? undefined : this.#adapterFor(instance);
      if (adapter === undefined) return;
      let result;
      try {
        result = await adapter.forget(job.remoteId);
      } catch {
        // Leave the copy owed if the provider never confirms removal.
        return;
      }
      // A shutdown during the request leaves the journal closed and the copy
      // still owed; the next host's recovery retries the removal.
      if (this.#closing.signal.aborted) return;
      if (result.status === "removed") {
        this.#markCopy(job, "removed");
      } else if (
        expiresAt !== undefined &&
        (result.providerFailure.category === "unauthenticated" ||
          result.providerFailure.category === "unauthorized")
      ) {
        // This copy expires on its own and this profile's later jobs skip DELETE.
        if (instance !== undefined) this.#removalRefused.add(declaredKey(instance));
        this.#markCopy(job, "expires");
      }
    } finally {
      this.#removing.delete(String(job.id));
    }
    // Any other failure stays owed: the retry loop tries again until the
    // copy's own expiry would have ended it anyway.
  }

  #markCopy(job: VideoJob, providerCopy: VideoProviderCopy): void {
    const current = this.#current(job);
    const updatedAt = decodeUtcTimestamp(this.#options.clock());
    const version = decodeAggregateVersion(current.version + 1);
    this.#append(current.id, current.version, [
      {
        eventName: VIDEO_JOB_PROVIDER_COPY_CHANGED,
        payload: { jobId: current.id, version, updatedAt, providerCopy },
        occurredAt: updatedAt,
      },
    ]);
    this.#notify(this.#current(job));
  }

  // --- journal ---

  #current(job: VideoJob): VideoJob {
    return this.getById(job.id) ?? job;
  }

  #transition(
    job: VideoJob,
    toStatus: VideoJob["status"],
    extras: Partial<
      Pick<VideoJobStatusChanged, "startedAt" | "remoteId" | "providerCopy" | "providerRemoval">
    >,
  ): VideoJob {
    const updatedAt = decodeUtcTimestamp(this.#options.clock());
    const version = decodeAggregateVersion(job.version + 1);
    this.#append(job.id, job.version, [
      {
        eventName: VIDEO_JOB_STATUS_CHANGED,
        payload: { jobId: job.id, fromStatus: job.status, toStatus, version, updatedAt, ...extras },
        occurredAt: updatedAt,
      },
    ]);
    const next = this.#current(job);
    this.#notify(next);
    return next;
  }

  /** Records the provider job id and copy state on a running job without changing its status. */
  #annotate(
    job: VideoJob,
    extras: Pick<VideoJobStatusChanged, "remoteId" | "providerCopy"> &
      Partial<Pick<VideoJobStatusChanged, "providerRemoval">>,
  ): VideoJob {
    return this.#transition(job, job.status, extras);
  }

  #finish(
    job: VideoJob,
    toStatus: "completed" | "failed" | "cancelled",
    extras: {
      readonly clip?: VideoJob["clip"];
      readonly failure?: ProviderFailure;
      readonly safetyRefusal?: string;
      readonly settledCostUsdMicros?: number;
      readonly billed?: boolean;
      readonly usage?: VideoAdapterUsage;
    },
  ): VideoJob {
    const current = this.#current(job);
    if (isTerminal(current)) return current;
    const running = this.#running.get(String(job.id));
    this.#running.delete(String(job.id));
    const updatedAt = decodeUtcTimestamp(this.#options.clock());
    // A billed job journals its usage beside the status change, and the
    // aggregate's version counts both events.
    const version = decodeAggregateVersion(current.version + (extras.billed === true ? 2 : 1));
    const settled = extras.billed === true ? extras.settledCostUsdMicros : undefined;
    const events: Array<{ eventName: string; payload: unknown; occurredAt: UtcTimestamp }> = [
      {
        eventName: VIDEO_JOB_STATUS_CHANGED,
        payload: {
          jobId: current.id,
          fromStatus: current.status,
          toStatus,
          version,
          updatedAt,
          ...(extras.clip === undefined ? {} : { clip: extras.clip }),
          ...(extras.failure === undefined ? {} : { failure: sanitizedFailure(extras.failure) }),
          ...(extras.safetyRefusal === undefined
            ? {}
            : { safetyRefusal: extras.safetyRefusal.slice(0, 2_000) }),
          ...(settled === undefined ? {} : { settledCostUsdMicros: settled }),
        },
        occurredAt: updatedAt,
      },
    ];
    if (extras.billed === true) {
      const inputTokens = extras.usage?.inputTokens ?? 0;
      events.push({
        eventName: "context.usage-reconciled@1",
        payload: {
          reconciliation: {
            id: decodeUsageReconciliationId(this.#options.uuid()),
            providerInstanceId: current.profileInstanceId,
            modelId: current.modelId,
            requestShape: VIDEO_GENERATION_REQUEST_SHAPE,
            plannedInputTokens: inputTokens,
            actualInputTokens: inputTokens,
            actualOutputTokens: extras.usage?.outputTokens ?? 0,
            varianceTokens: 0,
            observedAt: updatedAt,
            ...(extras.usage?.outputTokens === undefined && extras.usage?.inputTokens === undefined
              ? { providerReported: false }
              : {}),
            ...(settled === undefined || current.estimatedCostUsdMicros === "unknown"
              ? {}
              : { cost: { kind: "api-estimate" as const, usdMicros: settled } }),
          },
        },
        occurredAt: updatedAt,
      });
    }
    this.#append(current.id, current.version, events);
    if (running?.reservationId !== undefined) {
      if (extras.billed === true)
        this.#options.spendCeiling?.settle({ reservationId: running.reservationId });
      else this.#options.spendCeiling?.abandon({ reservationId: running.reservationId });
    }
    const next = this.#current(current);
    this.#notify(next);
    const waiters = this.#terminalWaiters.get(String(current.id)) ?? [];
    this.#terminalWaiters.delete(String(current.id));
    for (const waiter of waiters) waiter(next);
    return next;
  }

  #append(
    jobId: VideoJobId,
    expectedVersion: number,
    events: ReadonlyArray<{
      readonly eventName: string;
      readonly payload: unknown;
      readonly occurredAt: UtcTimestamp;
    }>,
  ): void {
    try {
      this.#options.journal.append({
        aggregate: {
          aggregateType: VIDEO_JOB_AGGREGATE_TYPE,
          aggregateId: decodeAggregateId(String(jobId)),
        },
        expectedVersion: decodeAggregateVersion(expectedVersion),
        events: events.map((event) => ({
          eventId: decodeEventId(this.#options.uuid()),
          eventName: event.eventName,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#options.uuid()),
          actor: this.#options.actor,
          occurredAt: event.occurredAt,
          payload: event.payload,
        })),
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        throw new VideoJobServiceError(
          "conflict",
          "The video job changed before this update could be recorded.",
        );
      }
      throw error;
    }
  }

  #notify(job: VideoJob): void {
    this.#options.onChanged?.(job);
  }

  /**
   * Reserves a job's estimate under the same shape a new admission uses, so a
   * resumed job counts against the ceiling for as long as it is unfinished.
   */
  #reserve(
    threadKind: VideoJobThreadKind,
    scopeId: VideoJob["scopeId"],
    estimatedCostUsdMicros: VideoJob["estimatedCostUsdMicros"],
  ):
    | { readonly status: "admitted"; readonly reservationId: SpendCeilingReservationId }
    | { readonly status: "refused"; readonly refusal: SpendCeilingRefusal }
    | undefined {
    if (this.#options.spendCeiling === undefined) return undefined;
    const candidate = decodeSpendCeilingReservationId(this.#options.uuid());
    const projectId = this.#options.resolveThreadProjectId?.({
      threadType: threadKind,
      threadId: String(scopeId),
    });
    const admission = this.#options.spendCeiling.admit({
      reservationId: candidate,
      threadId: String(scopeId),
      threadType: threadKind,
      ...(projectId === undefined ? {} : { projectId }),
      countsAsTurn: false,
      skipTurnAndRunTimeCeiling: true,
      skipTokenCeiling: true,
      estimatedCostUsdMicros,
    });
    return admission.status === "admitted"
      ? { status: "admitted", reservationId: candidate }
      : { status: "refused", refusal: admission.refusal };
  }

  #adapterFor(instance: ProviderInstance): VideoGenerationAdapter | undefined {
    if (!this.#admitted.has(instance.driverKind)) return undefined;
    const driver = this.#drivers.find((candidate) => candidate.driverKind === instance.driverKind);
    if (driver === undefined) return undefined;
    const configuration: object = instance.configuration;
    const modelIds = modelAllowlistOf(configuration);
    const adapter = driver.create({
      profile: { instanceId: instance.id, modelIds },
      ports: makeVideoGenerationPorts({
        instanceId: String(instance.id),
        credentialResolver: this.#options.credentialResolver,
        providerHosts: driver.providerHosts,
        ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
        sends: this.#sends,
      }),
    });
    return {
      ...adapter,
      models: async () => {
        const models = await adapter.models();
        for (const model of models) {
          this.#priceCache.set(`${String(instance.id)}\n${String(model.modelId)}`, model.price);
        }
        return models;
      },
    };
  }
}

function isTerminal(job: VideoJob): boolean {
  return job.status === "completed" || job.status === "failed" || job.status === "cancelled";
}

function estimateOrZero(job: VideoJob): number {
  return job.estimatedCostUsdMicros === "unknown" ? 0 : job.estimatedCostUsdMicros;
}

function settleWithKnownPrice(
  job: VideoJob,
  usage: VideoAdapterUsage | undefined,
  price: VideoModelCapabilities["price"] | undefined,
): number {
  const estimate = estimateOrZero(job);
  return price === undefined
    ? estimate
    : settleVideoCostUsdMicros(price, estimate, usage, job.options, {
        imageCount: job.imageCount,
      });
}

function declaredKey(instance: ProviderInstance): string {
  return `${String(instance.id)}:${String(instance.version)}`;
}

function modelAllowlistOf(configuration: object): ReadonlyArray<ProviderModelId> {
  return "modelAllowlist" in configuration && Array.isArray(configuration.modelAllowlist)
    ? (configuration.modelAllowlist as ReadonlyArray<ProviderModelId>)
    : [];
}
