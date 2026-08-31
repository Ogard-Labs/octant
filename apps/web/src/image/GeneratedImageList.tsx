import type {
  ImageArtifactRecord,
  ImageGenerationProfileView,
  ImageGenerationScopeId,
  ImageJob,
  ImageJobThreadKind,
} from "@octant/contracts";
import type { ImageGenerationClient } from "@octant/client-runtime/image-generation-client";
import { useEffect, useRef, useState } from "react";
import { documentIsVisible, scheduleVisibleInterval } from "../polling/documentVisibility";
import { samePollingData } from "../polling/samePollingData";
import { GeneratedImageCard } from "./GeneratedImageCard";
import { ImageGenerationSheet } from "./ImageGenerationSheet";
import type { ImageGenerationDraft } from "./ImageGenerationSheet";

export interface GeneratedImageListProps {
  readonly client: ImageGenerationClient;
  readonly threadKind: ImageJobThreadKind;
  readonly scopeId: ImageGenerationScopeId;
  readonly profiles: ReadonlyArray<ImageGenerationProfileView>;
  readonly onAttach?: (file: File) => void;
  readonly onSaveToProject?: (job: ImageJob, artifact: ImageArtifactRecord) => void;
  readonly canSaveToProject?: boolean;
}

export function GeneratedImageList(props: GeneratedImageListProps) {
  const [jobs, setJobs] = useState<ReadonlyArray<ImageJob>>([]);
  const [revise, setRevise] = useState<
    { readonly job: ImageJob; readonly artifact: ImageArtifactRecord } | undefined
  >(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const inFlightGeneration = useRef<number | undefined>(undefined);
  const generation = useRef(0);
  const refreshRef = useRef<() => void>(() => undefined);
  const hasPendingJob = jobs.some((job) => job.status === "queued" || job.status === "running");

  useEffect(() => {
    let cancelled = false;
    const refreshGeneration = ++generation.current;
    setJobs([]);
    setRevise(undefined);
    setError(undefined);
    const refresh = () => {
      if (!documentIsVisible() || inFlightGeneration.current === refreshGeneration) {
        return;
      }
      inFlightGeneration.current = refreshGeneration;
      void props.client
        .list({ threadKind: props.threadKind, scopeId: props.scopeId })
        .then((outcome) => {
          if (cancelled || generation.current !== refreshGeneration) return;
          setJobs((current) => (samePollingData(current, outcome.jobs) ? current : outcome.jobs));
          setError(undefined);
        })
        .catch(() => {
          if (!cancelled && generation.current === refreshGeneration) {
            setError("Generated images are unavailable.");
          }
        })
        .finally(() => {
          if (inFlightGeneration.current === refreshGeneration) {
            inFlightGeneration.current = undefined;
          }
        });
    };
    refreshRef.current = refresh;
    refresh();
    return () => {
      cancelled = true;
    };
  }, [props.client, props.scopeId, props.threadKind]);

  useEffect(
    () => scheduleVisibleInterval(() => refreshRef.current(), hasPendingJob ? 750 : 4_000),
    [hasPendingJob],
  );

  async function submitRevision(draft: ImageGenerationDraft) {
    const parent = revise?.artifact;
    if (parent === undefined) return;
    await props.client.enqueue({
      threadKind: props.threadKind,
      scopeId: props.scopeId,
      profileInstanceId: draft.profile.instanceId,
      modelId: draft.modelId as never,
      prompt: draft.prompt,
      variantCount: draft.variantCount,
      ...(draft.quality === undefined ? {} : { quality: draft.quality }),
      ...(draft.size === undefined ? {} : { size: draft.size }),
      ...(draft.aspectRatio === undefined ? {} : { aspectRatio: draft.aspectRatio }),
      ...(draft.resolution === undefined ? {} : { resolution: draft.resolution as never }),
      parentArtifactRef: {
        attachmentId: parent.attachmentId,
        hash: parent.hash,
        size: parent.size,
        mime: parent.mime,
      },
    });
    setRevise(undefined);
  }

  if (error !== undefined) {
    return (
      <p data-testid="generated-image-list-error" role="status">
        {error}
      </p>
    );
  }
  if (jobs.length === 0) return null;

  return (
    <section aria-label="Generated images" className="stack" data-testid="generated-image-list">
      {jobs.map((job) => (
        <div key={String(job.id)}>
          {job.status !== "completed" ? (
            <p className="meta" role="status">
              {job.status === "queued"
                ? "Image queued…"
                : job.status === "running"
                  ? "Generating image…"
                  : job.status === "cancelled"
                    ? "Image generation cancelled."
                    : (job.safetyRefusal ?? job.failure?.message ?? "Image generation failed.")}
            </p>
          ) : (
            job.artifacts.map((artifact) => (
              <GeneratedImageCard
                artifact={artifact}
                client={props.client}
                job={job}
                key={String(artifact.attachmentId)}
                profiles={props.profiles}
                {...(props.canSaveToProject === undefined
                  ? {}
                  : { canSaveToProject: props.canSaveToProject })}
                {...(props.onAttach === undefined ? {} : { onAttach: props.onAttach })}
                {...(props.onSaveToProject === undefined
                  ? {}
                  : { onSaveToProject: props.onSaveToProject })}
                onRevise={(nextJob, nextArtifact) =>
                  setRevise({ job: nextJob, artifact: nextArtifact })
                }
              />
            ))
          )}
        </div>
      ))}
      {revise === undefined ? null : (
        <ImageGenerationSheet
          onClose={() => setRevise(undefined)}
          onSubmit={(draft) => void submitRevision(draft)}
          open
          parentArtifactRef={{
            attachmentId: revise.artifact.attachmentId,
            hash: revise.artifact.hash,
            size: revise.artifact.size,
            mime: revise.artifact.mime,
          }}
          profiles={props.profiles}
        />
      )}
    </section>
  );
}
