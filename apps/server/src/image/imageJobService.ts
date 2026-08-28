import { createHash } from "node:crypto";
import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  IMAGE_GENERATION_REQUEST_SHAPE,
  IMAGE_JOB_AGGREGATE_TYPE,
  IMAGE_JOB_HOST_CONCURRENCY,
  IMAGE_JOB_QUEUED,
  IMAGE_JOB_RESTART_INTERRUPTION_MESSAGE,
  IMAGE_JOB_STATUS_CHANGED,
  MAX_GENERATED_IMAGE_BYTES,
  MAX_IMAGE_PROMPT_CHARACTERS,
  MAX_IMAGE_VARIANTS,
  decodeImageArtifactId,
  decodeImageGenerationScopeId,
  decodeImageJob,
  decodeImageJobId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeUsageReconciliationId,
  decodeUtcTimestamp,
  type GeminiImageAspectRatio,
  type GeminiImageProviderInstance,
  type GeminiImageResolution,
  type ImageArtifactId,
  type ImageArtifactMediaType,
  type ImageArtifactRecord,
  type ImageGenerationScopeId,
  type ImageJob,
  type ImageJobId,
  type ImageJobStatus,
  type ImageJobThreadKind,
  type OpenAiImageProviderInstance,
  type OpenAiImageQuality,
  type OpenAiImageSize,
  type ProviderInstance,
  type ProviderInstanceId,
  type ProviderModelId,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  assertImageJobExpectedVersion,
  assertImageJobProfileEligible,
  assertImageJobTransitionAllowed,
  isImageJobTerminalStatus,
  nextImageJobVersion,
} from "@octant/domain";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import type { ProviderCredentialResolver } from "../providers/credentialBrokerClient";
import { makeGeminiImageAdapter } from "./geminiImageAdapter";
import type { GeneratedImageStore } from "./generatedImageStore";
import type { ImageAdapterRequest, ImageGenerationAdapter } from "./imageAdapter";
import type { ImageHttpFetch } from "./imageHttp";
import { ImageJobProjection } from "./imageJobProjection";
import { makeOpenAiImageAdapter } from "./openAiImageAdapter";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);

type JournalPort = Pick<Journal, "append">;

export class ImageJobServiceError extends Error {
  override readonly name = "ImageJobServiceError";
  readonly category: "invalid" | "ineligible" | "conflict";

  constructor(category: ImageJobServiceError["category"], message: string) {
    super(message);
    this.category = category;
  }
}

export interface EnqueueImageJobInput {
  readonly threadKind: ImageJobThreadKind;
  readonly scopeId: ImageGenerationScopeId;
  readonly profileInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly prompt: string;
  readonly parentArtifactRef?: ImageJob["parentArtifactRef"];
  readonly references?: ImageAdapterRequest["references"];
  readonly variantCount?: number;
  readonly quality?: OpenAiImageQuality;
  readonly size?: OpenAiImageSize;
  readonly aspectRatio?: GeminiImageAspectRatio;
  readonly resolution?: GeminiImageResolution;
}

export interface ImageJobServiceOptions {
  readonly journal: JournalPort;
  readonly projection: ImageJobProjection;
  readonly attachments: GeneratedImageStore;
  readonly readProviderInstance: (id: ProviderInstanceId) => ProviderInstance | undefined;
  readonly credentialResolver: ProviderCredentialResolver;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly actor: typeof EventActor.Type;
  readonly fetch?: ImageHttpFetch;
  readonly createAdapter?: (instance: ProviderInstance) => ImageGenerationAdapter;
  readonly concurrency?: number;
}

/**
 * Journaled image-generation jobs. One profile per job; a safety refusal is
 * terminal and is never retried on another provider. A job found running after
 * restart is failed with an honest interruption — the provider call is billed
 * and not idempotent, so it is never re-invoked.
 */
export class ImageJobService {
  readonly #journal: JournalPort;
  readonly #projection: ImageJobProjection;
  readonly #attachments: GeneratedImageStore;
  readonly #readProviderInstance: ImageJobServiceOptions["readProviderInstance"];
  readonly #credentialResolver: ProviderCredentialResolver;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #actor: typeof EventActor.Type;
  readonly #fetch: ImageHttpFetch | undefined;
  readonly #createAdapter: (instance: ProviderInstance) => ImageGenerationAdapter;
  readonly #concurrency: number;
  readonly #abort = new Map<string, AbortController>();
  readonly #waiters = new Map<string, Deferred<ImageJob>>();
  readonly #terminalPersistenceErrors = new Map<string, Error>();
  readonly #pending = new Array<ImageJobId>();
  #running = 0;
  #pumping = false;

  constructor(options: ImageJobServiceOptions) {
    this.#journal = options.journal;
    this.#projection = options.projection;
    this.#attachments = options.attachments;
    this.#readProviderInstance = options.readProviderInstance;
    this.#credentialResolver = options.credentialResolver;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#actor = decodeActor(options.actor);
    this.#fetch = options.fetch;
    this.#createAdapter = options.createAdapter ?? ((instance) => this.#defaultAdapter(instance));
    this.#concurrency = options.concurrency ?? IMAGE_JOB_HOST_CONCURRENCY;
    if (!Number.isSafeInteger(this.#concurrency) || this.#concurrency < 1) {
      throw new ImageJobServiceError(
        "invalid",
        "Image job concurrency must be a positive integer.",
      );
    }
  }

  get(jobId: ImageJobId): ImageJob | undefined {
    return this.#projection.getById(jobId);
  }

  listByScope(scopeId: ImageGenerationScopeId): ReadonlyArray<ImageJob> {
    return this.#projection.listByScope(scopeId);
  }

  async readArtifact(
    jobId: ImageJobId,
    attachmentId: ImageArtifactId,
  ): Promise<{ readonly bytes: Uint8Array; readonly mime: ImageArtifactMediaType } | undefined> {
    const job = this.#projection.getById(jobId);
    if (job === undefined || job.status !== "completed") return undefined;
    const artifact = job.artifacts.find(
      (candidate) => String(candidate.attachmentId) === String(attachmentId),
    );
    if (artifact === undefined) return undefined;
    const bytes = await this.#attachments.read({
      scopeId: job.scopeId,
      attachmentId: artifact.attachmentId,
      displayName: "generated.png",
      size: artifact.size,
      hash: artifact.hash,
      mime: artifact.mime,
      finalizedAt: job.updatedAt,
    });
    return { bytes, mime: artifact.mime };
  }

  whenTerminal(jobId: ImageJobId): Promise<ImageJob> {
    const persistenceError = this.#terminalPersistenceErrors.get(String(jobId));
    if (persistenceError !== undefined) return Promise.reject(persistenceError);
    const current = this.#projection.getById(jobId);
    if (current !== undefined && isImageJobTerminalStatus(current.status)) {
      return Promise.resolve(current);
    }
    return this.#deferred(jobId).promise;
  }

  async enqueue(input: EnqueueImageJobInput): Promise<ImageJob> {
    if (input.prompt.trim().length === 0) {
      throw new ImageJobServiceError("invalid", "The image prompt must not be empty.");
    }
    if (input.prompt.length > MAX_IMAGE_PROMPT_CHARACTERS) {
      throw new ImageJobServiceError("invalid", "The image prompt exceeded the length limit.");
    }
    const variantCount = input.variantCount ?? 1;
    if (
      !Number.isSafeInteger(variantCount) ||
      variantCount < 1 ||
      variantCount > MAX_IMAGE_VARIANTS
    ) {
      throw new ImageJobServiceError("invalid", "The requested variant count is not supported.");
    }
    const references = (input.references ?? []).map((reference) => ({
      mediaType: reference.mediaType,
      bytes: Uint8Array.from(reference.bytes),
    }));
    if (input.parentArtifactRef !== undefined && references.length > 0) {
      throw new ImageJobServiceError(
        "invalid",
        "An edit job cannot combine a parent image with explicit references.",
      );
    }
    if (input.parentArtifactRef !== undefined) {
      try {
        const parentBytes = await this.#attachments.read({
          scopeId: decodeImageGenerationScopeId(input.scopeId),
          attachmentId: input.parentArtifactRef.attachmentId,
          displayName: "parent.png",
          size: input.parentArtifactRef.size,
          hash: input.parentArtifactRef.hash,
          mime: input.parentArtifactRef.mime,
          finalizedAt: this.#clock(),
        });
        references.push({
          mediaType: input.parentArtifactRef.mime,
          bytes: Uint8Array.from(parentBytes),
        });
      } catch {
        throw new ImageJobServiceError("invalid", "The parent image is unavailable.");
      }
    }
    let referenceBytes = 0;
    for (const reference of references) {
      if (reference.bytes.length === 0) {
        throw new ImageJobServiceError("invalid", "A reference image must not be empty.");
      }
      if (reference.bytes.length > MAX_GENERATED_IMAGE_BYTES) {
        throw new ImageJobServiceError("invalid", "A reference image exceeded the size limit.");
      }
      referenceBytes += reference.bytes.length;
      if (referenceBytes > MAX_GENERATED_IMAGE_BYTES * 2) {
        throw new ImageJobServiceError("invalid", "Reference images exceeded the size limit.");
      }
    }
    const instance = this.#readProviderInstance(input.profileInstanceId);
    if (instance === undefined) {
      throw new ImageJobServiceError("ineligible", "The image profile does not exist.");
    }
    try {
      assertImageJobProfileEligible(instance, input.modelId);
    } catch (error) {
      throw new ImageJobServiceError(
        "ineligible",
        error instanceof Error ? error.message : "The image profile is not eligible.",
      );
    }

    const now = decodeUtcTimestamp(this.#clock());
    const job = decodeImageJob({
      id: decodeImageJobId(this.#uuid()),
      status: "queued",
      threadKind: input.threadKind,
      scopeId: decodeImageGenerationScopeId(input.scopeId),
      profileInstanceId: decodeProviderInstanceId(input.profileInstanceId),
      modelId: decodeProviderModelId(input.modelId),
      promptHash: hashPrompt(input.prompt),
      artifacts: [],
      version: 1 as ImageJob["version"],
      createdAt: now,
      updatedAt: now,
      ...(input.parentArtifactRef === undefined
        ? {}
        : { parentArtifactRef: input.parentArtifactRef }),
    });
    this.#appendQueued(job);
    this.#pending.push(job.id);
    this.#work.set(String(job.id), {
      prompt: input.prompt,
      references,
      variantCount,
      ...(input.quality === undefined ? {} : { quality: input.quality }),
      ...(input.size === undefined ? {} : { size: input.size }),
      ...(input.aspectRatio === undefined ? {} : { aspectRatio: input.aspectRatio }),
      ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
    });
    this.#pump();
    return job;
  }

  async cancel(jobId: ImageJobId): Promise<ImageJob> {
    const job = this.#require(jobId);
    if (isImageJobTerminalStatus(job.status)) return job;
    if (job.status === "queued") {
      const index = this.#pending.indexOf(job.id);
      if (index >= 0) this.#pending.splice(index, 1);
      this.#work.delete(String(job.id));
      const next = this.#transition(job, "cancelled");
      this.#resolve(next);
      return next;
    }
    this.#abort.get(String(job.id))?.abort();
    return this.whenTerminal(jobId);
  }

  /**
   * A job still `running` after journal catch-up never re-enters the adapter.
   * The in-flight provider call died with the process and is not idempotent.
   */
  async reconcileInterruptedRunningJobs(): Promise<ReadonlyArray<ImageJob>> {
    const interrupted: Array<ImageJob> = [];
    for (const job of this.#projection.listRunning()) {
      const next = this.#transition(job, "failed", {
        recoveryReason: IMAGE_JOB_RESTART_INTERRUPTION_MESSAGE,
        failure: {
          category: "interrupted",
          message: IMAGE_JOB_RESTART_INTERRUPTION_MESSAGE,
        },
      });
      this.#resolve(next);
      interrupted.push(next);
    }
    return interrupted;
  }

  readonly #work = new Map<
    string,
    {
      readonly prompt: string;
      readonly references: NonNullable<ImageAdapterRequest["references"]>;
      readonly variantCount: number;
      readonly quality?: OpenAiImageQuality;
      readonly size?: OpenAiImageSize;
      readonly aspectRatio?: GeminiImageAspectRatio;
      readonly resolution?: GeminiImageResolution;
    }
  >();

  #defaultAdapter(instance: ProviderInstance): ImageGenerationAdapter {
    const options = {
      instanceId: instance.id,
      credentialResolver: this.#credentialResolver,
      ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
    };
    if (instance.configuration.kind === "openai-image-http") {
      return makeOpenAiImageAdapter(options);
    }
    if (instance.configuration.kind === "gemini-native-image-http") {
      return makeGeminiImageAdapter(options);
    }
    throw new ImageJobServiceError("ineligible", "The selected provider is not an image profile.");
  }

  #pump(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#running < this.#concurrency && this.#pending.length > 0) {
        const jobId = this.#pending.shift();
        if (jobId === undefined) break;
        const job = this.#projection.getById(jobId);
        if (job === undefined || job.status !== "queued") continue;
        this.#running += 1;
        void this.#run(job)
          .catch((error: unknown) => {
            this.#recordUnhandledFailure(job, error);
          })
          .finally(() => {
            this.#running -= 1;
            this.#pump();
          });
      }
    } finally {
      this.#pumping = false;
    }
  }

  async #run(queued: ImageJob): Promise<void> {
    const work = this.#work.get(String(queued.id));
    if (work === undefined) {
      const failed = this.#transition(queued, "failed", {
        failure: {
          category: "unavailable",
          message: "The image job was interrupted by restart.",
        },
      });
      this.#resolve(failed);
      return;
    }
    const running = this.#transition(queued, "running");
    const controller = new AbortController();
    this.#abort.set(String(running.id), controller);
    try {
      const instance = this.#readProviderInstance(running.profileInstanceId);
      if (instance === undefined) {
        const failed = this.#transition(running, "failed", {
          failure: {
            category: "invalid-configuration",
            message: "The image profile does not exist.",
          },
        });
        this.#resolve(failed);
        return;
      }
      const adapter = this.#createAdapter(instance);
      const request = this.#adapterRequest(instance, running, work, controller.signal);
      const result = await adapter.generate(request);
      if (controller.signal.aborted) {
        const cancelled = this.#transition(running, "cancelled");
        this.#resolve(cancelled);
        return;
      }
      if (result.status === "refused") {
        const failed = this.#transition(running, "failed", { safetyRefusal: result.safetyRefusal });
        this.#resolve(failed);
        return;
      }
      if (result.status === "failed") {
        const toStatus: ImageJobStatus =
          result.providerFailure.category === "interrupted" ? "cancelled" : "failed";
        const next =
          toStatus === "failed"
            ? this.#transition(running, toStatus, { failure: result.providerFailure })
            : this.#transition(running, toStatus);
        this.#resolve(next);
        return;
      }
      if (result.images.length > work.variantCount) {
        const failed = this.#transition(running, "failed", {
          failure: {
            category: "protocol",
            message: "The provider returned more images than requested.",
          },
        });
        this.#resolve(failed);
        return;
      }
      const artifacts = await this.#finalizeArtifacts(running, result.images);
      if (controller.signal.aborted) {
        await this.#removeArtifacts(running, artifacts);
        const cancelled = this.#transition(running, "cancelled");
        this.#resolve(cancelled);
        return;
      }
      try {
        const completed = this.#transition(running, "completed", { artifacts }, result);
        this.#resolve(completed);
      } catch (error) {
        await this.#removeArtifacts(running, artifacts);
        throw error;
      }
    } catch (error) {
      if (controller.signal.aborted) {
        const cancelled = this.#transition(running, "cancelled");
        this.#resolve(cancelled);
        return;
      }
      const failed = this.#transition(running, "failed", {
        failure: {
          category: "provider-failed",
          message: "The image job failed.",
        },
      });
      this.#resolve(failed);
      void error;
    } finally {
      this.#abort.delete(String(running.id));
      this.#work.delete(String(running.id));
    }
  }

  #adapterRequest(
    instance: ProviderInstance,
    job: ImageJob,
    work: {
      readonly prompt: string;
      readonly references: NonNullable<ImageAdapterRequest["references"]>;
      readonly variantCount: number;
      readonly quality?: OpenAiImageQuality;
      readonly size?: OpenAiImageSize;
      readonly aspectRatio?: GeminiImageAspectRatio;
      readonly resolution?: GeminiImageResolution;
    },
    signal: AbortSignal,
  ): ImageAdapterRequest {
    const request: ImageAdapterRequest = {
      instanceId: job.profileInstanceId,
      modelId: job.modelId,
      prompt: work.prompt,
      signal,
      variantCount: work.variantCount,
      ...(work.references.length === 0 ? {} : { references: work.references }),
    };
    if (instance.configuration.kind === "openai-image-http") {
      const configuration = (instance as OpenAiImageProviderInstance).configuration;
      const quality = work.quality ?? configuration.quality;
      const size = work.size ?? configuration.size;
      return {
        ...request,
        ...(quality === undefined ? {} : { quality }),
        ...(size === undefined ? {} : { size }),
      };
    }
    if (instance.configuration.kind === "gemini-native-image-http") {
      const configuration = (instance as GeminiImageProviderInstance).configuration;
      const aspectRatio = work.aspectRatio ?? configuration.aspectRatio;
      const resolution = work.resolution ?? configuration.resolution;
      return {
        ...request,
        ...(aspectRatio === undefined ? {} : { aspectRatio }),
        ...(resolution === undefined ? {} : { resolution }),
      };
    }
    return request;
  }

  async #finalizeArtifacts(
    job: ImageJob,
    images: ReadonlyArray<{ readonly bytes: Uint8Array; readonly mediaType: string }>,
  ): Promise<ReadonlyArray<ImageArtifactRecord>> {
    const stagedIds: Array<ImageJob["artifacts"][number]["attachmentId"]> = [];
    try {
      const records: Array<ImageArtifactRecord> = [];
      for (const [index, image] of images.entries()) {
        const attachmentId = decodeImageArtifactId(this.#uuid());
        stagedIds.push(attachmentId);
        const staged = await this.#attachments.stage({
          scopeId: job.scopeId,
          attachmentId,
          displayName: `generated-${index + 1}.png`,
          bytes: image.bytes,
        });
        const finalized = await this.#attachments.finalize(staged);
        records.push({
          attachmentId: finalized.attachmentId,
          hash: finalized.hash,
          size: finalized.size,
          mime: finalized.mime,
          evidence: {
            profileInstanceId: job.profileInstanceId,
            modelId: job.modelId,
            promptHash: job.promptHash,
            jobId: job.id,
            ...(job.parentArtifactRef === undefined
              ? {}
              : { parentArtifactRef: job.parentArtifactRef }),
          },
        });
      }
      return records;
    } catch (error) {
      await this.#removeArtifactIds(job, stagedIds);
      throw error;
    }
  }

  async #removeArtifacts(
    job: ImageJob,
    artifacts: ReadonlyArray<ImageArtifactRecord>,
  ): Promise<void> {
    await this.#removeArtifactIds(
      job,
      artifacts.map((artifact) => artifact.attachmentId),
    );
  }

  async #removeArtifactIds(
    job: ImageJob,
    attachmentIds: ReadonlyArray<ImageJob["artifacts"][number]["attachmentId"]>,
  ): Promise<void> {
    await Promise.all(
      attachmentIds.map((attachmentId) => this.#attachments.remove(job.scopeId, attachmentId)),
    );
  }

  #appendQueued(job: ImageJob): void {
    this.#append(job.id, 0, [
      {
        eventName: IMAGE_JOB_QUEUED,
        payload: { job },
        occurredAt: job.createdAt,
      },
    ]);
  }

  #transition(
    job: ImageJob,
    toStatus: ImageJobStatus,
    extras: {
      readonly recoveryReason?: string;
      readonly safetyRefusal?: string;
      readonly failure?: ImageJob["failure"];
      readonly artifacts?: ImageJob["artifacts"];
    } = {},
    adapterResult?: {
      readonly usage?: {
        readonly inputTokens?: number;
        readonly outputTokens?: number;
        readonly size?: string;
        readonly outputQuality?: string;
      };
    },
  ): ImageJob {
    assertImageJobTransitionAllowed(job.status, toStatus);
    assertImageJobExpectedVersion(job, job.version);
    const updatedAt = decodeUtcTimestamp(this.#clock());
    const includeUsage = toStatus === "completed" && extras.artifacts !== undefined;
    const version = includeUsage
      ? ((job.version + 2) as ImageJob["version"])
      : nextImageJobVersion(job.version);
    const payload = {
      jobId: job.id,
      fromStatus: job.status,
      toStatus,
      version,
      updatedAt,
      ...(extras.recoveryReason === undefined ? {} : { recoveryReason: extras.recoveryReason }),
      ...(extras.safetyRefusal === undefined ? {} : { safetyRefusal: extras.safetyRefusal }),
      ...(extras.failure === undefined ? {} : { failure: extras.failure }),
      ...(extras.artifacts === undefined ? {} : { artifacts: extras.artifacts }),
    };
    const events: Array<{
      readonly eventName: string;
      readonly payload: unknown;
      readonly occurredAt: UtcTimestamp;
    }> = [
      {
        eventName: IMAGE_JOB_STATUS_CHANGED,
        payload,
        occurredAt: updatedAt,
      },
    ];
    if (includeUsage && extras.artifacts !== undefined) {
      events.push({
        eventName: "context.usage-reconciled@1",
        payload: {
          reconciliation: this.#usageReconciliation(
            job,
            extras.artifacts,
            updatedAt,
            adapterResult,
          ),
        },
        occurredAt: updatedAt,
      });
    }
    this.#append(job.id, job.version, events);
    const next = this.#require(job.id);
    return next;
  }

  #usageReconciliation(
    job: ImageJob,
    artifacts: ImageJob["artifacts"],
    observedAt: UtcTimestamp,
    adapterResult:
      | {
          readonly usage?: {
            readonly inputTokens?: number;
            readonly outputTokens?: number;
            readonly size?: string;
            readonly outputQuality?: string;
          };
        }
      | undefined,
  ) {
    const inputTokens = adapterResult?.usage?.inputTokens ?? 0;
    const outputTokens = adapterResult?.usage?.outputTokens ?? 0;
    const size = adapterResult?.usage?.size;
    const outputQuality = adapterResult?.usage?.outputQuality;
    return {
      id: decodeUsageReconciliationId(this.#uuid()),
      providerInstanceId: job.profileInstanceId,
      modelId: job.modelId,
      requestShape: IMAGE_GENERATION_REQUEST_SHAPE,
      plannedInputTokens: inputTokens,
      actualInputTokens: inputTokens,
      actualOutputTokens: outputTokens,
      varianceTokens: 0,
      observedAt,
      imageUnits: {
        count: artifacts.length,
        quality: "exact" as const,
        ...(typeof size === "string" && size.length > 0 ? { size } : {}),
        ...(outputQuality === undefined ? {} : { outputQuality }),
      },
    };
  }

  #append(
    jobId: ImageJobId,
    expectedVersion: number,
    events: ReadonlyArray<{
      readonly eventName: string;
      readonly payload: unknown;
      readonly occurredAt: UtcTimestamp;
    }>,
  ): void {
    const aggregateId = decodeAggregateId(String(jobId));
    try {
      this.#journal.append({
        aggregate: { aggregateType: IMAGE_JOB_AGGREGATE_TYPE, aggregateId },
        expectedVersion: decodeAggregateVersion(expectedVersion),
        events: events.map((event) => ({
          eventId: decodeEventId(this.#uuid()),
          eventName: event.eventName,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: this.#actor,
          occurredAt: event.occurredAt,
          payload: event.payload,
        })),
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        throw new ImageJobServiceError(
          "conflict",
          "The image job changed before this update could be recorded.",
        );
      }
      throw error;
    }
  }

  #require(jobId: ImageJobId): ImageJob {
    const job = this.#projection.getById(jobId);
    if (job === undefined) {
      throw new ImageJobServiceError("invalid", "The image job does not exist.");
    }
    return job;
  }

  #recordUnhandledFailure(job: ImageJob, error: unknown): void {
    void error;
    const current = this.#projection.getById(job.id) ?? job;
    if (isImageJobTerminalStatus(current.status)) {
      this.#resolve(current);
      return;
    }
    try {
      const failed = this.#transition(current, "failed", {
        failure: {
          category: "provider-failed",
          message: "The image job failed.",
        },
      });
      this.#resolve(failed);
      this.#work.delete(String(job.id));
    } catch (journalError) {
      this.#rejectWaiters(
        job.id,
        journalError instanceof Error
          ? journalError
          : new ImageJobServiceError("conflict", "The image job failed."),
      );
    }
  }

  #rejectWaiters(jobId: ImageJobId, error: Error): void {
    const key = String(jobId);
    this.#terminalPersistenceErrors.set(key, error);
    const waiter = this.#waiters.get(key);
    if (waiter !== undefined) {
      waiter.reject(error);
      this.#waiters.delete(key);
    }
    this.#work.delete(key);
  }

  #deferred(jobId: ImageJobId): Deferred<ImageJob> {
    const key = String(jobId);
    const persistenceError = this.#terminalPersistenceErrors.get(key);
    if (persistenceError !== undefined) {
      return {
        promise: Promise.reject(persistenceError),
        resolve: () => undefined,
        reject: () => undefined,
      };
    }
    const existing = this.#waiters.get(key);
    if (existing !== undefined) return existing;
    let resolve: (job: ImageJob) => void = () => undefined;
    let reject: (reason: Error) => void = () => undefined;
    const promise = new Promise<ImageJob>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const deferred = { promise, resolve, reject };
    this.#waiters.set(key, deferred);
    return deferred;
  }

  #resolve(job: ImageJob): void {
    if (!isImageJobTerminalStatus(job.status)) return;
    const key = String(job.id);
    const waiter = this.#waiters.get(key);
    if (waiter === undefined) return;
    waiter.resolve(job);
    this.#waiters.delete(key);
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
}

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}
