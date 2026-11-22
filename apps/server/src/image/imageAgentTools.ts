import {
  type ImageGenerationCustomSource,
  type ImageGenerationGenerateOffer,
  type ImageGenerationProfileView,
  type ImageGenerationSaveOffer,
  type ImageGenerationSaveResult,
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
  imageProfileSupportsReferences,
  listEligibleImageProfiles,
} from "@octant/domain";
import type {
  MediaIconSetTarget,
  MediaImageGenerateOutcome,
  MediaImageGenerateRequest,
  MediaImageIconSetOutcome,
  MediaImageIconSetRequest,
  MediaImageSaveOutcome,
  MediaImageSaveRequest,
  MediaToolHostPort,
} from "@octant/plugin-api/media-tools";
import {
  CREATE_IMAGE_MEDIA_TOOL_PLUGIN,
  CREATE_IMAGE_TOOL_NAME,
} from "@octant/plugin-host/media-tools";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { adaptMediaToolSet } from "../providers/mediaToolAdapter";
import type {
  ImageGenerationChoice,
  ImageGenerationOfferOutcome,
  ImageGenerationOfferService,
} from "./imageGenerationOfferService";
import type { CreatedFileReceipt } from "./generatedImageSave";
import { webIconSnippets, type IconSetRenderOutcome } from "./iconSetRenderer";
import type { EnqueueImageJobInput, ImageJobService } from "./imageJobService";
import type { KeptImageGenerationChoices } from "./keptImageGenerationChoices";
import {
  describeImageSources,
  parseImageSourceRequests,
  readImageSources,
  type ImageSourceRequest,
  type ThreadImageSources,
} from "./threadImageSources";

export const IMAGE_TOOL_NAME = CREATE_IMAGE_TOOL_NAME;

export interface ImageAgentToolPort {
  readonly listInstances: () => ReadonlyArray<ProviderInstance>;
  readonly readImageGenerationCustomSources: () => ReadonlyArray<ImageGenerationCustomSource>;
  readonly enqueue: (input: EnqueueImageJobInput) => Promise<ImageJob>;
  readonly listJobs: ImageJobService["listByScope"];
  readonly imageSources?: ThreadImageSources;
  /**
   * Asks the person in the thread whether to generate, and with which profile
   * and model. A call asks unless a kept choice or Full access already
   * settles it, because a generation spends money on the person's image
   * provider.
   */
  readonly ask: (input: {
    readonly offer: ImageOfferAsk;
    readonly signal?: AbortSignal;
  }) => Promise<ImageGenerationOfferOutcome>;
  /** The choice the person said to keep using without asking, for the thread's Project. */
  readonly remembered: () => ImageGenerationChoice | undefined;
  /** The person chose Ask again, so Full access asks too. */
  readonly asksAgain?: () => boolean;
  readonly forget: () => void | Promise<void>;
  /** Whether the turn's thread runs at Full access now; absent in Chat, which has no such level. */
  readonly fullAccess?: () => boolean;
  /** The image profile Settings names for Full access, read at each call; absent is none. */
  readonly defaultProfileInstanceId?: () => string | undefined;
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
  /**
   * Resizing a finished image into an icon set saved through `save`. Absent
   * where the host cannot resize images (off macOS), and then not offered.
   */
  readonly iconSets?: ImageIconSetPort;
}

export interface ImageIconSetPort {
  readonly render: (source: {
    readonly bytes: Uint8Array;
    readonly mime: string;
    readonly target: MediaIconSetTarget;
  }) => Promise<IconSetRenderOutcome>;
  /** Whether a new file can be created at this path under the turn's folder, without writing. */
  readonly check: (
    relativePath: string,
  ) => Promise<{ readonly status: "ok" } | { readonly status: "refused"; readonly reason: string }>;
  /** Which object a file this call just wrote is; undefined when it cannot be proved. */
  readonly receipt: (relativePath: string) => Promise<CreatedFileReceipt | undefined>;
  /**
   * Removes a file this call created, when the set stops part way, only while
   * it is still the object its receipt names; false when it was left.
   */
  readonly remove: (relativePath: string, receipt: CreatedFileReceipt) => Promise<boolean>;
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

/**
 * App-managed image generation for a Chat, Work, or Code thread, composed
 * through the public `CREATE_IMAGE_MEDIA_TOOL_PLUGIN` over a host-owned
 * `MediaToolHostPort`.
 *
 * Present only while Settings has an enabled image profile. A call asks the
 * person, in the thread, before a job is queued, unless they said not to ask
 * again or the thread is at Full access, which uses the profile Settings names
 * or the first ready one (`imageGenerationWithoutAsking`); the job runs on the
 * profile and model that settles.
 */
export function createImageAgentTools(options: {
  readonly threadKind: "chat-thread" | "work-thread" | "code-thread";
  readonly scopeId: ImageGenerationScopeId;
  readonly port: ImageAgentToolPort;
}): AppManagedToolSet | undefined {
  const mode =
    options.threadKind === "chat-thread"
      ? "chat"
      : options.threadKind === "work-thread"
        ? "work"
        : "code";
  const mediaPort: MediaToolHostPort = {
    turn: {
      mode,
      hasFolder: options.port.save !== undefined,
      unattended: options.port.unattended === true,
      inPlan: () => false,
      allowed: () => true,
    },
    imageGeneration: {
      isAvailable: () =>
        hasEligibleImageProfile(
          options.port.listInstances(),
          options.port.readImageGenerationCustomSources(),
        ),
      ...(options.port.refusal === undefined ? {} : { refusal: options.port.refusal }),
      generate: (request) => executeHostImageGeneration(options, request),
      ...(options.port.save === undefined || options.port.readArtifact === undefined
        ? {}
        : { save: (request) => executeHostImageSave(options, request) }),
      ...(options.port.save === undefined ||
      options.port.readArtifact === undefined ||
      options.port.iconSets === undefined
        ? {}
        : { iconSet: (request) => executeHostIconSet(options, request) }),
    },
  };
  const tools = CREATE_IMAGE_MEDIA_TOOL_PLUGIN.createTools(mediaPort);
  if (tools === undefined) return undefined;
  return adaptMediaToolSet({ tools });
}

async function executeHostImageGeneration(
  options: {
    readonly threadKind: "chat-thread" | "work-thread" | "code-thread";
    readonly scopeId: ImageGenerationScopeId;
    readonly port: ImageAgentToolPort;
  },
  request: MediaImageGenerateRequest,
): Promise<MediaImageGenerateOutcome> {
  const { signal } = request;
  const needsReferences = request.references.length > 0;
  const profiles = eligibleProfiles(options.port, needsReferences);
  if (profiles.length === 0) {
    return {
      status: "refused",
      error: needsReferences
        ? "No enabled image model can use reference images."
        : "No enabled image profile is configured.",
    };
  }
  const suggested = suggestedChoice(
    profiles,
    needsReferences &&
      request.profileInstanceId !== undefined &&
      !profiles.some((profile) => String(profile.instanceId) === String(request.profileInstanceId))
      ? {}
      : request,
  );
  if ("error" in suggested) return { status: "refused", error: suggested.error };

  let parentArtifactRef: EnqueueImageJobInput["parentArtifactRef"];
  if (request.parentAttachmentId !== undefined && !needsReferences) {
    const parent = findCompletedArtifact(
      options.port.listJobs(options.scopeId),
      String(request.parentAttachmentId),
    );
    if (parent === undefined) {
      return { status: "refused", error: "The parent image is unavailable on this thread." };
    }
    parentArtifactRef = parent;
  }

  const validatedReferences =
    request.references.length === 0 ? [] : parseImageSourceRequests(request.references);
  if ("error" in validatedReferences) {
    return { status: "refused", error: validatedReferences.error };
  }
  const sourceRequests: ReadonlyArray<ImageSourceRequest> =
    request.parentAttachmentId === undefined
      ? validatedReferences
      : [
          { kind: "generated-image", attachmentId: request.parentAttachmentId },
          ...validatedReferences,
        ];
  const references = needsReferences
    ? await describeImageSources(sourceRequests, options.port.imageSources, (id) => {
        const found = findCompletedJobArtifact(
          options.port
            .listJobs(options.scopeId)
            .filter((job) => job.threadKind === options.threadKind),
          id,
        );
        if (found === undefined) return undefined;
        return {
          label: "generated image",
          size: found.artifact.size,
          read: async () =>
            (await options.port.readArtifact?.(found.job.id, found.artifact.attachmentId))?.bytes,
        };
      })
    : [];
  if ("error" in references) return { status: "refused", error: references.error };
  if (signal?.aborted) return { status: "cancelled", reason: "aborted" };

  // A remembered model is not permission to share these particular images.
  const unasked = imageGenerationWithoutAsking({
    profiles,
    kept: needsReferences ? undefined : options.port.remembered(),
    fullAccess: !needsReferences && options.port.fullAccess?.() === true,
    askAgain: options.port.asksAgain?.() === true,
    defaultProfileInstanceId: options.port.defaultProfileInstanceId?.(),
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
        status: "refused",
        error:
          "Nobody is at this thread to choose an image model, and its Project keeps no choice that can run. Do not try again in this turn.",
      };
    }
    const outcome = await options.port.ask({
      offer: {
        kind: "generate",
        prompt: request.prompt,
        variantCount: request.variantCount ?? 1,
        revision: request.parentAttachmentId !== undefined,
        suggested,
        ...(needsReferences ? { references: references.map(({ reference }) => reference) } : {}),
      },
      ...(signal === undefined ? {} : { signal }),
    });
    switch (outcome.status) {
      case "generate":
        choice = outcome;
        break;
      case "agent-draws":
        return { status: "agent-draws" };
      case "save":
      case "cancelled":
        return { status: "cancelled", reason: "declined" };
      case "too-many-waiting":
        return {
          status: "refused",
          error: "Too many image generations are waiting for an answer.",
        };
    }
  }
  // The answer can arrive minutes later, so the turn's standing is read
  // again: a thread moved to Plan while the card was open must not spend.
  const refusalNow = options.port.refusal?.();
  if (refusalNow !== undefined) return { status: "refused", error: refusalNow };
  // The person's choice is checked again as it runs: a profile turned off
  // while the card was open must not run.
  if (
    choice === undefined ||
    !isEligibleChoice(eligibleProfiles(options.port, needsReferences), choice)
  ) {
    return { status: "refused", error: "The chosen image model is no longer available." };
  }

  try {
    const images = await readImageSources(references, signal);
    if ("error" in images) return { status: "refused", error: images.error };
    if (signal?.aborted) return { status: "cancelled", reason: "aborted" };
    if (needsReferences) {
      const refusalAfterRead = options.port.refusal?.();
      if (refusalAfterRead !== undefined) return { status: "refused", error: refusalAfterRead };
      if (!isEligibleChoice(eligibleProfiles(options.port, true), choice)) {
        return {
          status: "refused",
          error: "The chosen image model can no longer use reference images.",
        };
      }
    }
    const job = await options.port.enqueue({
      threadKind: options.threadKind,
      scopeId: options.scopeId,
      profileInstanceId: choice.profileInstanceId,
      modelId: choice.modelId,
      prompt: request.prompt,
      ...(request.variantCount === undefined ? {} : { variantCount: request.variantCount }),
      ...(parentArtifactRef === undefined ? {} : { parentArtifactRef }),
      ...(images.length === 0 ? {} : { references: images }),
    });
    return await settledOutcome(options.port, job, signal);
  } catch (error) {
    return {
      status: "refused",
      error: error instanceof Error ? error.message : "The image job could not be started.",
    };
  }
}

/**
 * Saves an image this thread generated as a new file under the folder the
 * turn works in. The turn's level decides as for any file edit: Plan refuses,
 * a level that asks before edits shows the person a card naming the path, and
 * one that lets edits through writes at once. The write is confined to that
 * folder and never overwrites a file.
 */
async function executeHostImageSave(
  options: {
    readonly scopeId: ImageGenerationScopeId;
    readonly port: ImageAgentToolPort;
  },
  request: MediaImageSaveRequest,
): Promise<MediaImageSaveOutcome> {
  const save = options.port.save;
  if (save === undefined || options.port.readArtifact === undefined) {
    return {
      status: "refused",
      error: "This thread has no folder to save into. Chat images stay in the thread.",
    };
  }
  const found = findCompletedJobArtifact(
    options.port.listJobs(options.scopeId),
    String(request.attachmentId),
  );
  if (found === undefined) {
    return { status: "refused", error: "That image is not a finished image of this thread." };
  }
  // Plan refuses before anything is read or asked.
  if (save.posture() === "refuse") {
    return { status: "refused", error: "Plan mode cannot save files." };
  }
  const read = await options.port
    .readArtifact(found.job.id, found.artifact.attachmentId)
    .catch(() => undefined);
  if (read === undefined) {
    return { status: "refused", error: "The generated image is unavailable." };
  }
  // The level is read again after every wait, and once more right before the
  // write starts with nothing awaited in between: a thread lowered to Plan or
  // Ask first while the image was read or the card was open is refused or
  // asked, never written on the level it had when the call began.
  let confirmed = false;
  for (;;) {
    const posture = save.posture();
    if (posture === "refuse") {
      return { status: "refused", error: "Plan mode cannot save files." };
    }
    if (posture === "allow" || confirmed) break;
    const outcome = await options.port.ask({
      offer: {
        kind: "save",
        jobId: found.job.id,
        attachmentId: found.artifact.attachmentId,
        relativePath: request.relativePath,
      },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (outcome.status !== "save") return { status: "not-saved" };
    confirmed = true;
  }
  const saved = await save.write(request.relativePath, read.bytes);
  return saved.status === "saved"
    ? { status: "saved", relativePath: saved.relativePath }
    : { status: "refused", saveStatus: saved.status, error: saved.reason };
}

/**
 * Resizes a finished image of this thread into an icon set and saves every
 * file as new under the folder the turn works in. Every path is checked for
 * create before anything is written, so one existing file or one path outside
 * the folder writes nothing. The level decides as for a single save, and the
 * card names the directory and the number of files.
 */
async function executeHostIconSet(
  options: {
    readonly scopeId: ImageGenerationScopeId;
    readonly port: ImageAgentToolPort;
  },
  request: MediaImageIconSetRequest,
): Promise<MediaImageIconSetOutcome> {
  const { save, readArtifact, iconSets } = options.port;
  if (save === undefined || readArtifact === undefined || iconSets === undefined) {
    return { status: "refused", error: "This thread cannot save icon sets." };
  }
  const found = findCompletedJobArtifact(
    options.port.listJobs(options.scopeId),
    String(request.attachmentId),
  );
  if (found === undefined) {
    return { status: "refused", error: "That image is not a finished image of this thread." };
  }
  if (save.posture() === "refuse") {
    return { status: "refused", error: "Plan mode cannot save files." };
  }
  const read = await readArtifact(found.job.id, found.artifact.attachmentId).catch(() => undefined);
  if (read === undefined) {
    return { status: "refused", error: "The generated image is unavailable." };
  }
  const rendered = await iconSets.render({
    bytes: read.bytes,
    mime: found.artifact.mime,
    target: request.target,
  });
  if (rendered.status === "refused") return { status: "refused", error: rendered.reason };
  if (request.signal?.aborted) return { status: "not-saved" };
  // "." is the folder itself, for a site served from it.
  const under = (path: string) =>
    request.directory === "." ? path : `${request.directory}/${path}`;
  const files = rendered.files.map((file) => ({
    relativePath: under(file.path),
    bytes: file.bytes,
    conflicts: (file.conflicts ?? []).map(under),
  }));
  const checkAll = async (): Promise<string | undefined> => {
    for (const file of files) {
      const checked = await iconSets.check(file.relativePath);
      if (checked.status === "refused") return `${checked.reason} Nothing was written.`;
      for (const conflict of file.conflicts) {
        const clear = await iconSets.check(conflict);
        if (clear.status === "refused") {
          return `${clear.reason} It would be the same resource as ${file.relativePath}. Nothing was written.`;
        }
      }
    }
    return undefined;
  };
  const refusedBefore = await checkAll();
  if (refusedBefore !== undefined) return { status: "refused", error: refusedBefore };
  let confirmed = false;
  for (;;) {
    const posture = save.posture();
    if (posture === "refuse") {
      return { status: "refused", error: "Plan mode cannot save files." };
    }
    if (posture === "allow" || confirmed) break;
    const outcome = await options.port.ask({
      offer: {
        kind: "save",
        jobId: found.job.id,
        attachmentId: found.artifact.attachmentId,
        relativePath: request.directory,
        fileCount: files.length,
      },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (outcome.status !== "save") return { status: "not-saved" };
    confirmed = true;
  }
  // The card can stay open for minutes, so the paths are checked again: a
  // file that appeared meanwhile still writes nothing.
  if (confirmed) {
    const refusedAfter = await checkAll();
    if (refusedAfter !== undefined) return { status: "refused", error: refusedAfter };
    if (save.posture() === "refuse") {
      return { status: "refused", error: "Plan mode cannot save files." };
    }
  }
  const written: Array<{
    readonly relativePath: string;
    readonly receipt: CreatedFileReceipt | undefined;
  }> = [];
  // A set stopped part way removes the files this call created, so the
  // folder is left as it was: a stopped turn drops its tool result, and files
  // nobody was shown would only block the next try at the same directory. A
  // file is removed only while it is still the object written; one edited or
  // replaced since, or one whose identity could not be proved, is kept and
  // named.
  const undo = async (reason: string, incomplete?: string): Promise<MediaImageIconSetOutcome> => {
    const kept: string[] = [];
    for (const file of written) {
      const removed =
        file.receipt !== undefined && (await iconSets.remove(file.relativePath, file.receipt));
      if (!removed) kept.push(file.relativePath);
    }
    // A failed write can leave a partly written file; it is never removed,
    // since this call cannot prove it created it, but it is named.
    if (incomplete !== undefined) kept.push(incomplete);
    return kept.length === 0
      ? { status: "refused", error: `${reason} Nothing was kept.` }
      : {
          status: "failed",
          error:
            incomplete === undefined
              ? `${reason} These files were left in place.`
              : `${reason} These files were left in place; the last may be incomplete.`,
          written: kept,
        };
  };
  for (const file of files) {
    // Each write is awaited, so the level and the turn's Stop are read again
    // before the next one starts: a thread moved to Plan or stopped mid-set
    // writes no further file.
    const stopped =
      request.signal?.aborted === true
        ? "The turn was stopped."
        : save.posture() === "refuse"
          ? "Plan mode cannot save files."
          : undefined;
    if (stopped !== undefined) return await undo(stopped);
    const saved = await save.write(file.relativePath, file.bytes);
    if (saved.status !== "saved") {
      return await undo(`${file.relativePath}: ${saved.reason}`, file.relativePath);
    }
    written.push({
      relativePath: saved.relativePath,
      receipt: await iconSets.receipt(saved.relativePath),
    });
  }
  return {
    status: "saved",
    directory: request.directory,
    files: written.map((file) => file.relativePath),
    ...(request.target === "web" ? { snippets: webIconSnippets() } : {}),
  };
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
async function settledOutcome(
  port: ImageAgentToolPort,
  queued: ImageJob,
  signal: AbortSignal | undefined,
): Promise<MediaImageGenerateOutcome> {
  const generating: MediaImageGenerateOutcome = {
    status: "generating",
    jobId: queued.id,
    modelId: queued.modelId,
    profileInstanceId: queued.profileInstanceId,
  };
  if (port.whenTerminal === undefined) return generating;
  const job = await waitForTerminal(
    port.whenTerminal(queued.id),
    port.waitMs ?? IMAGE_TOOL_WAIT_MS,
    signal,
  );
  if (job === undefined) return generating;
  if (job.status === "cancelled") {
    return { status: "cancelled", jobId: job.id, reason: "job-cancelled" };
  }
  if (job.status !== "completed") {
    return {
      status: "failed",
      jobId: job.id,
      message: job.safetyRefusal ?? job.failure?.message ?? "The image could not be generated.",
    };
  }
  const images: Array<ProviderToolImage> = [];
  let withheldCount = 0;
  if (port.readsImages?.() === true && port.readArtifact !== undefined) {
    for (const artifact of job.artifacts) {
      if (artifact.mime !== "image/png" && artifact.mime !== "image/jpeg") {
        withheldCount += 1;
        continue;
      }
      const read = await port.readArtifact(job.id, artifact.attachmentId).catch(() => undefined);
      const data = read === undefined ? undefined : Buffer.from(read.bytes).toString("base64");
      if (data === undefined || data.length > MAX_TOOL_IMAGE_BASE64_LENGTH) {
        withheldCount += 1;
        continue;
      }
      images.push({ mimeType: artifact.mime, data });
    }
  }
  return {
    status: "completed",
    jobId: job.id,
    modelId: job.modelId,
    profileInstanceId: job.profileInstanceId,
    artifacts: job.artifacts.map((artifact) => ({
      attachmentId: artifact.attachmentId,
      mime: artifact.mime,
      size: artifact.size,
    })),
    ...(images.length === 0 ? {} : { images }),
    withheldCount,
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
  readonly kept: Pick<KeptImageGenerationChoices, "remembered" | "forget" | "asksAgain">;
  /** The host runs this turn as itself: a routine, a goal loop, a resume. */
  readonly unattended?: boolean;
  /** Whether the turn's thread runs at Full access now; Work and Code only. */
  readonly fullAccess?: () => boolean;
  /** The image profile Settings names for Full access; Work and Code only. */
  readonly defaultProfileInstanceId?: () => string | undefined;
  readonly jobs: Pick<ImageJobService, "enqueue" | "listByScope" | "whenTerminal" | "readArtifact">;
  readonly listInstances: () => ReadonlyArray<ProviderInstance>;
  readonly readImageGenerationCustomSources: () => ReadonlyArray<ImageGenerationCustomSource>;
  readonly refusal?: () => string | undefined;
  /** Whether the model driving this turn accepts images in a tool result. */
  readonly readsImages: () => boolean;
  readonly imageSources?: ThreadImageSources;
  /** Saving under the turn's folder; Work and Code only. */
  readonly save?: ImageAgentToolPort["save"];
  /** Icon sets under the turn's folder; Work and Code on a host that can resize images. */
  readonly iconSets?: ImageIconSetPort;
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
      asksAgain: () => input.kept.asksAgain(scope),
      forget: () => input.kept.forget(scope),
      ...(input.fullAccess === undefined ? {} : { fullAccess: input.fullAccess }),
      ...(input.defaultProfileInstanceId === undefined
        ? {}
        : { defaultProfileInstanceId: input.defaultProfileInstanceId }),
      ...(input.unattended === true ? { unattended: true } : {}),
      whenTerminal: (jobId) => input.jobs.whenTerminal(jobId),
      readArtifact: (jobId, attachmentId) => input.jobs.readArtifact(jobId, attachmentId),
      readsImages: input.readsImages,
      ...(input.imageSources === undefined ? {} : { imageSources: input.imageSources }),
      ...(input.refusal === undefined ? {} : { refusal: input.refusal }),
      ...(input.save === undefined || threadKind === "chat-thread" ? {} : { save: input.save }),
      ...(input.iconSets === undefined || threadKind === "chat-thread"
        ? {}
        : { iconSets: input.iconSets }),
    },
  });
}

function eligibleProfiles(
  port: ImageAgentToolPort,
  references: boolean,
): ReadonlyArray<ImageGenerationProfileView> {
  const profiles = listEligibleImageProfiles(
    port.listInstances(),
    port.readImageGenerationCustomSources(),
  );
  return references ? profiles.filter(imageProfileSupportsReferences) : profiles;
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
  input: {
    readonly profileInstanceId?: ProviderInstanceId;
    readonly modelId?: ProviderModelId;
  },
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
