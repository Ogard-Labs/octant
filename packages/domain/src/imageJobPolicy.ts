import type {
  AggregateVersion,
  ImageGenerationCustomSource,
  ImageJob,
  ImageJobStatus,
  ProviderInstance,
  ProviderModelId,
} from "@octant/contracts";
import { IMAGE_JOB_TERMINAL_STATUSES, decodeImageJobStatus } from "@octant/contracts";
import { isImageProfileDriverKind } from "./providerPolicy";

export type ImageJobPolicyRejectionCode =
  | "unsupported-transition"
  | "stale-version"
  | "profile-ineligible"
  | "model-not-allowed"
  | "invalid-completion";

export class ImageJobPolicyRejected extends Error {
  override readonly name = "ImageJobPolicyRejected";

  constructor(
    readonly code: ImageJobPolicyRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(code: ImageJobPolicyRejectionCode, message: string): never {
  throw new ImageJobPolicyRejected(code, message);
}

const allowedTransitions: Record<ImageJobStatus, ReadonlyArray<ImageJobStatus>> = {
  queued: ["running", "cancelled", "failed"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isImageJobTerminalStatus(status: ImageJobStatus): boolean {
  return (IMAGE_JOB_TERMINAL_STATUSES as ReadonlyArray<string>).includes(status);
}

export function assertImageJobTransitionAllowed(from: ImageJobStatus, to: ImageJobStatus): void {
  decodeImageJobStatus(from);
  decodeImageJobStatus(to);
  if (from === to) {
    reject("unsupported-transition", `Image job is already ${from}.`);
  }
  if (!allowedTransitions[from].includes(to)) {
    reject("unsupported-transition", `Cannot transition an image job from ${from} to ${to}.`);
  }
  if (to === "completed" && from !== "running") {
    reject("invalid-completion", "Completed requires an observed running image job.");
  }
}

export function assertImageJobExpectedVersion(
  job: ImageJob,
  expectedVersion: AggregateVersion,
): void {
  if (job.version !== expectedVersion) {
    reject("stale-version", `Expected version ${expectedVersion}, got ${job.version}.`);
  }
}

/**
 * Image generation is bound to one Settings profile and that profile's
 * allowlist. The job service never retries a refusal on another profile.
 */
export function assertImageJobProfileEligible(
  instance: ProviderInstance,
  modelId: ProviderModelId,
): void {
  if (!instance.enabled) {
    reject("profile-ineligible", "The image profile is disabled.");
  }
  if (!isImageProfileDriverKind(instance.driverKind)) {
    reject("profile-ineligible", "The selected provider is not an image profile.");
  }
  const configuration = instance.configuration;
  if (
    configuration.kind !== "openai-image-http" &&
    configuration.kind !== "gemini-native-image-http" &&
    configuration.kind !== "bfl-image-http" &&
    configuration.kind !== "ideogram-image-http"
  ) {
    reject("profile-ineligible", "The selected provider is not an image profile.");
  }
  const allowlist = configuration.modelAllowlist;
  if (!allowlist.some((id) => String(id) === String(modelId))) {
    reject("model-not-allowed", "The selected model is not on this image profile's allowlist.");
  }
}

/**
 * A custom image source has no allowlist of its own: eligibility is exact
 * membership in the Settings-configured list, never an arbitrary model
 * string the caller happens to supply (`docs/decisions/0085`).
 */
export function assertCustomImageSourceEligible(
  instance: ProviderInstance,
  modelId: ProviderModelId,
  customSources: ReadonlyArray<ImageGenerationCustomSource>,
): void {
  if (!instance.enabled) {
    reject("profile-ineligible", "The image source is disabled.");
  }
  if (instance.driverKind !== "openai-compatible") {
    reject("profile-ineligible", "The selected provider is not an image source.");
  }
  const isRegistered = customSources.some(
    (source) =>
      String(source.providerInstanceId) === String(instance.id) &&
      String(source.modelId) === String(modelId),
  );
  if (!isRegistered) {
    reject("model-not-allowed", "This provider and model is not a configured image source.");
  }
}

export function nextImageJobVersion(version: AggregateVersion): AggregateVersion {
  return (version + 1) as AggregateVersion;
}
