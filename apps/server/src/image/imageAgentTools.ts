import {
  decodeImageArtifactId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  MAX_IMAGE_PROMPT_CHARACTERS,
  MAX_IMAGE_VARIANTS,
  type ImageGenerationCustomSource,
  type ImageGenerationOffer,
  type ImageGenerationProfileView,
  type ImageGenerationScopeId,
  type ImageJob,
  type ProviderInstance,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderToolImage,
  type WindowId,
} from "@octant/contracts";
import { hasEligibleImageProfile, listEligibleImageProfiles } from "@octant/domain";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type {
  ImageGenerationChoice,
  ImageGenerationOfferOutcome,
  ImageGenerationOfferService,
} from "./imageGenerationOfferService";
import type { EnqueueImageJobInput, ImageJobService } from "./imageJobService";

export const IMAGE_TOOL_NAME = "octant_create_image";

const imageToolInputSchema = {
  type: "object",
  properties: {
    prompt: { type: "string" },
    profileInstanceId: { type: "string" },
    modelId: { type: "string" },
    variantCount: { type: "number" },
    parentAttachmentId: { type: "string" },
  },
  required: ["prompt"],
} as const;

const FORBIDDEN_INPUT_KEYS = [
  "apiKey",
  "credential",
  "credentials",
  "endpoint",
  "baseUrl",
  "header",
  "headers",
  "path",
  "filePath",
  "canonicalRoot",
] as const;

export interface ImageAgentToolPort {
  readonly listInstances: () => ReadonlyArray<ProviderInstance>;
  readonly readImageGenerationCustomSources: () => ReadonlyArray<ImageGenerationCustomSource>;
  readonly enqueue: (input: EnqueueImageJobInput) => Promise<ImageJob>;
  readonly listJobs: ImageJobService["listByScope"];
  /**
   * Asks the person in the thread whether to generate, and with which profile
   * and model. Required: every mode asks, because a generation spends money
   * on the person's image provider.
   */
  readonly ask: (input: {
    readonly offer: Omit<
      ImageGenerationOffer,
      "offerId" | "requestedAt" | "threadKind" | "scopeId"
    >;
    readonly signal?: AbortSignal;
  }) => Promise<ImageGenerationOfferOutcome>;
  /** The choice the person told this thread to keep using without asking. */
  readonly remembered: () => ImageGenerationChoice | undefined;
  readonly forget: () => void;
  /** Why this turn may not generate at all, such as Plan mode; undefined allows it. */
  readonly refusal?: () => string | undefined;
  /**
   * Waits for a queued job to finish so the agent can see what it made. Absent
   * means the call answers as soon as the job is queued.
   */
  readonly whenTerminal?: (jobId: ImageJob["id"]) => Promise<ImageJob>;
  readonly readArtifact?: ImageJobService["readArtifact"];
  /** Whether the model driving this turn accepts images in a tool result. */
  readonly readsImages?: () => boolean;
  /** How long a call waits for its image before answering that it is still generating. */
  readonly waitMs?: number;
}

/**
 * Most generations finish well inside this; a slower one is reported as still
 * generating rather than holding the turn open for the provider's full time.
 */
export const IMAGE_TOOL_WAIT_MS = 120_000;

/** The provider image channel's own bound on one image's base64 text. */
const MAX_TOOL_IMAGE_BASE64_LENGTH = 2_097_152;

interface ImageToolInput {
  readonly prompt: string;
  readonly profileInstanceId?: ProviderInstanceId;
  readonly modelId?: ProviderModelId;
  readonly variantCount?: number;
  readonly parentAttachmentId?: string;
}

const DESCRIPTION =
  "Generate or revise a picture (a photo, illustration, or rendered scene) with an image model the person set up in Octant. Call it when the person asks for an image instead of drawing one yourself as SVG, HTML, or CSS: a real image model gives a far better result. Keep SVG for logos, icons, and diagrams, or when the person asks for it. Octant shows the person a card in this thread where they pick the model and confirm, because each generation is billed to their image provider; nothing runs until they answer. Describe the image in prompt; profileInstanceId and modelId only suggest what the card preselects. To revise, pass parentAttachmentId from a completed image on this thread. Never pass credentials, endpoints, headers, or filesystem paths. The result says what happened: completed with each image's attachmentId (the images are shown in this thread, and to you when you can read images; use an attachmentId to revise one or to place it in a Canvas design as a generated-image asset), failed with the reason, generating with a jobId when it takes longer than the call waits (it appears in this thread when done; do not start another), agent-draws (the person wants you to make the visual yourself), or cancelled (do not ask again unless they do). Never invent an image URL.";

/**
 * App-managed image generation for a Chat, Work, or Code thread.
 *
 * Present only while Settings has an enabled image profile. Every call asks
 * the person, in the thread, before a job is queued, unless they told this
 * thread not to ask again; the job runs on the profile and model they chose.
 * The tool still refuses credentials, endpoints, and filesystem paths.
 */
export function createImageAgentTools(options: {
  readonly threadKind: "chat-thread" | "work-thread" | "code-thread";
  readonly scopeId: ImageGenerationScopeId;
  readonly port: ImageAgentToolPort;
}): AppManagedToolSet | undefined {
  const instances = options.port.listInstances();
  const customSources = options.port.readImageGenerationCustomSources();
  if (!hasEligibleImageProfile(instances, customSources)) return undefined;
  return {
    definitions: [
      { name: IMAGE_TOOL_NAME, description: DESCRIPTION, inputSchema: imageToolInputSchema },
    ],
    execute: async ({ name, inputJson, signal }) => {
      if (name !== IMAGE_TOOL_NAME) {
        return { result: { error: "tool-unavailable" }, isError: true };
      }
      const refusal = options.port.refusal?.();
      if (refusal !== undefined) return { result: { error: refusal }, isError: true };
      const parsed = parseInput(inputJson);
      if ("error" in parsed) return { result: { error: parsed.error }, isError: true };

      const profiles = eligibleProfiles(options.port);
      if (profiles.length === 0) {
        return { result: { error: "No enabled image profile is configured." }, isError: true };
      }
      const suggested = suggestedChoice(profiles, parsed);
      if ("error" in suggested) return { result: { error: suggested.error }, isError: true };

      let parentArtifactRef: EnqueueImageJobInput["parentArtifactRef"];
      if (parsed.parentAttachmentId !== undefined) {
        const parent = findCompletedArtifact(
          options.port.listJobs(options.scopeId),
          parsed.parentAttachmentId,
        );
        if (parent === undefined) {
          return {
            result: { error: "The parent image is unavailable on this thread." },
            isError: true,
          };
        }
        parentArtifactRef = parent;
      }

      // A remembered choice the host can no longer generate with (its profile
      // was turned off or the model removed) is dropped and the person asked
      // again, never swapped silently for another model.
      let choice = options.port.remembered();
      if (choice !== undefined && !isEligibleChoice(eligibleProfiles(options.port), choice)) {
        options.port.forget();
        choice = undefined;
      }
      if (choice === undefined) {
        const outcome = await options.port.ask({
          offer: {
            prompt: parsed.prompt,
            variantCount: parsed.variantCount ?? 1,
            revision: parentArtifactRef !== undefined,
            suggested,
          },
          ...(signal === undefined ? {} : { signal }),
        });
        switch (outcome.status) {
          case "generate":
            choice = outcome;
            break;
          case "agent-draws":
            return {
              result: {
                status: "agent-draws",
                message:
                  "The person chose not to use an image model for this. Make the visual yourself if the request still calls for one.",
              },
            };
          case "cancelled":
          case "expired":
            return {
              result: {
                status: "cancelled",
                message:
                  "The person did not start the image generation. Do not ask again unless they do.",
              },
            };
          case "too-many-waiting":
            return {
              result: { error: "Too many image generations are waiting for an answer." },
              isError: true,
            };
        }
      }
      // The answer can arrive minutes later, so the turn's standing is read
      // again: a thread moved to Plan while the card was open must not spend.
      const refusalNow = options.port.refusal?.();
      if (refusalNow !== undefined) return { result: { error: refusalNow }, isError: true };
      // The person's choice is checked again as it runs: a profile turned off
      // while the card was open must not run.
      if (!isEligibleChoice(eligibleProfiles(options.port), choice)) {
        return {
          result: { error: "The chosen image model is no longer available." },
          isError: true,
        };
      }

      try {
        const job = await options.port.enqueue({
          threadKind: options.threadKind,
          scopeId: options.scopeId,
          profileInstanceId: choice.profileInstanceId,
          modelId: choice.modelId,
          prompt: parsed.prompt,
          ...(parsed.variantCount === undefined ? {} : { variantCount: parsed.variantCount }),
          ...(parentArtifactRef === undefined ? {} : { parentArtifactRef }),
        });
        return await settledResult(options.port, job, signal);
      } catch (error) {
        return {
          result: {
            error: error instanceof Error ? error.message : "The image job could not be started.",
          },
          isError: true,
        };
      }
    },
  };
}

/**
 * What the call answers once its job is queued: the finished images when the
 * job ends within the wait, and the job still generating otherwise. A finished
 * image is handed to the model only when it reads images and the image fits
 * the provider's image channel; the result says when one was left out.
 */
async function settledResult(
  port: ImageAgentToolPort,
  queued: ImageJob,
  signal: AbortSignal | undefined,
): Promise<{
  readonly result: unknown;
  readonly isError?: boolean;
  readonly images?: ReadonlyArray<ProviderToolImage>;
}> {
  const generating = {
    result: {
      status: "generating",
      jobId: queued.id,
      modelId: queued.modelId,
      profileInstanceId: queued.profileInstanceId,
      message:
        "The image is still being generated. It appears in this thread when it finishes; do not start another for the same request.",
    },
  };
  if (port.whenTerminal === undefined) return generating;
  const job = await waitForTerminal(
    port.whenTerminal(queued.id),
    port.waitMs ?? IMAGE_TOOL_WAIT_MS,
    signal,
  );
  if (job === undefined) return generating;
  if (job.status === "cancelled") {
    return {
      result: { status: "cancelled", jobId: job.id, message: "The generation was cancelled." },
    };
  }
  if (job.status !== "completed") {
    return {
      result: {
        status: "failed",
        jobId: job.id,
        message: job.safetyRefusal ?? job.failure?.message ?? "The image could not be generated.",
      },
      isError: true,
    };
  }
  const images: Array<ProviderToolImage> = [];
  let withheld = 0;
  if (port.readsImages?.() === true && port.readArtifact !== undefined) {
    for (const artifact of job.artifacts) {
      if (artifact.mime !== "image/png" && artifact.mime !== "image/jpeg") {
        withheld += 1;
        continue;
      }
      const read = await port.readArtifact(job.id, artifact.attachmentId).catch(() => undefined);
      const data = read === undefined ? undefined : Buffer.from(read.bytes).toString("base64");
      if (data === undefined || data.length > MAX_TOOL_IMAGE_BASE64_LENGTH) {
        withheld += 1;
        continue;
      }
      images.push({ mimeType: artifact.mime, data });
    }
  }
  return {
    result: {
      status: "completed",
      jobId: job.id,
      modelId: job.modelId,
      profileInstanceId: job.profileInstanceId,
      images: job.artifacts.map((artifact) => ({
        attachmentId: artifact.attachmentId,
        mime: artifact.mime,
        size: artifact.size,
      })),
      message:
        images.length > 0
          ? withheld === 0
            ? "The images are shown in this thread and attached to this result."
            : `The images are shown in this thread; ${String(withheld)} could not be attached to this result because of its size or format.`
          : "The images are shown in this thread. You were not shown them, so do not describe what they look like.",
    },
    ...(images.length === 0 ? {} : { images }),
  };
}

/** The finished job, or undefined when the wait ran out, the call stopped, or the job could not be read. */
function waitForTerminal(
  terminal: Promise<ImageJob>,
  waitMs: number,
  signal: AbortSignal | undefined,
): Promise<ImageJob | undefined> {
  if (signal?.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const finish = (job: ImageJob | undefined) => {
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
 * The image tool for one thread's turn, asking through the host's offer
 * service as the window whose turn it is. Chat, Work, and Code compose it the
 * same way, so every mode asks the same question.
 */
export function createThreadImageAgentTools(input: {
  readonly windowId: WindowId;
  readonly threadKind: "chat-thread" | "work-thread" | "code-thread";
  readonly scopeId: ImageGenerationScopeId;
  readonly offers: Pick<ImageGenerationOfferService, "offer" | "remembered" | "forget">;
  readonly jobs: Pick<ImageJobService, "enqueue" | "listByScope" | "whenTerminal" | "readArtifact">;
  readonly listInstances: () => ReadonlyArray<ProviderInstance>;
  readonly readImageGenerationCustomSources: () => ReadonlyArray<ImageGenerationCustomSource>;
  readonly refusal?: () => string | undefined;
  /** Whether the model driving this turn accepts images in a tool result. */
  readonly readsImages: () => boolean;
}): AppManagedToolSet | undefined {
  const scope = { threadKind: input.threadKind, scopeId: input.scopeId };
  return createImageAgentTools({
    ...scope,
    port: {
      listInstances: input.listInstances,
      readImageGenerationCustomSources: input.readImageGenerationCustomSources,
      enqueue: (job) => input.jobs.enqueue(job),
      listJobs: (scopeId) => input.jobs.listByScope(scopeId),
      ask: ({ offer, signal }) =>
        input.offers.offer({
          windowId: input.windowId,
          offer: { ...offer, ...scope },
          ...(signal === undefined ? {} : { signal }),
        }),
      remembered: () => input.offers.remembered(scope),
      forget: () => input.offers.forget(scope),
      whenTerminal: (jobId) => input.jobs.whenTerminal(jobId),
      readArtifact: (jobId, attachmentId) => input.jobs.readArtifact(jobId, attachmentId),
      readsImages: input.readsImages,
      ...(input.refusal === undefined ? {} : { refusal: input.refusal }),
    },
  });
}

function eligibleProfiles(port: ImageAgentToolPort): ReadonlyArray<ImageGenerationProfileView> {
  return listEligibleImageProfiles(port.listInstances(), port.readImageGenerationCustomSources());
}

function isEligibleChoice(
  profiles: ReadonlyArray<ImageGenerationProfileView>,
  choice: ImageGenerationChoice,
): boolean {
  return profiles.some(
    (profile) =>
      String(profile.instanceId) === String(choice.profileInstanceId) &&
      profile.modelAllowlist.some((id) => String(id) === String(choice.modelId)),
  );
}

/** What the card preselects: the agent's suggestion when the host can run it, else the first profile. */
function suggestedChoice(
  profiles: ReadonlyArray<ImageGenerationProfileView>,
  input: ImageToolInput,
): ImageGenerationChoice | { readonly error: string } {
  const profile =
    input.profileInstanceId === undefined
      ? profiles[0]
      : profiles.find(
          (candidate) => String(candidate.instanceId) === String(input.profileInstanceId),
        );
  if (profile === undefined) return { error: "The image profile is not eligible." };
  const modelId = input.modelId ?? profile.defaultModel;
  if (!profile.modelAllowlist.some((id) => String(id) === String(modelId))) {
    return { error: "The selected model is not on this image profile's allowlist." };
  }
  return { profileInstanceId: profile.instanceId, modelId };
}

function findCompletedArtifact(jobs: ReadonlyArray<ImageJob>, attachmentId: string) {
  for (const job of jobs) {
    if (job.status !== "completed") continue;
    const artifact = job.artifacts.find(
      (candidate) => String(candidate.attachmentId) === attachmentId,
    );
    if (artifact !== undefined) {
      return {
        attachmentId: artifact.attachmentId,
        hash: artifact.hash,
        size: artifact.size,
        mime: artifact.mime,
      };
    }
  }
  return undefined;
}

function parseInput(inputJson: string): ImageToolInput | { readonly error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(inputJson);
  } catch {
    return { error: "Image tool input is not valid JSON." };
  }
  if (typeof raw !== "object" || raw === null) {
    return { error: "Image tool input is invalid." };
  }
  const record = raw as Record<string, unknown>;
  for (const key of FORBIDDEN_INPUT_KEYS) {
    if (key in record) {
      return { error: "Image generation cannot take credentials, endpoints, or filesystem paths." };
    }
  }
  const prompt = record["prompt"];
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return { error: "The image prompt must not be empty." };
  }
  if (prompt.length > MAX_IMAGE_PROMPT_CHARACTERS) {
    return { error: "The image prompt exceeded the length limit." };
  }
  const variantCount = record["variantCount"];
  if (variantCount !== undefined) {
    if (
      typeof variantCount !== "number" ||
      !Number.isSafeInteger(variantCount) ||
      variantCount < 1 ||
      variantCount > MAX_IMAGE_VARIANTS
    ) {
      return { error: "The requested variant count is not supported." };
    }
  }
  const profileInstanceId = record["profileInstanceId"];
  const modelId = record["modelId"];
  const parentAttachmentId = record["parentAttachmentId"];
  try {
    return {
      prompt: prompt.trim(),
      ...(profileInstanceId === undefined
        ? {}
        : { profileInstanceId: decodeProviderInstanceId(profileInstanceId) }),
      ...(modelId === undefined ? {} : { modelId: decodeProviderModelId(modelId) }),
      ...(variantCount === undefined ? {} : { variantCount }),
      ...(typeof parentAttachmentId === "string"
        ? { parentAttachmentId: String(decodeImageArtifactId(parentAttachmentId)) }
        : {}),
    };
  } catch {
    return { error: "Image tool input is invalid." };
  }
}
