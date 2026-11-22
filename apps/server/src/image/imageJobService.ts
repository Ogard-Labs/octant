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
  MAX_IMAGE_REFERENCES,
  MAX_IMAGE_VARIANTS,
  decodeImageArtifactId,
  decodeImageGenerationScopeId,
  decodeImageJob,
  decodeImageJobId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeSpendCeilingReservationId,
  decodeUsageReconciliationId,
  decodeUtcTimestamp,
  type GeminiImageAspectRatio,
  type GeminiImageResolution,
  type ImageArtifactId,
  type ImageArtifactMediaType,
  type ImageArtifactRecord,
  type ImageGenerationCustomSource,
  type ImageGenerationScopeId,
  type ImageJob,
  type ImageJobId,
  type ImageJobStatus,
  type ImageJobThreadKind,
  type OpenAiCompatibleProviderInstance,
  type OutsideImageProviderInstance,
  type OpenAiImageQuality,
  type OpenAiImageSize,
  type ProviderInstance,
  type ProviderDriverKind,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderModelId,
  type SpendCeilingRefusal,
  type SpendCeilingReservationId,
  type SpendCeilingThreadType,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  configuredImageBaseUrl,
  type ImageAdapterRequest,
  type ImageGenerationAdapter,
  type ImageGenerationDriver,
  type ImageGenerationPorts,
} from "@octant/provider-sdk/image-generation";
import {
  assertCustomImageSourceEligible,
  assertImageJobExpectedVersion,
  assertImageJobProfileEligible,
  assertImageJobTransitionAllowed,
  estimateImageGenerationCost,
  isImageJobTerminalStatus,
  isImageProfileDriverKind,
  nextImageJobVersion,
} from "@octant/domain";
import { admittedBundledImageDriverKinds } from "@octant/plugin-host/provider-drivers";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import type { ProviderCredentialResolver } from "../providers/credentialBrokerClient";
import type { SpendCeilingService } from "../spendCeilingService";
import { bflImageDriver } from "./bflImageAdapter";
import { geminiImageDriver } from "./geminiImageAdapter";
import {
  GeneratedImageInvalid,
  GeneratedImageTooLarge,
  type GeneratedImageStore,
} from "./generatedImageStore";
import { ideogramImageDriver } from "./ideogramImageAdapter";
import { makeImageGenerationPorts, type ImageHttpFetch } from "./imageHttp";
import { ImageJobProjection } from "./imageJobProjection";
import { openAiImageDriver } from "./openAiImageAdapter";
import { makeOpenAiCompatibleImageAdapter } from "./openAiCompatibleImageAdapter";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);

type JournalPort = Pick<Journal, "append">;

/** Image providers that ship in-tree but reach this service only through the image seam. */
const BUNDLED_IMAGE_DRIVERS: ReadonlyArray<ImageGenerationDriver> = [
  openAiImageDriver,
  geminiImageDriver,
  bflImageDriver,
  ideogramImageDriver,
];

/**
 * What a profile gets when its image driver plugin is disabled: every job
 * fails as unsupported instead of reaching the provider.
 */
const unavailableImageAdapter: ImageGenerationAdapter = {
  generate: async () => ({
    status: "failed",
    providerFailure: {
      category: "unsupported",
      message: "This image provider's plugin is not enabled.",
    },
  }),
};

export class ImageJobServiceError extends Error {
  override readonly name = "ImageJobServiceError";
  readonly category: "invalid" | "ineligible" | "conflict" | "spend-ceiling";
  readonly refusal?: SpendCeilingRefusal;

  constructor(
    category: ImageJobServiceError["category"],
    message: string,
    refusal?: SpendCeilingRefusal,
  ) {
    super(message);
    this.category = category;
    if (refusal !== undefined) this.refusal = refusal;
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

/**
 * How the job service reaches outside image drivers. Admission is decided by
 * the host per profile, at the package digest it binds; the price is the one
 * the trusted package declares, read by the host, never one a running driver
 * states.
 */
export interface OutsideImageDrivers {
  readonly admits: (instance: OutsideImageProviderInstance) => boolean;
  /**
   * The model as the package declares it at the profile's bound digest, with
   * its published price when it states one; `undefined` when the package does
   * not declare the model there, as after an update that removed it.
   */
  readonly declaredModel: (
    instance: OutsideImageProviderInstance,
    modelId: ProviderModelId,
  ) => { readonly usdMicrosPerImage?: number | undefined } | undefined;
  readonly adapter: (
    instance: OutsideImageProviderInstance,
    ports: Pick<ImageGenerationPorts, "fetchApprovedImageUrl" | "sniffMediaType">,
  ) => ImageGenerationAdapter;
}

export interface ImageJobServiceOptions {
  readonly journal: JournalPort;
  readonly projection: ImageJobProjection;
  readonly attachments: GeneratedImageStore;
  readonly readProviderInstance: (id: ProviderInstanceId) => ProviderInstance | undefined;
  readonly readImageGenerationCustomSources: () => ReadonlyArray<ImageGenerationCustomSource>;
  readonly credentialResolver: ProviderCredentialResolver;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly actor: typeof EventActor.Type;
  readonly fetch?: ImageHttpFetch;
  readonly createAdapter?: (instance: ProviderInstance) => ImageGenerationAdapter;
  /** Image providers that reach this service through the provider-sdk image seam. */
  readonly imageDrivers?: ReadonlyArray<ImageGenerationDriver>;
  /** Image driver kinds the plugin activation ladder admits; bundled policy by default. */
  readonly admittedImageDriverKinds?: ReadonlySet<ProviderDriverKind>;
  /** Absent on a host that admits no outside driver: every outside profile is refused. */
  readonly outsideImageDrivers?: OutsideImageDrivers;
  readonly concurrency?: number;
  /** Host spend ceilings applied to thread-scoped image generation before dispatch. */
  readonly spendCeiling?: Pick<SpendCeilingService, "admit" | "settle" | "abandon">;
  /** Resolves the thread's current Project id so Project ceilings apply alongside thread ceilings. */
  readonly resolveThreadProjectId?: (input: {
    readonly threadType: SpendCeilingThreadType;
    readonly threadId: string;
  }) => string | undefined;
}

interface QueuedImageWork {
  readonly prompt: string;
  readonly references: NonNullable<ImageAdapterRequest["references"]>;
  readonly variantCount: number;
  readonly estimatedCostUsdMicros: number | "unknown";
  /** An outside profile's declared price at enqueue, so settlement uses the price reserved. */
  readonly declaredUsdMicrosPerImage?: number;
  /** The outside driver digest the price was read at; dispatch refuses any other. */
  readonly outsideDriverDigest?: string;
  readonly quality?: OpenAiImageQuality;
  readonly size?: OpenAiImageSize;
  readonly aspectRatio?: GeminiImageAspectRatio;
  readonly resolution?: GeminiImageResolution;
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
  readonly #readImageGenerationCustomSources: ImageJobServiceOptions["readImageGenerationCustomSources"];
  readonly #credentialResolver: ProviderCredentialResolver;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #actor: typeof EventActor.Type;
  readonly #fetch: ImageHttpFetch | undefined;
  readonly #createAdapter: ((instance: ProviderInstance) => ImageGenerationAdapter) | undefined;
  readonly #imageDrivers: ReadonlyArray<ImageGenerationDriver>;
  readonly #admittedImageDriverKinds: ReadonlySet<ProviderDriverKind>;
  readonly #outsideImageDrivers: OutsideImageDrivers | undefined;
  readonly #concurrency: number;
  readonly #spendCeiling: ImageJobServiceOptions["spendCeiling"];
  readonly #resolveThreadProjectId: ImageJobServiceOptions["resolveThreadProjectId"];
  readonly #abort = new Map<string, AbortController>();
  readonly #waiters = new Map<string, Deferred<ImageJob>>();
  readonly #terminalPersistenceErrors = new Map<string, Error>();
  readonly #spendReservations = new Map<string, SpendCeilingReservationId>();
  readonly #pending = new Array<ImageJobId>();
  #running = 0;
  #pumping = false;

  constructor(options: ImageJobServiceOptions) {
    this.#journal = options.journal;
    this.#projection = options.projection;
    this.#attachments = options.attachments;
    this.#readProviderInstance = options.readProviderInstance;
    this.#readImageGenerationCustomSources = options.readImageGenerationCustomSources;
    this.#credentialResolver = options.credentialResolver;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#actor = decodeActor(options.actor);
    this.#fetch = options.fetch;
    this.#createAdapter = options.createAdapter;
    this.#imageDrivers = options.imageDrivers ?? BUNDLED_IMAGE_DRIVERS;
    this.#admittedImageDriverKinds =
      options.admittedImageDriverKinds ?? admittedBundledImageDriverKinds();
    this.#outsideImageDrivers = options.outsideImageDrivers;
    this.#concurrency = options.concurrency ?? IMAGE_JOB_HOST_CONCURRENCY;
    this.#spendCeiling = options.spendCeiling;
    this.#resolveThreadProjectId = options.resolveThreadProjectId;
    if (!Number.isSafeInteger(this.#concurrency) || this.#concurrency < 1) {
      throw new ImageJobServiceError(
        "invalid",
        "Image job concurrency must be a positive integer.",
      );
    }
  }

  /** Whether the host admits an outside image profile's driver now; false without outside drivers. */
  admitsOutsideDriver(instance: OutsideImageProviderInstance): boolean {
    return this.#outsideImageDrivers?.admits(instance) === true;
  }

  get(jobId: ImageJobId): ImageJob | undefined {
    return this.#projection.getById(jobId);
  }

  listByScope(scopeId: ImageGenerationScopeId): ReadonlyArray<ImageJob> {
    return this.#projection.listByScope(scopeId);
  }

  /**
   * The completed job that made an image, found by the image's attachment id.
   * A Canvas design names an image by that id alone; the caller decides from
   * the job's thread whether the reader may see it.
   */
  completedJobFor(attachmentId: ImageArtifactId): ImageJob | undefined {
    return this.#projection
      .list()
      .find(
        (job) =>
          job.status === "completed" &&
          job.artifacts.some((artifact) => String(artifact.attachmentId) === String(attachmentId)),
      );
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
    if ((input.references?.length ?? 0) > MAX_IMAGE_REFERENCES) {
      throw new ImageJobServiceError("invalid", "Use at most four image references.");
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
      if (instance.driverKind === "openai-compatible") {
        assertCustomImageSourceEligible(
          instance,
          input.modelId,
          this.#readImageGenerationCustomSources(),
        );
      } else {
        assertImageJobProfileEligible(instance, input.modelId);
      }
    } catch (error) {
      throw new ImageJobServiceError(
        "ineligible",
        error instanceof Error ? error.message : "The image profile is not eligible.",
      );
    }
    // Decided before anything is reserved or sent: an outside profile whose
    // package is not installed, trusted and enabled at its digest runs nothing.
    if (
      instance.driverKind === "outside-image" &&
      this.#outsideImageDrivers?.admits(instance) !== true
    ) {
      throw new ImageJobServiceError(
        "ineligible",
        "This image provider's driver is not available.",
      );
    }
    const declaredModel =
      instance.driverKind === "outside-image"
        ? this.#outsideImageDrivers?.declaredModel(instance, input.modelId)
        : undefined;
    if (instance.driverKind === "outside-image" && declaredModel === undefined) {
      throw new ImageJobServiceError(
        "ineligible",
        "This image provider's driver no longer offers that model.",
      );
    }
    const declaredUsdMicrosPerImage = declaredModel?.usdMicrosPerImage;
    const outsideDriverDigest =
      instance.driverKind === "outside-image"
        ? String(instance.configuration.driver.digest)
        : undefined;

    const scopeId = decodeImageGenerationScopeId(input.scopeId);
    // Freeze the effective profile options at enqueue time so changing profile
    // defaults while a job waits in the queue cannot dispatch a costlier
    // request than the reservation covered.
    const effectiveOptions = resolveEffectiveRequestOptions(instance, input);
    const estimate = estimateImageGenerationCost({
      driverKind: instance.driverKind,
      modelId: String(input.modelId),
      variantCount,
      ...(declaredUsdMicrosPerImage === undefined ? {} : { declaredUsdMicrosPerImage }),
      ...(effectiveOptions.quality === undefined ? {} : { quality: effectiveOptions.quality }),
      ...(effectiveOptions.size === undefined ? {} : { size: effectiveOptions.size }),
      ...(effectiveOptions.resolution === undefined
        ? {}
        : { resolution: effectiveOptions.resolution }),
    });
    const estimatedCostUsdMicros: number | "unknown" =
      estimate.kind === "api-estimate" ? estimate.usdMicros : "unknown";
    let reservationId: SpendCeilingReservationId | undefined;
    if (this.#spendCeiling !== undefined && input.threadKind !== "image-library") {
      const admittedProjectId = this.#resolveThreadProjectId?.({
        threadType: input.threadKind,
        threadId: String(scopeId),
      });
      const candidateReservationId = decodeSpendCeilingReservationId(this.#uuid());
      const admission = this.#spendCeiling.admit({
        reservationId: candidateReservationId,
        threadId: String(scopeId),
        threadType: input.threadKind,
        ...(admittedProjectId === undefined ? {} : { projectId: admittedProjectId }),
        countsAsTurn: false,
        skipTurnAndRunTimeCeiling: true,
        skipTokenCeiling: true,
        estimatedCostUsdMicros,
      });
      if (admission.status === "refused") {
        throw new ImageJobServiceError(
          "spend-ceiling",
          admission.refusal.message,
          admission.refusal,
        );
      }
      reservationId = candidateReservationId;
    }

    const now = decodeUtcTimestamp(this.#clock());
    const job = decodeImageJob({
      id: decodeImageJobId(this.#uuid()),
      status: "queued",
      threadKind: input.threadKind,
      scopeId,
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
    if (reservationId !== undefined) {
      this.#spendReservations.set(String(job.id), reservationId);
    }
    try {
      this.#appendQueued(job);
    } catch (error) {
      this.#finishSpendReservation(job.id, "abandon");
      throw error;
    }
    this.#pending.push(job.id);
    this.#work.set(String(job.id), {
      prompt: input.prompt,
      references,
      variantCount,
      estimatedCostUsdMicros,
      ...(declaredUsdMicrosPerImage === undefined ? {} : { declaredUsdMicrosPerImage }),
      ...(outsideDriverDigest === undefined ? {} : { outsideDriverDigest }),
      ...(effectiveOptions.quality === undefined ? {} : { quality: effectiveOptions.quality }),
      ...(effectiveOptions.size === undefined ? {} : { size: effectiveOptions.size }),
      ...(effectiveOptions.aspectRatio === undefined
        ? {}
        : { aspectRatio: effectiveOptions.aspectRatio }),
      ...(effectiveOptions.resolution === undefined
        ? {}
        : { resolution: effectiveOptions.resolution }),
    });
    this.#pump(job.id);
    return job;
  }

  /**
   * Records a completed job another of the person's computers ran, carried
   * here with a thread that moved, under the moved thread's scope. The job
   * ran and was billed there, so it reaches no provider and records no usage
   * here. It is journaled as queued, running, and completed in one unit, the
   * path every completed job took. A job already recorded under this id is
   * left as it is, so a finish asked again carries nothing twice.
   */
  async carryMovedJob(input: {
    readonly jobId: ImageJobId;
    readonly threadKind: ImageJobThreadKind;
    readonly scopeId: ImageGenerationScopeId;
    readonly profileInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
    readonly promptHash: ImageJob["promptHash"];
    readonly createdAt: UtcTimestamp;
    readonly updatedAt: UtcTimestamp;
    readonly images: ReadonlyArray<{
      readonly attachmentId: ImageArtifactId;
      readonly bytes: Uint8Array;
    }>;
  }): Promise<void> {
    if (this.#projection.getById(input.jobId) !== undefined) return;
    const queued = decodeImageJob({
      id: input.jobId,
      status: "queued",
      threadKind: input.threadKind,
      scopeId: input.scopeId,
      profileInstanceId: input.profileInstanceId,
      modelId: input.modelId,
      promptHash: input.promptHash,
      artifacts: [],
      version: 1,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
    const artifacts: Array<ImageArtifactRecord> = [];
    try {
      for (const image of input.images) {
        // An earlier try that stopped before journaling may have left the file.
        await this.#attachments.remove(queued.scopeId, image.attachmentId).catch(() => undefined);
        const finalized = await this.#attachments.finalize(
          await this.#attachments.stage({
            scopeId: queued.scopeId,
            attachmentId: image.attachmentId,
            displayName: "generated.png",
            bytes: image.bytes,
          }),
        );
        artifacts.push({
          attachmentId: finalized.attachmentId,
          hash: finalized.hash,
          size: finalized.size,
          mime: finalized.mime,
          evidence: {
            profileInstanceId: queued.profileInstanceId,
            modelId: queued.modelId,
            promptHash: queued.promptHash,
            jobId: queued.id,
          },
        });
      }
      const changed = (fromStatus: ImageJobStatus, toStatus: ImageJobStatus, version: number) => ({
        eventName: IMAGE_JOB_STATUS_CHANGED,
        payload: {
          jobId: queued.id,
          fromStatus,
          toStatus,
          version,
          updatedAt: input.updatedAt,
          ...(toStatus === "completed" ? { artifacts } : {}),
        },
        occurredAt: input.updatedAt,
      });
      this.#append(queued.id, 0, [
        { eventName: IMAGE_JOB_QUEUED, payload: { job: queued }, occurredAt: queued.createdAt },
        changed("queued", "running", 2),
        changed("running", "completed", 3),
      ]);
    } catch (error) {
      await this.#removeArtifacts(queued, artifacts);
      throw error;
    }
  }

  async cancel(jobId: ImageJobId): Promise<ImageJob> {
    const job = this.#require(jobId);
    if (isImageJobTerminalStatus(job.status)) return job;
    if (job.status === "queued") {
      const index = this.#pending.indexOf(job.id);
      if (index >= 0) this.#pending.splice(index, 1);
      this.#work.delete(String(job.id));
      const next = this.#transition(job, "cancelled");
      this.#finishSpendReservation(job.id, "abandon");
      this.#resolve(next);
      return next;
    }
    this.#abort.get(String(job.id))?.abort();
    return this.whenTerminal(jobId);
  }

  /**
   * A job still `running` after journal catch-up never re-enters the adapter.
   * The in-flight provider call died with the process and is not idempotent.
   * A job still `queued` cannot start either: its prompt was never journaled,
   * so this process has nothing to run and it would stay queued forever.
   */
  async reconcileInterruptedJobs(): Promise<ReadonlyArray<ImageJob>> {
    const interrupted: Array<ImageJob> = [];
    const unfinished = this.#projection
      .list()
      .filter((job) => job.status === "running" || job.status === "queued");
    for (const job of unfinished) {
      const next = this.#transition(job, "failed", {
        recoveryReason: IMAGE_JOB_RESTART_INTERRUPTION_MESSAGE,
        failure: {
          category: "interrupted",
          message: IMAGE_JOB_RESTART_INTERRUPTION_MESSAGE,
        },
      });
      this.#finishSpendReservation(job.id, "abandon");
      this.#resolve(next);
      interrupted.push(next);
    }
    return interrupted;
  }

  readonly #work = new Map<string, QueuedImageWork>();

  /**
   * The job's adapter, with a fetch that notes when the provider answered. A
   * job that failed or was refused after that may have been billed, so it is
   * recorded as unreported usage; one that failed before any answer spent
   * nothing and is not.
   */
  #adapterFor(instance: ProviderInstance, providerAnswered: () => void): ImageGenerationAdapter {
    if (this.#createAdapter !== undefined) return this.#createAdapter(instance);
    const send = this.#fetch;
    const fetch: ImageHttpFetch = async (input, init) => {
      const response = await (send ?? globalThis.fetch)(input, init);
      providerAnswered();
      return response;
    };
    return this.#defaultAdapter(instance, fetch);
  }

  #defaultAdapter(instance: ProviderInstance, fetch: ImageHttpFetch): ImageGenerationAdapter {
    if (instance.driverKind === "outside-image") {
      if (this.#outsideImageDrivers === undefined) return unavailableImageAdapter;
      // The driver reaches its provider only through the brokered call; the
      // host's own fetch and sniffing are what it gets of the image ports.
      const ports = makeImageGenerationPorts({
        instanceId: String(instance.id),
        credentialResolver: this.#credentialResolver,
        endpoint: { providerHosts: [], baseUrl: instance.configuration.baseUrl },
        fetch,
      });
      return this.#outsideImageDrivers.adapter(instance, {
        fetchApprovedImageUrl: ports.fetchApprovedImageUrl,
        sniffMediaType: ports.sniffMediaType,
      });
    }
    if (
      isImageProfileDriverKind(instance.driverKind) &&
      !this.#admittedImageDriverKinds.has(instance.driverKind)
    ) {
      return unavailableImageAdapter;
    }
    const driver = this.#imageDrivers.find(
      (candidate) => candidate.driverKind === instance.driverKind,
    );
    if (driver !== undefined) {
      const baseUrl = configuredImageBaseUrl(instance);
      return driver.create({
        instance,
        ports: makeImageGenerationPorts({
          instanceId: String(instance.id),
          credentialResolver: this.#credentialResolver,
          endpoint: {
            providerHosts: driver.providerHosts,
            ...(baseUrl === undefined ? {} : { baseUrl }),
          },
          fetch,
        }),
      });
    }
    if (instance.configuration.kind === "openai-compatible-http") {
      return makeOpenAiCompatibleImageAdapter({
        instance: instance as OpenAiCompatibleProviderInstance,
        credentialResolver: this.#credentialResolver,
        fetch,
      });
    }
    throw new ImageJobServiceError("ineligible", "The selected provider is not an image profile.");
  }

  #pump(justAdmittedJobId?: ImageJobId): void {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#running < this.#concurrency && this.#pending.length > 0) {
        const jobId = this.#pending.shift();
        if (jobId === undefined) break;
        const job = this.#projection.getById(jobId);
        if (job === undefined || job.status !== "queued") {
          this.#finishSpendReservation(jobId, "abandon");
          continue;
        }
        const recheckSpendCeiling =
          justAdmittedJobId === undefined || String(jobId) !== String(justAdmittedJobId);
        this.#running += 1;
        void this.#run(job, recheckSpendCeiling)
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

  async #run(queued: ImageJob, recheckSpendCeiling: boolean): Promise<void> {
    const work = this.#work.get(String(queued.id));
    if (work === undefined) {
      const failed = this.#transition(queued, "failed", {
        failure: {
          category: "unavailable",
          message: "The image job was interrupted by restart.",
        },
      });
      this.#finishSpendReservation(queued.id, "abandon");
      this.#resolve(failed);
      return;
    }
    const running = this.#transition(queued, "running");
    const controller = new AbortController();
    let reachedProvider = false;
    this.#abort.set(String(running.id), controller);
    let billedUsage: BilledImageUsage | undefined;
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
      // Any job that waited in `#pending` is re-admitted before provider
      // dispatch so newly installed/tightened ceilings or thread Project moves
      // always gate billed work, while reconciling queued peers in FIFO order.
      if (
        recheckSpendCeiling &&
        this.#spendCeiling !== undefined &&
        running.threadKind !== "image-library"
      ) {
        const currentProjectId = this.#resolveThreadProjectId?.({
          threadType: running.threadKind,
          threadId: String(running.scopeId),
        });
        const readmission = this.#reconcileQueuedJobsBeforeDispatch(
          running,
          work,
          currentProjectId,
        );
        if (readmission.status === "refused") {
          const failed = this.#transition(running, "failed", {
            failure: {
              category: "unauthorized",
              message: readmission.refusal.message,
            },
          });
          this.#resolve(failed);
          return;
        }
      }
      const outsideRefusal = this.#outsideDispatchRefusal(instance, running.modelId, work);
      if (outsideRefusal !== undefined) {
        const failed = this.#transition(running, "failed", {
          failure: { category: "invalid-configuration", message: outsideRefusal },
        });
        this.#resolve(failed);
        return;
      }
      const adapter = this.#adapterFor(instance, () => {
        reachedProvider = true;
      });
      const request = this.#adapterRequest(instance, running, work, controller.signal);
      const result = await adapter.generate(request);
      if (result.status === "completed" && result.images.length > 0) {
        billedUsage = {
          imageCount: Math.min(result.images.length, MAX_IMAGE_VARIANTS),
          adapterResult: result,
          pricingContext: {
            driverKind: instance.driverKind,
            ...(work.declaredUsdMicrosPerImage === undefined
              ? {}
              : { declaredUsdMicrosPerImage: work.declaredUsdMicrosPerImage }),
            ...(work.quality === undefined ? {} : { quality: work.quality }),
            ...(work.size === undefined ? {} : { size: work.size }),
            ...(work.resolution === undefined ? {} : { resolution: work.resolution }),
          },
        };
      }
      if (controller.signal.aborted) {
        const cancelled = this.#transition(running, "cancelled", {}, billedUsage);
        if (billedUsage !== undefined) this.#finishSpendReservation(running.id, "settle");
        this.#resolve(cancelled);
        return;
      }
      if (result.status === "refused") {
        const failed = this.#transition(running, "failed", {
          safetyRefusal: result.safetyRefusal,
          reachedProvider,
        });
        this.#resolve(failed);
        return;
      }
      if (result.status === "failed") {
        const toStatus: ImageJobStatus =
          result.providerFailure.category === "interrupted" ? "cancelled" : "failed";
        const next =
          toStatus === "failed"
            ? this.#transition(running, toStatus, {
                failure: result.providerFailure,
                reachedProvider,
              })
            : this.#transition(running, toStatus);
        this.#resolve(next);
        return;
      }
      if (result.images.length > work.variantCount) {
        const failed = this.#transition(
          running,
          "failed",
          {
            failure: {
              category: "protocol",
              message: "The provider returned more images than requested.",
            },
            reachedProvider,
          },
          billedUsage,
        );
        if (billedUsage !== undefined) this.#finishSpendReservation(running.id, "settle");
        this.#resolve(failed);
        return;
      }
      const artifacts = await this.#finalizeArtifacts(running, result.images);
      if (controller.signal.aborted) {
        await this.#removeArtifacts(running, artifacts);
        const cancelled = this.#transition(running, "cancelled", {}, billedUsage);
        if (billedUsage !== undefined) this.#finishSpendReservation(running.id, "settle");
        this.#resolve(cancelled);
        return;
      }
      try {
        // Record committed usage in the journal before releasing the spend
        // reservation so concurrent checks neither miss the charge nor count it twice.
        const completed = this.#transition(running, "completed", { artifacts }, billedUsage);
        this.#finishSpendReservation(running.id, "settle");
        this.#resolve(completed);
      } catch (error) {
        await this.#removeArtifacts(running, artifacts);
        throw error;
      }
    } catch (error) {
      if (controller.signal.aborted) {
        const cancelled = this.#transition(running, "cancelled", {}, billedUsage);
        if (billedUsage !== undefined) this.#finishSpendReservation(running.id, "settle");
        this.#resolve(cancelled);
        return;
      }
      const failed = this.#transition(
        running,
        "failed",
        {
          failure: storageOrGenericFailure(error),
          reachedProvider,
        },
        billedUsage,
      );
      if (billedUsage !== undefined) this.#finishSpendReservation(running.id, "settle");
      this.#resolve(failed);
    } finally {
      this.#finishSpendReservation(running.id, "abandon");
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
      return {
        ...request,
        ...(work.quality === undefined ? {} : { quality: work.quality }),
        ...(work.size === undefined ? {} : { size: work.size }),
      };
    }
    if (instance.configuration.kind === "gemini-native-image-http") {
      return {
        ...request,
        ...(work.aspectRatio === undefined ? {} : { aspectRatio: work.aspectRatio }),
        ...(work.resolution === undefined ? {} : { resolution: work.resolution }),
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
      /** The provider answered this job's request, so a failure may have been billed. */
      readonly reachedProvider?: boolean;
    } = {},
    billedUsage?: BilledImageUsage,
  ): ImageJob {
    assertImageJobTransitionAllowed(job.status, toStatus);
    assertImageJobExpectedVersion(job, job.version);
    const updatedAt = decodeUtcTimestamp(this.#clock());
    const includeUsage =
      billedUsage !== undefined ||
      (toStatus === "completed" && extras.artifacts !== undefined) ||
      (toStatus === "failed" && extras.reachedProvider === true);
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
    if (includeUsage) {
      // A job that failed after its provider answered but delivered no image
      // has no image to count; its row is unreported and unpriced.
      const imageCount = extras.artifacts?.length ?? billedUsage?.imageCount;
      events.push({
        eventName: "context.usage-reconciled@1",
        payload: {
          reconciliation: this.#usageReconciliation(
            job,
            imageCount,
            updatedAt,
            billedUsage?.adapterResult,
            billedUsage?.pricingContext,
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
    imageCount: number | undefined,
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
    pricingContext:
      | {
          readonly driverKind: ProviderDriverKind;
          readonly declaredUsdMicrosPerImage?: number;
          readonly quality?: OpenAiImageQuality;
          readonly size?: OpenAiImageSize;
          readonly resolution?: GeminiImageResolution;
        }
      | undefined,
  ) {
    const inputTokens = adapterResult?.usage?.inputTokens ?? 0;
    const outputTokens = adapterResult?.usage?.outputTokens ?? 0;
    const size = adapterResult?.usage?.size;
    const outputQuality = adapterResult?.usage?.outputQuality;
    const settledQuality = outputQuality ?? pricingContext?.quality;
    const settledSize = typeof size === "string" && size.length > 0 ? size : pricingContext?.size;
    const estimate =
      pricingContext === undefined || imageCount === undefined
        ? undefined
        : estimateImageGenerationCost({
            driverKind: pricingContext.driverKind,
            modelId: String(job.modelId),
            variantCount: imageCount,
            ...(pricingContext.declaredUsdMicrosPerImage === undefined
              ? {}
              : { declaredUsdMicrosPerImage: pricingContext.declaredUsdMicrosPerImage }),
            ...(settledQuality === undefined ? {} : { quality: settledQuality }),
            ...(settledSize === undefined ? {} : { size: settledSize }),
            ...(pricingContext.resolution === undefined
              ? {}
              : { resolution: pricingContext.resolution }),
          });
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
      // A provider that returns an image and no token counts has not measured
      // zero tokens: the row stays so the image is countable, classified
      // unavailable like every other request that completed without usage.
      ...(adapterResult?.usage?.inputTokens === undefined &&
      adapterResult?.usage?.outputTokens === undefined
        ? { providerReported: false }
        : {}),
      ...(estimate?.kind === "api-estimate"
        ? {
            cost: {
              kind: "api-estimate" as const,
              usdMicros: estimate.usdMicros,
            },
          }
        : {}),
      // A failed job made no image the person can count; its row carries
      // only what the provider reported, or nothing, unpriced.
      ...(imageCount === undefined
        ? {}
        : {
            imageUnits: {
              count: imageCount,
              quality: "exact" as const,
              ...(typeof size === "string" && size.length > 0 ? { size } : {}),
              ...(outputQuality === undefined ? {} : { outputQuality }),
            },
          }),
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
    this.#finishSpendReservation(job.id, "abandon");
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

  /**
   * Why an outside image job that waited in the queue must not run now, or
   * nothing. Its reservation was made at one driver digest and price; a
   * profile turned off, a driver no longer admitted, a newly trusted digest,
   * or a model the package no longer declares each refuse here, before any
   * process starts, and the reservation is released unspent.
   */
  #outsideDispatchRefusal(
    instance: ProviderInstance,
    modelId: ProviderModelId,
    work: QueuedImageWork,
  ): string | undefined {
    if (instance.driverKind !== "outside-image") return undefined;
    if (!instance.enabled) return "The image provider was turned off before this image started.";
    if (this.#outsideImageDrivers?.admits(instance) !== true) {
      return "This image provider's driver is not available.";
    }
    if (String(instance.configuration.driver.digest) !== work.outsideDriverDigest) {
      return "This image provider moved to another version of its driver after this image was queued. Create it again.";
    }
    if (this.#outsideImageDrivers.declaredModel(instance, modelId) === undefined) {
      return "This image provider's driver no longer offers that model.";
    }
    return undefined;
  }

  #finishSpendReservation(jobId: ImageJobId, outcome: "settle" | "abandon"): void {
    const key = String(jobId);
    const reservationId = this.#spendReservations.get(key);
    if (reservationId === undefined) return;
    this.#spendReservations.delete(key);
    if (outcome === "settle") {
      this.#spendCeiling?.settle({ reservationId });
    } else {
      this.#spendCeiling?.abandon({ reservationId });
    }
  }

  /**
   * Re-admits a queued job about to dispatch together with any later queued
   * jobs targeting the same current Project (or same thread) in FIFO order.
   * Releasing their existing queued reservations first ensures neither a later
   * oversized job nor a stale pre-move reservation can consume budget ahead of
   * an affordable earlier job, and ensures ceilings installed or tightened
   * while work waited in `#pending` gate dispatch before any provider call.
   */
  #reconcileQueuedJobsBeforeDispatch(
    running: ImageJob,
    work: QueuedImageWork,
    currentProjectId: string | undefined,
  ):
    | { readonly status: "admitted" }
    | { readonly status: "refused"; readonly refusal: SpendCeilingRefusal } {
    if (this.#spendCeiling === undefined || running.threadKind === "image-library") {
      return { status: "admitted" };
    }
    const affectedPending: Array<{
      readonly job: ImageJob;
      readonly threadType: SpendCeilingThreadType;
      readonly work: QueuedImageWork;
      readonly projectId: string | undefined;
    }> = [];
    for (const pendingId of this.#pending) {
      const pendingJob = this.#projection.getById(pendingId);
      if (
        pendingJob === undefined ||
        pendingJob.status !== "queued" ||
        pendingJob.threadKind === "image-library"
      ) {
        continue;
      }
      const pendingWork = this.#work.get(String(pendingId));
      if (pendingWork === undefined) continue;
      const pendingProjectId = this.#resolveThreadProjectId?.({
        threadType: pendingJob.threadKind,
        threadId: String(pendingJob.scopeId),
      });
      const sameProject = currentProjectId !== undefined && pendingProjectId === currentProjectId;
      const sameThread =
        pendingJob.threadKind === running.threadKind &&
        String(pendingJob.scopeId) === String(running.scopeId);
      if (sameProject || sameThread) {
        affectedPending.push({
          job: pendingJob,
          threadType: pendingJob.threadKind,
          work: pendingWork,
          projectId: pendingProjectId,
        });
      }
    }

    // Release queued reservations on the affected scope before re-admitting in FIFO order.
    this.#finishSpendReservation(running.id, "abandon");
    for (const entry of affectedPending) {
      this.#finishSpendReservation(entry.job.id, "abandon");
    }

    const runningReservationId = decodeSpendCeilingReservationId(this.#uuid());
    const runningAdmission = this.#spendCeiling.admit({
      reservationId: runningReservationId,
      threadId: String(running.scopeId),
      threadType: running.threadKind,
      ...(currentProjectId === undefined ? {} : { projectId: currentProjectId }),
      countsAsTurn: false,
      skipTurnAndRunTimeCeiling: true,
      skipTokenCeiling: true,
      estimatedCostUsdMicros: work.estimatedCostUsdMicros,
    });
    if (runningAdmission.status === "admitted") {
      this.#spendReservations.set(String(running.id), runningReservationId);
    }

    for (const entry of affectedPending) {
      const pendingReservationId = decodeSpendCeilingReservationId(this.#uuid());
      const pendingAdmission = this.#spendCeiling.admit({
        reservationId: pendingReservationId,
        threadId: String(entry.job.scopeId),
        threadType: entry.threadType,
        ...(entry.projectId === undefined ? {} : { projectId: entry.projectId }),
        countsAsTurn: false,
        skipTurnAndRunTimeCeiling: true,
        skipTokenCeiling: true,
        estimatedCostUsdMicros: entry.work.estimatedCostUsdMicros,
      });
      if (pendingAdmission.status === "admitted") {
        this.#spendReservations.set(String(entry.job.id), pendingReservationId);
      }
    }

    return runningAdmission.status === "refused"
      ? { status: "refused", refusal: runningAdmission.refusal }
      : { status: "admitted" };
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

interface BilledImageUsage {
  readonly imageCount: number;
  readonly adapterResult: {
    readonly usage?: {
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly size?: string;
      readonly outputQuality?: string;
    };
  };
  readonly pricingContext: {
    readonly driverKind: ProviderDriverKind;
    readonly declaredUsdMicrosPerImage?: number;
    readonly quality?: OpenAiImageQuality;
    readonly size?: OpenAiImageSize;
    readonly resolution?: GeminiImageResolution;
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
}

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function resolveEffectiveRequestOptions(
  instance: ProviderInstance,
  input: {
    readonly quality?: OpenAiImageQuality;
    readonly size?: OpenAiImageSize;
    readonly aspectRatio?: GeminiImageAspectRatio;
    readonly resolution?: GeminiImageResolution;
  },
): {
  readonly quality?: OpenAiImageQuality;
  readonly size?: OpenAiImageSize;
  readonly aspectRatio?: GeminiImageAspectRatio;
  readonly resolution?: GeminiImageResolution;
} {
  if (instance.configuration.kind === "openai-image-http") {
    const quality = input.quality ?? instance.configuration.quality;
    const size = input.size ?? instance.configuration.size;
    return {
      ...(quality === undefined ? {} : { quality }),
      ...(size === undefined ? {} : { size }),
    };
  }
  if (instance.configuration.kind === "gemini-native-image-http") {
    const aspectRatio = input.aspectRatio ?? instance.configuration.aspectRatio;
    const resolution = input.resolution ?? instance.configuration.resolution;
    return {
      ...(aspectRatio === undefined ? {} : { aspectRatio }),
      ...(resolution === undefined ? {} : { resolution }),
    };
  }
  return {};
}

/**
 * What the person is told when the job fails after the provider answered: a
 * full disk or a rejected image names its cause, anything else stays generic.
 * Only Octant-authored text reaches the journal, never the thrown message.
 */
function storageOrGenericFailure(error: unknown): ProviderFailure {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  if (code === "ENOSPC" || code === "EDQUOT") {
    return {
      category: "unavailable",
      message: "Octant could not store the image because the disk is full. Free space and retry.",
    };
  }
  if (error instanceof GeneratedImageInvalid || error instanceof GeneratedImageTooLarge) {
    return {
      category: "protocol",
      message: "The provider returned an image Octant cannot store (type, size, or dimensions).",
    };
  }
  return { category: "provider-failed", message: "The image job failed." };
}
