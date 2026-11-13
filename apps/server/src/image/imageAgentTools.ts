import {
  decodeImageArtifactId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  MAX_IMAGE_PROMPT_CHARACTERS,
  MAX_IMAGE_VARIANTS,
  type ImageGenerationCustomSource,
  type ImageGenerationGenerateOffer,
  type ImageGenerationSaveOffer,
  type ImageGenerationSaveResult,
  type ImageGenerationProfileView,
  type ImageGenerationScopeId,
  type ImageJob,
  type ProviderInstance,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderToolImage,
  type WindowId,
} from "@octant/contracts";
import {
  hasEligibleImageProfile,
  imageGenerationWithoutAsking,
  listEligibleImageProfiles,
} from "@octant/domain";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type {
  ImageGenerationChoice,
  ImageGenerationOfferOutcome,
  ImageGenerationOfferService,
} from "./imageGenerationOfferService";
import type { EnqueueImageJobInput, ImageJobService } from "./imageJobService";
import type { KeptImageGenerationChoices } from "./keptImageGenerationChoices";

export const IMAGE_TOOL_NAME = "octant_create_image";

const imageToolInputSchema = {
  type: "object",
  properties: {
    operation: { type: "string", enum: ["generate", "save"] },
    prompt: { type: "string" },
    profileInstanceId: { type: "string" },
    modelId: { type: "string" },
    variantCount: { type: "number" },
    parentAttachmentId: { type: "string" },
    attachmentId: { type: "string" },
    relativePath: { type: "string" },
  },
} as const;

const MAX_SAVE_PATH_CHARACTERS = 512;

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
   * and model. A call asks unless a kept choice or Full access with one ready
   * profile already settles it, because a generation spends money on the
   * person's image provider.
   */
  readonly ask: (input: {
    readonly offer: ImageOfferAsk;
    readonly signal?: AbortSignal;
  }) => Promise<ImageGenerationOfferOutcome>;
  /** The choice the person said to keep using without asking, for the thread's Project. */
  readonly remembered: () => ImageGenerationChoice | undefined;
  readonly forget: () => void | Promise<void>;
  /** Whether the turn's thread runs at Full access now; absent in Chat, which has no such level. */
  readonly fullAccess?: () => boolean;
  /**
   * The host runs this turn as itself (a routine, a goal loop), so nobody is
   * at a window to answer a card: a call that would ask starts nothing.
   */
  readonly unattended?: boolean;
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
  /**
   * Saving a generated image as a new file under the folder the turn works
   * in. Absent in Chat, which has no folder.
   */
  readonly save?: {
    /** What the turn's level does with a file edit: refuse it, ask first, or allow it. */
    readonly posture: () => "refuse" | "ask" | "allow";
    /** Writes a new file under the turn's folder; never overwrites. */
    readonly write: (relativePath: string, bytes: Uint8Array) => Promise<ImageGenerationSaveResult>;
  };
}

/** What the tool asks the person; the binding adds the thread it asks in. */
export type ImageOfferAsk =
  | Omit<ImageGenerationGenerateOffer, "offerId" | "requestedAt" | "threadKind" | "scopeId">
  | Omit<ImageGenerationSaveOffer, "offerId" | "requestedAt" | "threadKind" | "scopeId">;

/**
 * Most generations finish well inside this; a slower one is reported as still
 * generating rather than holding the turn open for the provider's full time.
 */
export const IMAGE_TOOL_WAIT_MS = 120_000;

/** The provider image channel's own bound on one image's base64 text. */
const MAX_TOOL_IMAGE_BASE64_LENGTH = 2_097_152;

interface ImageToolInput {
  readonly operation: "generate";
  readonly prompt: string;
  readonly profileInstanceId?: ProviderInstanceId;
  readonly modelId?: ProviderModelId;
  readonly variantCount?: number;
  readonly parentAttachmentId?: string;
}

interface ImageSaveInput {
  readonly operation: "save";
  readonly attachmentId: string;
  readonly relativePath: string;
}

const DESCRIPTION =
  "Generate or revise a picture (a photo, illustration, or rendered scene) with an image model the person set up in Octant. Call it when the person asks for an image instead of drawing one yourself as SVG, HTML, or CSS: a real image model gives a far better result. Keep SVG for logos, icons, and diagrams, or when the person asks for it. Octant shows the person a card in this thread where they pick the model and confirm, because each generation is billed to their image provider; nothing runs until they answer, unless they already said not to ask again or the thread runs at Full access with a single image profile set up. Describe the image in prompt; profileInstanceId and modelId only suggest what the card preselects. To revise, pass parentAttachmentId from a completed image on this thread. Never pass credentials, endpoints, headers, or filesystem paths. The result says what happened: completed with each image's attachmentId (the images are shown in this thread, and to you when you can read images; use an attachmentId to revise one, to place it in a Canvas design as a generated-image asset, or to save it), failed with the reason, generating with a jobId when it takes longer than the call waits (it appears in this thread when done; do not start another), agent-draws (the person wants you to make the visual yourself), or cancelled (do not ask again unless they do). In a Work or Code thread, operation save with an attachmentId from this thread and a relativePath stores that image as a new file in the folder you work in: it never overwrites a file, Plan refuses it, and at Ask first the person confirms the path. Never invent an image URL.";

/**
 * App-managed image generation for a Chat, Work, or Code thread.
 *
 * Present only while Settings has an enabled image profile. A call asks the
 * person, in the thread, before a job is queued, unless they said not to ask
 * again or the thread is at Full access with exactly one profile ready
 * (`imageGenerationWithoutAsking`); the job runs on the profile and model
 * that settles.
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
      if (parsed.operation === "save") return saveImage(options, parsed, signal);

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

      const unasked = imageGenerationWithoutAsking({
        profiles,
        kept: options.port.remembered(),
        fullAccess: options.port.fullAccess?.() === true,
      });
      let choice: ImageGenerationChoice | undefined;
      if (unasked.kind === "generate") {
        choice = unasked.choice;
      } else {
        // A kept choice the host can no longer generate with (its profile was
        // turned off or the model removed) is dropped and the person asked
        // again, never swapped silently for another model.
        if (unasked.keptUnavailable) await options.port.forget();
        if (options.port.unattended === true) {
          return {
            result: {
              error:
                "Nobody is at this thread to choose an image model, and its Project keeps no choice that can run. Do not try again in this turn.",
            },
            isError: true,
          };
        }
        const outcome = await options.port.ask({
          offer: {
            kind: "generate",
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
          case "save":
          case "cancelled":
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
      if (choice === undefined || !isEligibleChoice(eligibleProfiles(options.port), choice)) {
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
 * Saves an image this thread generated as a new file under the folder the
 * turn works in. The turn's level decides as for any file edit: Plan refuses,
 * a level that asks before edits shows the person a card naming the path, and
 * one that lets edits through writes at once. The write is confined to that
 * folder and never overwrites a file.
 */
async function saveImage(
  options: {
    readonly scopeId: ImageGenerationScopeId;
    readonly port: ImageAgentToolPort;
  },
  input: ImageSaveInput,
  signal: AbortSignal | undefined,
): Promise<{ readonly result: unknown; readonly isError?: boolean }> {
  const save = options.port.save;
  if (save === undefined || options.port.readArtifact === undefined) {
    return {
      result: { error: "This thread has no folder to save into. Chat images stay in the thread." },
      isError: true,
    };
  }
  const found = findCompletedJobArtifact(
    options.port.listJobs(options.scopeId),
    input.attachmentId,
  );
  if (found === undefined) {
    return {
      result: { error: "That image is not a finished image of this thread." },
      isError: true,
    };
  }
  // Plan refuses before anything is read or asked.
  if (save.posture() === "refuse") {
    return { result: { error: "Plan mode cannot save files." }, isError: true };
  }
  const read = await options.port
    .readArtifact(found.job.id, found.artifact.attachmentId)
    .catch(() => undefined);
  if (read === undefined) {
    return { result: { error: "The generated image is unavailable." }, isError: true };
  }
  // The level is read again after every wait, and once more right before the
  // write starts with nothing awaited in between: a thread lowered to Plan or
  // Ask first while the image was read or the card was open is refused or
  // asked, never written on the level it had when the call began.
  let confirmed = false;
  for (;;) {
    const posture = save.posture();
    if (posture === "refuse") {
      return { result: { error: "Plan mode cannot save files." }, isError: true };
    }
    if (posture === "allow" || confirmed) break;
    const outcome = await options.port.ask({
      offer: {
        kind: "save",
        jobId: found.job.id,
        attachmentId: found.artifact.attachmentId,
        relativePath: input.relativePath,
      },
      ...(signal === undefined ? {} : { signal }),
    });
    if (outcome.status !== "save") {
      return {
        result: {
          status: "not-saved",
          message: "The person did not save the image. Do not ask again unless they do.",
        },
      };
    }
    confirmed = true;
  }
  const saved = await save.write(input.relativePath, read.bytes);
  return saved.status === "saved"
    ? { result: { status: "saved", relativePath: saved.relativePath } }
    : { result: { status: saved.status, error: saved.reason }, isError: true };
}

function findCompletedJobArtifact(jobs: ReadonlyArray<ImageJob>, attachmentId: string) {
  for (const job of jobs) {
    if (job.status !== "completed") continue;
    const artifact = job.artifacts.find(
      (candidate) => String(candidate.attachmentId) === attachmentId,
    );
    if (artifact !== undefined) return { job, artifact };
  }
  return undefined;
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
 * same way, so every mode asks the same question. A turn the host runs as
 * itself is offered the tool only where a kept choice stands when the turn
 * starts, since nobody could answer its card.
 */
export function createThreadImageAgentTools(input: {
  readonly windowId: WindowId;
  readonly threadKind: "chat-thread" | "work-thread" | "code-thread";
  readonly scopeId: ImageGenerationScopeId;
  readonly offers: Pick<ImageGenerationOfferService, "offer">;
  readonly kept: Pick<KeptImageGenerationChoices, "remembered" | "forget">;
  /** The host runs this turn as itself: a routine, a goal loop, a resume. */
  readonly unattended?: boolean;
  /** Whether the turn's thread runs at Full access now; Work and Code only. */
  readonly fullAccess?: () => boolean;
  readonly jobs: Pick<ImageJobService, "enqueue" | "listByScope" | "whenTerminal" | "readArtifact">;
  readonly listInstances: () => ReadonlyArray<ProviderInstance>;
  readonly readImageGenerationCustomSources: () => ReadonlyArray<ImageGenerationCustomSource>;
  readonly refusal?: () => string | undefined;
  /** Whether the model driving this turn accepts images in a tool result. */
  readonly readsImages: () => boolean;
  /** Saving under the turn's folder; Work and Code only. */
  readonly save?: ImageAgentToolPort["save"];
}): AppManagedToolSet | undefined {
  const scope = { threadKind: input.threadKind, scopeId: input.scopeId };
  const { threadKind, scopeId } = scope;
  if (input.unattended === true && input.kept.remembered(scope) === undefined) return undefined;
  return createImageAgentTools({
    ...scope,
    port: {
      listInstances: input.listInstances,
      readImageGenerationCustomSources: input.readImageGenerationCustomSources,
      enqueue: (job) => input.jobs.enqueue(job),
      listJobs: (scopeId) => input.jobs.listByScope(scopeId),
      ask: async ({ offer, signal }) => {
        const options = signal === undefined ? {} : { signal };
        if (offer.kind === "generate") {
          return input.offers.offer({
            windowId: input.windowId,
            offer: { ...offer, threadKind, scopeId },
            ...options,
          });
        }
        // A Chat thread has no folder, so it is never asked to save.
        if (threadKind === "chat-thread") return { status: "cancelled" };
        return input.offers.offer({
          windowId: input.windowId,
          offer: { ...offer, threadKind, scopeId },
          ...options,
        });
      },
      remembered: () => input.kept.remembered(scope),
      forget: () => input.kept.forget(scope),
      ...(input.fullAccess === undefined ? {} : { fullAccess: input.fullAccess }),
      ...(input.unattended === true ? { unattended: true } : {}),
      whenTerminal: (jobId) => input.jobs.whenTerminal(jobId),
      readArtifact: (jobId, attachmentId) => input.jobs.readArtifact(jobId, attachmentId),
      readsImages: input.readsImages,
      ...(input.refusal === undefined ? {} : { refusal: input.refusal }),
      ...(input.save === undefined || threadKind === "chat-thread" ? {} : { save: input.save }),
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

function parseInput(
  inputJson: string,
): ImageToolInput | ImageSaveInput | { readonly error: string } {
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
  const operation = record["operation"] ?? "generate";
  if (operation === "save") {
    const attachmentId = record["attachmentId"];
    const relativePath = record["relativePath"];
    if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
      return { error: "A save needs relativePath, a path inside this thread's folder." };
    }
    if (relativePath.length > MAX_SAVE_PATH_CHARACTERS) {
      return { error: "The save path is too long." };
    }
    try {
      return {
        operation: "save",
        attachmentId: String(decodeImageArtifactId(attachmentId)),
        relativePath: relativePath.trim(),
      };
    } catch {
      return { error: "A save needs the attachmentId of a finished image on this thread." };
    }
  }
  if (operation !== "generate") return { error: "The operation is generate or save." };
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
      operation: "generate",
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
