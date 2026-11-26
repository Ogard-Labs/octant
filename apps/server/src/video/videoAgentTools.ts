import { randomUUID } from "node:crypto";
import {
  MAX_VIDEO_REFERENCES,
  MAX_VIDEO_OFFER_PROFILE_NAME_LENGTH,
  type ImageGenerationSaveResult,
  type ImageGenerationScopeId,
  type ProviderInstance,
  type VideoClipOptions,
  type VideoGenerateOffer,
  type VideoJob,
  type VideoModelCapabilities,
  type VideoOfferImage,
  type VideoSaveOffer,
  type WindowId,
} from "@octant/contracts";
import { imageGenerationWithoutAsking } from "@octant/domain";
import type {
  MediaImageReferenceInput,
  MediaToolHostPort,
  MediaVideoGenerateOutcome,
  MediaVideoGenerateRequest,
  MediaVideoSaveOutcome,
  MediaVideoSaveRequest,
} from "@octant/plugin-api/media-tools";
import { CREATE_VIDEO_MEDIA_TOOL_PLUGIN } from "@octant/plugin-host/media-tools";
import {
  defaultVideoClipOptions,
  videoAspectRatioChoices,
  videoAudioChoices,
  videoDurationValues,
  type VideoRequestInputs,
} from "@octant/provider-sdk/video-generation";
import type { ImageJobService } from "../image/imageJobService";
import type { KeptImageGenerationChoices } from "../image/keptImageGenerationChoices";
import {
  describeImageSources,
  parseImageSourceRequests,
  readImageSources,
  type ImageSource,
  type ThreadImageSources,
} from "../image/threadImageSources";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { adaptMediaToolSet } from "../providers/mediaToolAdapter";
import {
  taintAppManagedToolResults,
  type TaintAppManagedToolResultsInput,
} from "../providers/appManagedToolTaint";
import type { EnqueueVideoJobInput, VideoJobService, VideoQuote } from "./videoJobService";
import type { VideoOfferOutcome } from "./videoOfferDecisionRules";
import type { VideoGenerationChoice, VideoOfferService } from "./videoOfferService";

/**
 * Most clips take minutes; a call waits this long, as an image call does, and
 * then answers that the clip is still generating. The clip appears in the
 * thread when it finishes.
 */
export const VIDEO_TOOL_WAIT_MS = 120_000;

type ThreadKind = "chat-thread" | "work-thread" | "code-thread";
type ReadyProfile = ReturnType<VideoJobService["readyProfilesNow"]>[number];
type AskOutcome = VideoOfferOutcome | { readonly status: "too-many-waiting" };

export interface VideoAgentToolPort {
  readonly jobs: Pick<
    VideoJobService,
    "readyProfilesNow" | "quote" | "enqueue" | "stop" | "whenTerminal" | "listByScope" | "readClip"
  >;
  readonly askGenerate: (
    offer: Omit<VideoGenerateOffer, "offerId" | "requestedAt" | "threadKind" | "scopeId">,
    signal: AbortSignal | undefined,
  ) => Promise<AskOutcome>;
  readonly askSave: (
    offer: Omit<VideoSaveOffer, "offerId" | "requestedAt" | "threadKind" | "scopeId">,
    signal: AbortSignal | undefined,
  ) => Promise<AskOutcome>;
  readonly remembered: () => VideoGenerationChoice | undefined;
  readonly asksAgain: () => boolean;
  readonly forget: () => void | Promise<void>;
  readonly fullAccess?: () => boolean;
  /** The video profile Settings names for Full access, read at each call; absent is none. */
  readonly defaultProfileInstanceId?: () => string | undefined;
  readonly unattended?: boolean;
  readonly refusal?: () => string | undefined;
  readonly imageSources?: ThreadImageSources;
  /** A finished generated image of this thread, for a frame or reference. */
  readonly generatedImage?: (attachmentId: string) => ImageSource | undefined;
  readonly waitMs?: number;
  readonly save?: {
    readonly posture: () => "refuse" | "ask" | "allow";
    readonly write: (relativePath: string, bytes: Uint8Array) => Promise<ImageGenerationSaveResult>;
  };
}

/**
 * App-managed video generation for one thread's turn, composed through the
 * public `CREATE_VIDEO_MEDIA_TOOL_PLUGIN` over a host-owned port. A call asks
 * on a card unless the Project keeps a choice or the thread is at Full
 * access, by the image rule (`imageGenerationWithoutAsking`); images always
 * need the card.
 */
export function createVideoAgentTools(options: {
  readonly threadKind: ThreadKind;
  readonly scopeId: ImageGenerationScopeId;
  readonly port: VideoAgentToolPort;
  readonly recordExternalContentIngestion: TaintAppManagedToolResultsInput["recordExternalContentIngestion"];
}): AppManagedToolSet | undefined {
  const { port } = options;
  const mediaPort: MediaToolHostPort = {
    turn: {
      mode:
        options.threadKind === "chat-thread"
          ? "chat"
          : options.threadKind === "work-thread"
            ? "work"
            : "code",
      hasFolder: port.save !== undefined,
      unattended: port.unattended === true,
      inPlan: () => false,
      allowed: () => true,
    },
    videoGeneration: {
      isAvailable: () => port.jobs.readyProfilesNow().length > 0,
      ...(port.refusal === undefined ? {} : { refusal: port.refusal }),
      describeModels: () => describeReadyModels(port.jobs.readyProfilesNow()),
      generate: (request) => generateVideo(options, request),
      ...(port.save === undefined ? {} : { save: (request) => saveVideo(options, request) }),
    },
  };
  const tools = CREATE_VIDEO_MEDIA_TOOL_PLUGIN.createTools(mediaPort);
  if (tools === undefined) return undefined;
  return taintAppManagedToolResults({
    tools: adaptMediaToolSet({ tools }),
    threadId: options.scopeId,
    recordExternalContentIngestion: options.recordExternalContentIngestion,
    uuid: randomUUID,
    // The host's status and save receipts do not deliver provider content.
    resultTaintsThread: (_call, result) =>
      typeof result === "object" &&
      result !== null &&
      "status" in result &&
      result.status === "completed",
  });
}

/** One line per ready model with what it declares, so the agent asks only for what can run. */
export function describeReadyModels(
  ready: ReadonlyArray<{
    readonly instance: Pick<ReadyProfile["instance"], "id" | "displayName">;
    readonly models: ReadyProfile["models"];
  }>,
): string {
  return ready
    .flatMap(({ instance, models }) =>
      models.map((model) => {
        const durations = videoDurationValues(model);
        const audio = videoAudioChoices(model);
        return [
          `${instance.displayName} (profileInstanceId ${String(instance.id)}) model ${String(model.modelId)}:`,
          `${String(durations[0])}-${String(durations[durations.length - 1])} s,`,
          `${model.resolutions.join("/")},`,
          `${videoAspectRatioChoices(model, true).join("/")},`,
          audio.length === 2
            ? "audio optional,"
            : audio[0] === true
              ? "always with audio,"
              : "no audio,",
          `first frame ${model.inputs.firstFrame ? "yes" : "no"}, last frame ${model.inputs.lastFrame ? "yes" : "no"},`,
          ...(model.inputs.maxDurationSecondsWithBothFrames === undefined
            ? []
            : [`up to ${model.inputs.maxDurationSecondsWithBothFrames} s with both frames,`]),
          `up to ${String(model.inputs.maxReferenceImages)} reference images.`,
        ].join(" ");
      }),
    )
    .join(" ");
}

type DescribedImage = {
  readonly label: string;
  readonly source: ImageSource;
  readonly signedIn?: true;
};
type DescribedImages = {
  readonly firstFrame?: DescribedImage;
  readonly lastFrame?: DescribedImage;
  readonly references: ReadonlyArray<DescribedImage>;
};

async function describeOne(
  port: VideoAgentToolPort,
  input: MediaImageReferenceInput,
): Promise<{ readonly label: string; readonly source: ImageSource } | { readonly error: string }> {
  const described = await describeMany(port, [input]);
  if ("error" in described) return described;
  const [only, ...rest] = described;
  if (only === undefined || rest.length > 0) {
    return { error: "A first or last frame must name exactly one image." };
  }
  return only;
}

async function describeMany(
  port: VideoAgentToolPort,
  inputs: ReadonlyArray<MediaImageReferenceInput>,
): Promise<
  | ReadonlyArray<{ readonly label: string; readonly source: ImageSource }>
  | { readonly error: string }
> {
  if (inputs.length === 0) return [];
  const requests = parseImageSourceRequests(inputs, MAX_VIDEO_REFERENCES);
  if ("error" in requests) return requests;
  const described = await describeImageSources(
    requests,
    port.imageSources,
    (id) => port.generatedImage?.(id),
    MAX_VIDEO_REFERENCES,
  );
  if ("error" in described) return described;
  return described.map(({ reference, source }) => ({
    label: reference.label,
    source,
    ...(reference.signedIn === true ? { signedIn: true as const } : {}),
  }));
}

async function describeImages(
  port: VideoAgentToolPort,
  request: MediaVideoGenerateRequest,
): Promise<DescribedImages | { readonly error: string }> {
  const firstFrame =
    request.firstFrame === undefined ? undefined : await describeOne(port, request.firstFrame);
  if (firstFrame !== undefined && "error" in firstFrame) return firstFrame;
  const lastFrame =
    request.lastFrame === undefined ? undefined : await describeOne(port, request.lastFrame);
  if (lastFrame !== undefined && "error" in lastFrame) return lastFrame;
  const references = await describeMany(port, request.references);
  if ("error" in references) return references;
  return {
    ...(firstFrame === undefined ? {} : { firstFrame }),
    ...(lastFrame === undefined ? {} : { lastFrame }),
    references,
  };
}

function offerImages(images: DescribedImages): ReadonlyArray<VideoOfferImage> {
  const entry = (role: VideoOfferImage["role"], image: DescribedImage): VideoOfferImage => ({
    role,
    label: image.label,
    ...(image.signedIn === true ? { signedIn: true as const } : {}),
  });
  return [
    ...(images.firstFrame === undefined ? [] : [entry("first-frame", images.firstFrame)]),
    ...(images.lastFrame === undefined ? [] : [entry("last-frame", images.lastFrame)]),
    ...images.references.map((image) => entry("reference", image)),
  ];
}

function imageCounts(images: DescribedImages) {
  return {
    firstFrame: images.firstFrame !== undefined,
    lastFrame: images.lastFrame !== undefined,
    referenceCount: images.references.length,
  };
}

/** The images' size as described; the queue checks the bytes actually read. */
function imageBytes(images: DescribedImages): number {
  return [images.firstFrame, images.lastFrame, ...images.references].reduce(
    (sum, image) => sum + (image?.source.size ?? 0),
    0,
  );
}

/** The profiles in the shape the image rule reads: id, models, and the first declared model as default. */
function asChoiceProfiles(ready: ReadonlyArray<ReadyProfile>) {
  return ready.flatMap(({ instance, models }) => {
    const [first] = models;
    return first === undefined
      ? []
      : [
          {
            instanceId: instance.id,
            modelAllowlist: models.map((model) => model.modelId),
            defaultModel: first.modelId,
          },
        ];
  });
}

function findModel(
  ready: ReadonlyArray<ReadyProfile>,
  choice: VideoGenerationChoice,
): { readonly instance: ProviderInstance; readonly model: VideoModelCapabilities } | undefined {
  const profile = ready.find(
    ({ instance }) => String(instance.id) === String(choice.profileInstanceId),
  );
  const model = profile?.models.find(
    (candidate) => String(candidate.modelId) === String(choice.modelId),
  );
  return profile === undefined || model === undefined
    ? undefined
    : { instance: profile.instance, model };
}

/** The agent's options over the model's defaults; the quote checks every one against the declaration. */
function requestedOptions(
  model: VideoModelCapabilities,
  request: MediaVideoGenerateRequest,
  frames: Pick<VideoRequestInputs, "firstFrame" | "lastFrame">,
): VideoClipOptions | undefined {
  const defaults = defaultVideoClipOptions(model, frames.firstFrame, frames.lastFrame);
  if (defaults === undefined) return undefined;
  return {
    durationSeconds: request.durationSeconds ?? defaults.durationSeconds,
    resolution: request.resolution ?? defaults.resolution,
    aspectRatio: request.aspectRatio ?? defaults.aspectRatio,
    audio: request.audio ?? defaults.audio,
  };
}

async function generateVideo(
  options: {
    readonly threadKind: ThreadKind;
    readonly scopeId: ImageGenerationScopeId;
    readonly port: VideoAgentToolPort;
  },
  request: MediaVideoGenerateRequest,
): Promise<MediaVideoGenerateOutcome> {
  const { port } = options;
  const { signal } = request;
  const ready = port.jobs.readyProfilesNow();
  if (ready.length === 0) return { status: "refused", error: "No video profile is ready." };
  const images = await describeImages(port, request);
  if ("error" in images) return { status: "refused", error: images.error };
  const counts = imageCounts(images);
  const withImages = offerImages(images).length > 0;
  if (signal?.aborted) return { status: "cancelled", reason: "aborted" };

  // A kept model is not permission to share these particular images.
  const unasked = imageGenerationWithoutAsking({
    profiles: asChoiceProfiles(ready),
    kept: withImages ? undefined : port.remembered(),
    fullAccess: !withImages && port.fullAccess?.() === true,
    askAgain: port.asksAgain(),
    defaultProfileInstanceId: port.defaultProfileInstanceId?.(),
  });
  if (unasked.kind === "ask" && unasked.keptUnavailable) await port.forget();

  const suggestedProfile =
    request.profileInstanceId === undefined
      ? ready[0]
      : ready.find(({ instance }) => String(instance.id) === String(request.profileInstanceId));
  const suggestedModel = request.modelId ?? suggestedProfile?.models[0]?.modelId;
  const suggested: VideoGenerationChoice | undefined =
    unasked.kind === "generate"
      ? unasked.choice
      : suggestedProfile === undefined || suggestedModel === undefined
        ? undefined
        : { profileInstanceId: suggestedProfile.instance.id, modelId: suggestedModel };
  const found = suggested === undefined ? undefined : findModel(ready, suggested);
  if (found === undefined) {
    return { status: "refused", error: "That video profile or model is not ready." };
  }
  const proposed = requestedOptions(found.model, request, counts);
  if (proposed === undefined) {
    return { status: "refused", error: `${found.model.displayName} declares no usable options.` };
  }
  const quoteFor = (clip: VideoClipOptions): Promise<VideoQuote> =>
    port.jobs.quote({
      profileInstanceId: found.instance.id,
      modelId: found.model.modelId,
      prompt: request.prompt,
      options: clip,
      ...counts,
      imageBytes: imageBytes(images),
      ...(signal === undefined ? {} : { signal }),
    });
  const first = await quoteFor(proposed);
  if (signal?.aborted) return { status: "cancelled", reason: "aborted" };
  if (first.status === "refused") return { status: "refused", error: first.reason };

  let clip = proposed;
  if (unasked.kind === "ask") {
    if (port.unattended === true) {
      return {
        status: "refused",
        error:
          "Nobody is at this thread to approve a video clip, and its Project keeps no choice that can run. Do not try again in this turn.",
      };
    }
    const answer = await port.askGenerate(
      {
        kind: "video-generate",
        prompt: request.prompt,
        images: offerImages(images),
        profileInstanceId: found.instance.id,
        profileName: first.profileName.slice(0, MAX_VIDEO_OFFER_PROFILE_NAME_LENGTH).trimEnd(),
        providerName: first.providerName,
        model: first.model,
        options: proposed,
        canRemember: !withImages,
      },
      signal,
    );
    if (answer.status === "too-many-waiting") {
      return { status: "refused", error: "Too many requests are waiting for an answer." };
    }
    if (answer.status !== "video-generate") return { status: "cancelled", reason: "declined" };
    clip = answer.options;
  }

  // The answer can arrive minutes later: the turn's standing and the
  // profile are read again before anything is reserved or sent.
  const refusalNow = port.refusal?.();
  if (refusalNow !== undefined) return { status: "refused", error: refusalNow };
  const final = await quoteFor(clip);
  if (signal?.aborted) return { status: "cancelled", reason: "aborted" };
  if (final.status === "refused") return { status: "refused", error: final.reason };

  try {
    const read = async (source: ImageSource | undefined) => {
      if (source === undefined) return undefined;
      const result = await readImageSources(
        [{ source, reference: { kind: "file", label: source.label } }],
        signal,
      );
      if ("error" in result) throw new Error(result.error);
      return result[0];
    };
    const firstFrame = await read(images.firstFrame?.source);
    const lastFrame = await read(images.lastFrame?.source);
    const references = await readImageSources(
      images.references.map(({ source }) => ({
        source,
        reference: { kind: "file" as const, label: source.label },
      })),
      signal,
    );
    if ("error" in references) return { status: "refused", error: references.error };
    if (signal?.aborted) return { status: "cancelled", reason: "aborted" };
    // The reads above can take seconds: the turn's standing is read once
    // more before the paid job is queued, so a thread that moved to Plan
    // while an image loaded spends nothing.
    const refusalBeforeEnqueue = port.refusal?.();
    if (refusalBeforeEnqueue !== undefined) {
      return { status: "refused", error: refusalBeforeEnqueue };
    }
    const input: EnqueueVideoJobInput = {
      threadKind: options.threadKind,
      scopeId: options.scopeId,
      profileInstanceId: found.instance.id,
      modelId: found.model.modelId,
      prompt: request.prompt,
      options: clip,
      references,
      ...(first.outsideTerms === undefined ? {} : { outsideTerms: first.outsideTerms }),
      ...(signal === undefined ? {} : { signal }),
      ...(firstFrame === undefined ? {} : { firstFrame }),
      ...(lastFrame === undefined ? {} : { lastFrame }),
    };
    const job = await port.jobs.enqueue(input);
    return await settledOutcome(port, job, signal);
  } catch (error) {
    if (signal?.aborted) return { status: "cancelled", reason: "aborted" };
    return {
      status: "refused",
      error: error instanceof Error ? error.message : "The video job could not be started.",
    };
  }
}

async function settledOutcome(
  port: VideoAgentToolPort,
  queued: VideoJob,
  signal: AbortSignal | undefined,
): Promise<MediaVideoGenerateOutcome> {
  const generating: MediaVideoGenerateOutcome = {
    status: "generating",
    jobId: queued.id,
    modelId: queued.modelId,
    profileInstanceId: queued.profileInstanceId,
  };
  const job = await waitForTerminal(
    port.jobs.whenTerminal(queued.id),
    port.waitMs ?? VIDEO_TOOL_WAIT_MS,
    signal,
  );
  if (job === undefined) {
    // A stopped turn owes the provider a cancel; a timed-out wait leaves the
    // job running and answers "generating" so it can be picked up later.
    if (signal?.aborted) port.jobs.stop(queued.id);
    return generating;
  }
  if (job.status === "cancelled") {
    return { status: "cancelled", jobId: job.id, reason: "job-cancelled" };
  }
  if (job.status !== "completed" || job.clip === undefined) {
    return job.status === "queued" || job.status === "running"
      ? generating
      : {
          status: "failed",
          jobId: job.id,
          message: job.safetyRefusal ?? job.failure?.message ?? "The clip could not be made.",
        };
  }
  return {
    status: "completed",
    jobId: job.id,
    clipId: job.clip.clipId,
    modelId: job.modelId,
    profileInstanceId: job.profileInstanceId,
    durationSeconds: job.clip.durationSeconds,
    resolution: job.clip.resolution,
    sizeBytes: job.clip.size,
  };
}

function waitForTerminal(
  terminal: Promise<VideoJob | undefined>,
  waitMs: number,
  signal: AbortSignal | undefined,
): Promise<VideoJob | undefined> {
  if (signal?.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const finish = (job: VideoJob | undefined) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(job);
    };
    const onAbort = () => finish(undefined);
    const timer = setTimeout(() => finish(undefined), waitMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    terminal.then(finish, () => finish(undefined));
  });
}

/**
 * Saves a clip this thread made as a new file under the turn's folder, at
 * the turn's level as any file edit: Plan refuses, a level that asks before
 * edits shows a card naming the path, and one that lets edits through writes
 * at once. The write is confined to the folder and never overwrites.
 */
async function saveVideo(
  options: {
    readonly scopeId: ImageGenerationScopeId;
    readonly threadKind: ThreadKind;
    readonly port: VideoAgentToolPort;
  },
  request: MediaVideoSaveRequest,
): Promise<MediaVideoSaveOutcome> {
  const { port } = options;
  const save = port.save;
  if (save === undefined) {
    return { status: "refused", error: "This thread has no folder to save into." };
  }
  const job = port.jobs
    .listByScope(options.scopeId)
    .find(
      (candidate) =>
        candidate.threadKind === options.threadKind &&
        ("jobId" in request
          ? String(candidate.id) === String(request.jobId)
          : String(candidate.clip?.clipId) === String(request.clipId)),
    );
  if (job?.status === "queued" || job?.status === "running") {
    return { status: "refused", error: "That job is still making its clip." };
  }
  if (job === undefined || job.status !== "completed" || job.clip === undefined) {
    return { status: "refused", error: "That clip is not a finished clip of this thread." };
  }
  if (save.posture() === "refuse")
    return { status: "refused", error: "Plan mode cannot save files." };
  const bytes = await port.jobs.readClip(job).catch(() => undefined);
  if (bytes === undefined) return { status: "refused", error: "The clip is unavailable." };
  const aborted = (): boolean => request.signal?.aborted === true;
  if (aborted()) return { status: "not-saved" };
  // The level is read again after every wait, so a thread lowered while the
  // clip was read or the card was open is refused or asked, never written on
  // the level it had when the call began.
  let confirmed = false;
  for (;;) {
    const posture = save.posture();
    if (posture === "refuse") return { status: "refused", error: "Plan mode cannot save files." };
    if (posture === "allow" || confirmed) break;
    // A routine's host scope has no client to answer a save card.
    if (port.unattended === true) {
      return { status: "refused", error: "Nobody is at this thread to approve a save." };
    }
    const answer = await port.askSave(
      {
        kind: "video-save",
        jobId: job.id,
        clipId: job.clip.clipId,
        relativePath: request.relativePath,
        sizeBytes: job.clip.size,
      },
      request.signal,
    );
    if (answer.status !== "video-save") return { status: "not-saved" };
    confirmed = true;
  }
  if (aborted()) return { status: "not-saved" };
  const saved = await save.write(request.relativePath, bytes);
  return saved.status === "saved"
    ? { status: "saved", relativePath: saved.relativePath }
    : { status: "refused", error: saved.reason };
}

/**
 * The video tool for one thread's turn, asking as the window whose turn it
 * is. A turn the host runs as itself is offered the tool only where the
 * Project keeps a choice, since nobody could answer its card.
 */
export function createThreadVideoAgentTools(input: {
  readonly windowId: WindowId;
  readonly threadKind: ThreadKind;
  readonly scopeId: ImageGenerationScopeId;
  readonly offers: Pick<VideoOfferService, "offerGenerate" | "offerSave">;
  readonly kept: Pick<KeptImageGenerationChoices, "remembered" | "forget" | "asksAgain">;
  readonly jobs: VideoAgentToolPort["jobs"];
  readonly recordExternalContentIngestion: TaintAppManagedToolResultsInput["recordExternalContentIngestion"];
  readonly unattended?: boolean;
  readonly fullAccess?: () => boolean;
  readonly defaultProfileInstanceId?: () => string | undefined;
  readonly refusal?: () => string | undefined;
  readonly imageSources?: ThreadImageSources;
  /** The thread's image jobs, so a finished generated image can be a frame or reference. */
  readonly imageJobs?: Pick<ImageJobService, "listByScope" | "readArtifact">;
  readonly save?: VideoAgentToolPort["save"];
}): AppManagedToolSet | undefined {
  const scope = { threadKind: input.threadKind, scopeId: input.scopeId };
  if (input.unattended === true && input.kept.remembered(scope) === undefined) return undefined;
  const withSignal = (signal: AbortSignal | undefined) => (signal === undefined ? {} : { signal });
  return createVideoAgentTools({
    ...scope,
    recordExternalContentIngestion: input.recordExternalContentIngestion,
    port: {
      jobs: input.jobs,
      askGenerate: (offer, signal) =>
        input.offers.offerGenerate({
          windowId: input.windowId,
          offer: { ...offer, ...scope },
          ...withSignal(signal),
        }),
      askSave: async (offer, signal) =>
        // A Chat thread has no folder, so it is never asked to save.
        scope.threadKind === "chat-thread"
          ? { status: "cancelled" }
          : input.offers.offerSave({
              windowId: input.windowId,
              offer: { ...offer, threadKind: scope.threadKind, scopeId: scope.scopeId },
              ...withSignal(signal),
            }),
      remembered: () => input.kept.remembered(scope),
      asksAgain: () => input.kept.asksAgain(scope),
      forget: () => input.kept.forget(scope),
      ...(input.fullAccess === undefined ? {} : { fullAccess: input.fullAccess }),
      ...(input.defaultProfileInstanceId === undefined
        ? {}
        : { defaultProfileInstanceId: input.defaultProfileInstanceId }),
      ...(input.unattended === true ? { unattended: true } : {}),
      ...(input.refusal === undefined ? {} : { refusal: input.refusal }),
      ...(input.imageSources === undefined ? {} : { imageSources: input.imageSources }),
      ...(input.imageJobs === undefined
        ? {}
        : { generatedImage: generatedImageOf(input.imageJobs, scope) }),
      ...(input.save === undefined || scope.threadKind === "chat-thread"
        ? {}
        : { save: input.save }),
    },
  });
}

/** A finished image this thread generated, by attachment id, read only when the clip is sent. */
function generatedImageOf(
  jobs: Pick<ImageJobService, "listByScope" | "readArtifact">,
  scope: { readonly threadKind: ThreadKind; readonly scopeId: ImageGenerationScopeId },
): (attachmentId: string) => ImageSource | undefined {
  return (attachmentId) => {
    for (const job of jobs.listByScope(scope.scopeId)) {
      if (job.status !== "completed" || job.threadKind !== scope.threadKind) continue;
      const artifact = job.artifacts.find(
        (candidate) => String(candidate.attachmentId) === attachmentId,
      );
      if (artifact === undefined) continue;
      return {
        label: "generated image",
        size: artifact.size,
        read: async () => (await jobs.readArtifact(job.id, artifact.attachmentId))?.bytes,
      };
    }
    return undefined;
  };
}
