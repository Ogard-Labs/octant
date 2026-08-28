import type { ImageArtifactRecord, ImageGenerationProfileView, ImageJob } from "@octant/contracts";
import type { ImageGenerationClient } from "@octant/client-runtime/image-generation-client";
import { useEffect, useState } from "react";
import { selectPreviewViewer } from "../preview/previewViewers";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCard } from "../ui/base/OctantCard";

export interface GeneratedImageCardProps {
  readonly job: ImageJob;
  readonly artifact: ImageArtifactRecord;
  readonly profiles: ReadonlyArray<ImageGenerationProfileView>;
  readonly client: ImageGenerationClient;
  readonly onAttach?: (file: File) => void;
  readonly onRevise?: (job: ImageJob, artifact: ImageArtifactRecord) => void;
  readonly onSaveToProject?: (job: ImageJob, artifact: ImageArtifactRecord) => void;
  readonly canSaveToProject?: boolean;
}

export function GeneratedImageCard(props: GeneratedImageCardProps) {
  const [preview, setPreview] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const profile = props.profiles.find(
    (candidate) => String(candidate.instanceId) === String(props.job.profileInstanceId),
  );
  const attribution =
    profile === undefined
      ? String(props.job.modelId)
      : `${profile.displayName} · ${String(props.job.modelId)}`;

  useEffect(() => {
    let cancelled = false;
    void props.client
      .artifact(props.job.id, props.artifact.attachmentId)
      .then(async (blob) => {
        const dataUrl = await blobToDataUrl(blob);
        if (!cancelled) setPreview(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setMessage("Image is unavailable.");
      });
    return () => {
      cancelled = true;
    };
  }, [props.artifact.attachmentId, props.client, props.job.id]);

  const viewer = selectPreviewViewer("image");
  const chunks =
    preview === undefined ? [] : [{ payload: { kind: "image" as const, dataUrl: preview } }];

  async function download() {
    const blob = await props.client.artifact(props.job.id, props.artifact.attachmentId);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `generated-${String(props.artifact.attachmentId).slice(0, 8)}.png`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function attach() {
    if (props.onAttach === undefined) return;
    const blob = await props.client.artifact(props.job.id, props.artifact.attachmentId);
    const file = new File([blob], `generated.png`, { type: props.artifact.mime });
    props.onAttach(file);
  }

  return (
    <OctantCard className="p-4" data-testid="generated-image-card">
      <p className="meta" data-testid="generated-image-attribution">
        {attribution}
      </p>
      {viewer === undefined
        ? null
        : viewer.render({
            chunks: chunks as never,
            ...(message === undefined ? {} : { message }),
          })}
      <div className="row">
        {props.onAttach === undefined ? null : (
          <OctantButton onClick={() => void attach()} size="sm" type="button" variant="secondary">
            Attach
          </OctantButton>
        )}
        {props.onRevise === undefined ? null : (
          <OctantButton
            onClick={() => props.onRevise?.(props.job, props.artifact)}
            size="sm"
            type="button"
            variant="secondary"
          >
            Revise
          </OctantButton>
        )}
        <OctantButton onClick={() => void download()} size="sm" type="button" variant="secondary">
          Download
        </OctantButton>
        {props.canSaveToProject === true ? (
          <OctantButton
            onClick={() => props.onSaveToProject?.(props.job, props.artifact)}
            size="sm"
            type="button"
            variant="secondary"
          >
            Save to Project
          </OctantButton>
        ) : null}
      </div>
    </OctantCard>
  );
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Image preview is unavailable."));
    };
    reader.onerror = () => reject(new Error("Image preview is unavailable."));
    reader.readAsDataURL(blob);
  });
}
