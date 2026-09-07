import {
  decodeImageArtifactId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  MAX_IMAGE_PROMPT_CHARACTERS,
  MAX_IMAGE_VARIANTS,
  type ImageGenerationCustomSource,
  type ImageGenerationScopeId,
  type ImageJob,
  type ImageJobThreadKind,
  type ProviderInstance,
  type ProviderInstanceId,
  type ProviderModelId,
} from "@octant/contracts";
import { hasEligibleImageProfile, listEligibleImageProfiles } from "@octant/domain";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
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
}

interface ImageToolInput {
  readonly prompt: string;
  readonly profileInstanceId?: ProviderInstanceId;
  readonly modelId?: ProviderModelId;
  readonly variantCount?: number;
  readonly parentAttachmentId?: string;
}

/**
 * App-managed image generation for a thread.
 *
 * Present only while Settings has an enabled image profile. The description
 * tells the agent to spend money only on an explicit user request; the tool
 * still refuses credentials, endpoints, and filesystem paths.
 */
export function createImageAgentTools(options: {
  readonly threadKind: ImageJobThreadKind;
  readonly scopeId: ImageGenerationScopeId;
  readonly port: ImageAgentToolPort;
}): AppManagedToolSet | undefined {
  const instances = options.port.listInstances();
  const customSources = options.port.readImageGenerationCustomSources();
  if (!hasEligibleImageProfile(instances, customSources)) return undefined;
  return {
    definitions: [
      {
        name: IMAGE_TOOL_NAME,
        description:
          "Generate or edit an image only when the user explicitly asked to create, generate, draw, or edit an image. Do not call this tool for ambiguous, decorative, or implied visuals. This call spends money. Use only Settings image profiles; never pass credentials, endpoints, headers, or filesystem paths.",
        inputSchema: imageToolInputSchema,
      },
    ],
    execute: async ({ name, inputJson }) => {
      if (name !== IMAGE_TOOL_NAME) {
        return { result: { error: "tool-unavailable" }, isError: true };
      }
      const parsed = parseInput(inputJson);
      if ("error" in parsed) return { result: { error: parsed.error }, isError: true };

      const profiles = listEligibleImageProfiles(
        options.port.listInstances(),
        options.port.readImageGenerationCustomSources(),
      );
      if (profiles.length === 0) {
        return { result: { error: "No enabled image profile is configured." }, isError: true };
      }
      const selected =
        parsed.profileInstanceId === undefined
          ? profiles[0]
          : profiles.find(
              (profile) => String(profile.instanceId) === String(parsed.profileInstanceId),
            );
      if (selected === undefined) {
        return { result: { error: "The image profile is not eligible." }, isError: true };
      }
      const modelId = parsed.modelId ?? selected.defaultModel;
      if (!selected.modelAllowlist.some((id) => String(id) === String(modelId))) {
        return {
          result: { error: "The selected model is not on this image profile's allowlist." },
          isError: true,
        };
      }

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

      try {
        const job = await options.port.enqueue({
          threadKind: options.threadKind,
          scopeId: options.scopeId,
          profileInstanceId: selected.instanceId,
          modelId,
          prompt: parsed.prompt,
          ...(parsed.variantCount === undefined ? {} : { variantCount: parsed.variantCount }),
          ...(parentArtifactRef === undefined ? {} : { parentArtifactRef }),
        });
        return {
          result: {
            jobId: job.id,
            status: job.status,
            modelId: job.modelId,
            profileInstanceId: job.profileInstanceId,
          },
        };
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
