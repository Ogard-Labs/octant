import type {
  GeminiImageAspectRatio,
  ImageArtifactRef,
  ImageGenerationProfileView,
  ImageJob,
  OpenAiImageQuality,
  OpenAiImageSize,
} from "@octant/contracts";
import { honoredImageGenerationOptions, imageGenerationConfigurationKind } from "@octant/domain";
import { useMemo, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantTextarea } from "../ui/base/OctantTextarea";

export interface ImageGenerationDraft {
  readonly profile: ImageGenerationProfileView;
  readonly modelId: string;
  readonly prompt: string;
  readonly variantCount: number;
  readonly quality?: OpenAiImageQuality;
  readonly size?: OpenAiImageSize;
  readonly aspectRatio?: GeminiImageAspectRatio;
  readonly resolution?: string;
  readonly parentArtifactRef?: ImageArtifactRef;
}

export interface ImageGenerationSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly profiles: ReadonlyArray<ImageGenerationProfileView>;
  readonly onOpenSettings?: () => void;
  readonly onSubmit: (draft: ImageGenerationDraft) => Promise<void> | void;
  readonly onCancelJob?: () => void;
  readonly job?: ImageJob;
  readonly initialPrompt?: string;
  readonly parentArtifactRef?: ImageArtifactRef;
  readonly submitting?: boolean;
  readonly errorMessage?: string;
  readonly threadAvailable?: boolean;
}

const OPTION_DEFAULT = "(profile default)";

export function ImageGenerationSheet(props: ImageGenerationSheetProps) {
  const profiles = props.profiles;
  const first = profiles[0];
  const [profileId, setProfileId] = useState(first === undefined ? "" : String(first.instanceId));
  const profile = profiles.find((candidate) => String(candidate.instanceId) === profileId) ?? first;
  const options =
    profile === undefined
      ? undefined
      : honoredImageGenerationOptions(imageGenerationConfigurationKind(profile.driverKind));
  const models = profile?.modelAllowlist ?? [];
  const [modelId, setModelId] = useState(profile?.defaultModel ?? "");
  const [prompt, setPrompt] = useState(props.initialPrompt ?? "");
  const [variantCount, setVariantCount] = useState("1");
  const [quality, setQuality] = useState(OPTION_DEFAULT);
  const [size, setSize] = useState(OPTION_DEFAULT);
  const [aspectRatio, setAspectRatio] = useState(OPTION_DEFAULT);
  const [resolution, setResolution] = useState(OPTION_DEFAULT);

  const selectedProfileId = profile === undefined ? "" : String(profile.instanceId);
  const selectedModelId = useMemo(() => {
    if (profile === undefined) return "";
    if (models.some((id) => String(id) === modelId)) return modelId;
    return String(profile.defaultModel);
  }, [modelId, models, profile]);

  const job = props.job;
  const inFlight = job !== undefined && (job.status === "queued" || job.status === "running");
  const threadAvailable = props.threadAvailable !== false;
  const canSubmit =
    profile !== undefined &&
    prompt.trim().length > 0 &&
    threadAvailable &&
    props.submitting !== true &&
    !inFlight;

  function selectProfile(nextId: string) {
    setProfileId(nextId);
    const next = profiles.find((candidate) => String(candidate.instanceId) === nextId);
    if (next !== undefined) setModelId(String(next.defaultModel));
    setQuality(OPTION_DEFAULT);
    setSize(OPTION_DEFAULT);
    setAspectRatio(OPTION_DEFAULT);
    setResolution(OPTION_DEFAULT);
  }

  async function submit() {
    if (!canSubmit || profile === undefined) return;
    const draft: ImageGenerationDraft = {
      profile,
      modelId: selectedModelId,
      prompt: prompt.trim(),
      variantCount: Number(variantCount),
      ...(props.parentArtifactRef === undefined
        ? {}
        : { parentArtifactRef: props.parentArtifactRef }),
    };
    if (options?.kind === "openai-image-http") {
      await props.onSubmit({
        ...draft,
        ...(quality === OPTION_DEFAULT ? {} : { quality: quality as OpenAiImageQuality }),
        ...(size === OPTION_DEFAULT ? {} : { size: size as OpenAiImageSize }),
      });
      return;
    }
    await props.onSubmit({
      ...draft,
      ...(aspectRatio === OPTION_DEFAULT
        ? {}
        : { aspectRatio: aspectRatio as GeminiImageAspectRatio }),
      ...(resolution === OPTION_DEFAULT ? {} : { resolution }),
    });
  }

  return (
    <OctantDialog label="Create image" onClose={props.onClose} open={props.open}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 className="h4">
          {props.parentArtifactRef === undefined ? "Create image" : "Revise image"}
        </h2>
        {profiles.length === 0 ? (
          <p role="status">
            No image profile is ready.{" "}
            {props.onOpenSettings === undefined ? (
              "Add one in Settings."
            ) : (
              <OctantButton onClick={props.onOpenSettings} type="button" variant="link">
                Open Settings
              </OctantButton>
            )}
          </p>
        ) : (
          <>
            <label>
              <span>Image profile</span>
              <OctantSelectField
                aria-label="Image profile"
                onValueChange={selectProfile}
                options={profiles.map((candidate) => ({
                  id: String(candidate.instanceId),
                  label: candidate.displayName,
                }))}
                value={selectedProfileId}
              />
            </label>
            <label>
              <span>Model</span>
              <OctantSelectField
                aria-label="Image model"
                onValueChange={setModelId}
                options={models.map((id) => ({ id: String(id), label: String(id) }))}
                value={selectedModelId}
              />
            </label>
            <label>
              <span>Prompt</span>
              <OctantTextarea
                aria-label="Image prompt"
                onChange={(event) => setPrompt(event.currentTarget.value)}
                placeholder="Describe the image…"
                rows={4}
                value={prompt}
              />
            </label>
            {options?.kind === "openai-image-http" ? (
              <>
                <label>
                  <span>Quality</span>
                  <OctantSelectField
                    aria-label="Quality"
                    onValueChange={setQuality}
                    options={[
                      { id: OPTION_DEFAULT, label: "Profile default" },
                      ...options.qualities.map((value) => ({ id: value, label: value })),
                    ]}
                    value={quality}
                  />
                </label>
                <label>
                  <span>Size</span>
                  <OctantSelectField
                    aria-label="Size"
                    onValueChange={setSize}
                    options={[
                      { id: OPTION_DEFAULT, label: "Profile default" },
                      ...options.sizes.map((value) => ({ id: value, label: value })),
                    ]}
                    value={size}
                  />
                </label>
              </>
            ) : null}
            {options?.kind === "gemini-native-image-http" ? (
              <>
                <label>
                  <span>Aspect ratio</span>
                  <OctantSelectField
                    aria-label="Aspect ratio"
                    onValueChange={setAspectRatio}
                    options={[
                      { id: OPTION_DEFAULT, label: "Profile default" },
                      ...options.aspectRatios.map((value) => ({ id: value, label: value })),
                    ]}
                    value={aspectRatio}
                  />
                </label>
                <label>
                  <span>Resolution</span>
                  <OctantSelectField
                    aria-label="Resolution"
                    onValueChange={setResolution}
                    options={[
                      { id: OPTION_DEFAULT, label: "Profile default" },
                      ...options.resolutions.map((value) => ({ id: value, label: value })),
                    ]}
                    value={resolution}
                  />
                </label>
              </>
            ) : null}
            <label>
              <span>Variants</span>
              <OctantSelectField
                aria-label="Variant count"
                onValueChange={setVariantCount}
                options={Array.from({ length: options?.maxVariants ?? 4 }, (_, index) => {
                  const count = String(index + 1);
                  return { id: count, label: count };
                })}
                value={variantCount}
              />
            </label>
            {threadAvailable ? null : <p role="status">Start a thread to create an image.</p>}
            {job === undefined ? null : (
              <p role="status">
                {job.status === "queued"
                  ? "Queued…"
                  : job.status === "running"
                    ? "Generating…"
                    : job.status === "completed"
                      ? "Completed."
                      : job.status === "cancelled"
                        ? "Cancelled."
                        : (job.safetyRefusal ?? job.failure?.message ?? "Failed.")}
              </p>
            )}
            {props.errorMessage === undefined ? null : <p role="alert">{props.errorMessage}</p>}
          </>
        )}
        <div className="row">
          {inFlight && props.onCancelJob !== undefined ? (
            <OctantButton onClick={props.onCancelJob} type="button" variant="secondary">
              Cancel
            </OctantButton>
          ) : (
            <OctantButton disabled={!canSubmit} type="submit">
              Generate
            </OctantButton>
          )}
          <OctantButton onClick={props.onClose} type="button" variant="ghost">
            Close
          </OctantButton>
        </div>
      </form>
    </OctantDialog>
  );
}
