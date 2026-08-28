import type {
  ImageArtifactRef,
  ImageGenerationEnqueueRequest,
  ImageGenerationProfileView,
  ImageGenerationScopeId,
  ImageJob,
  ImageJobThreadKind,
} from "@octant/contracts";
import type { ImageGenerationClient } from "@octant/client-runtime/image-generation-client";
import { Image as ImageIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { ImageGenerationSheet, type ImageGenerationDraft } from "./ImageGenerationSheet";

export interface ImageGenerationActionProps {
  readonly profiles: ReadonlyArray<ImageGenerationProfileView>;
  readonly onOpenSettings?: () => void;
  readonly client?: ImageGenerationClient;
  readonly threadKind: ImageJobThreadKind;
  readonly scopeId?: ImageGenerationScopeId;
  readonly parentArtifactRef?: ImageArtifactRef;
  readonly disabled?: boolean;
}

export function ImageGenerationAction(props: ImageGenerationActionProps) {
  const [open, setOpen] = useState(false);
  const [job, setJob] = useState<ImageJob | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const ready = props.profiles.length > 0;
  const threadAvailable = props.scopeId !== undefined;
  const mountedRef = useRef(true);
  const pollGenerationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pollGenerationRef.current += 1;
    };
  }, []);

  async function submit(draft: ImageGenerationDraft) {
    if (props.client === undefined || props.scopeId === undefined) return;
    const pollGeneration = pollGenerationRef.current + 1;
    pollGenerationRef.current = pollGeneration;
    setSubmitting(true);
    setErrorMessage(undefined);
    const request: ImageGenerationEnqueueRequest = {
      threadKind: props.threadKind,
      scopeId: props.scopeId,
      profileInstanceId: draft.profile.instanceId,
      modelId: draft.modelId as ImageGenerationEnqueueRequest["modelId"],
      prompt: draft.prompt,
      variantCount: draft.variantCount,
      ...(draft.quality === undefined ? {} : { quality: draft.quality }),
      ...(draft.size === undefined ? {} : { size: draft.size }),
      ...(draft.aspectRatio === undefined ? {} : { aspectRatio: draft.aspectRatio }),
      ...(draft.resolution === undefined
        ? {}
        : { resolution: draft.resolution as ImageGenerationEnqueueRequest["resolution"] }),
      ...(draft.parentArtifactRef === undefined
        ? {}
        : { parentArtifactRef: draft.parentArtifactRef }),
    };
    try {
      const queued = await props.client.enqueue(request);
      if (!mountedRef.current || pollGeneration !== pollGenerationRef.current) return;
      setJob(queued);
      void poll(queued, pollGeneration);
    } catch (error) {
      if (!mountedRef.current || pollGeneration !== pollGenerationRef.current) return;
      setErrorMessage(error instanceof Error ? error.message : "Image generation failed.");
    } finally {
      if (mountedRef.current && pollGeneration === pollGenerationRef.current) {
        setSubmitting(false);
      }
    }
  }

  async function poll(current: ImageJob, pollGeneration: number) {
    if (props.client === undefined) return;
    let next = current;
    while (next.status === "queued" || next.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 750));
      if (!mountedRef.current || pollGeneration !== pollGenerationRef.current) return;
      try {
        next = await props.client.get(next.id);
        if (!mountedRef.current || pollGeneration !== pollGenerationRef.current) return;
        setJob(next);
      } catch (error) {
        if (!mountedRef.current || pollGeneration !== pollGenerationRef.current) return;
        setErrorMessage(error instanceof Error ? error.message : "Image generation failed.");
        return;
      }
    }
  }

  async function cancel() {
    if (props.client === undefined || job === undefined) return;
    try {
      setJob(await props.client.cancel(job.id));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Cancellation failed.");
    }
  }

  return (
    <>
      {ready ? (
        <OctantButton
          aria-label="Create image"
          disabled={props.disabled === true}
          onClick={() => {
            setOpen(true);
            setJob(undefined);
            setErrorMessage(undefined);
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          <ImageIcon aria-hidden="true" size={14} strokeWidth={1.7} />
          <span>Create image…</span>
        </OctantButton>
      ) : (
        <OctantButton
          aria-label="Create image unavailable. Open Settings to add an image profile."
          disabled={props.onOpenSettings === undefined}
          onClick={props.onOpenSettings}
          size="sm"
          title="Open Settings to add an image profile."
          type="button"
          variant="ghost"
        >
          <ImageIcon aria-hidden="true" size={14} strokeWidth={1.7} />
          <span>Create image…</span>
        </OctantButton>
      )}
      <ImageGenerationSheet
        {...(job === undefined ? {} : { job })}
        {...(props.onOpenSettings === undefined ? {} : { onOpenSettings: props.onOpenSettings })}
        {...(props.parentArtifactRef === undefined
          ? {}
          : { parentArtifactRef: props.parentArtifactRef })}
        {...(errorMessage === undefined ? {} : { errorMessage })}
        onCancelJob={() => void cancel()}
        onClose={() => setOpen(false)}
        onSubmit={(draft) => void submit(draft)}
        open={open}
        profiles={props.profiles}
        submitting={submitting}
        threadAvailable={threadAvailable}
      />
    </>
  );
}
