import "../styles/canvas-inline.css";
import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { ThreadCanvasPreviewReceipt } from "@octant/contracts";
import { type CanvasDefinition, type CanvasId, decodeCanvasId } from "@octant/contracts/canvas";
import { useEffect, useMemo, useRef, useState } from "react";
import { CanvasView } from "./CanvasView";
import type { DesignAssetRuntime } from "./blocks/designDocument";

type LoadedVersion =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly definition: CanvasDefinition; readonly sequence: number }
  | { readonly kind: "unavailable" };

/**
 * The Canvas version an agent's preview drew, inside that preview's opened
 * tool row, so a person can see what the agent checked. The step keeps only
 * the reference; the version is read here under the window's own Canvas
 * authority, and a Canvas this window cannot read shows a plain line instead.
 * The miniature is decorative and inert: nothing in it takes focus or a click.
 */
export function CanvasPreviewMiniature(props: {
  readonly client: CanvasClient;
  readonly preview: ThreadCanvasPreviewReceipt;
}) {
  const { client } = props;
  const { versionId } = props.preview;
  // A reference the step kept that is not a Canvas id reads as unavailable.
  const canvasId = useMemo(() => decodedCanvasId(props.preview.canvasId), [props.preview.canvasId]);
  const [loaded, setLoaded] = useState<LoadedVersion>({ kind: "loading" });
  const [hasUnrecordedProjectImages, setHasUnrecordedProjectImages] = useState(false);
  const activeVersionKey = useRef("");
  useEffect(() => {
    activeVersionKey.current = `${String(canvasId ?? "")}:${versionId}`;
    setHasUnrecordedProjectImages(false);
  }, [canvasId, versionId]);
  // The images the agent's preview drew (a generated image, a design's
  // declared assets), resolved by the host for this exact version under its
  // own thread authority, always comparing recorded Project image digests so a
  // replaced file is never shown as what was previewed.
  const designAssetRuntime = useMemo<DesignAssetRuntime | undefined>(() => {
    const designAssets = client.designAssets;
    if (designAssets === undefined || canvasId === undefined) return undefined;
    const requestKey = `${String(canvasId)}:${versionId}`;
    return {
      resolve: async (blockId) => {
        const outcome = await designAssets({
          canvasId,
          versionId,
          blockId,
          marks: "recorded",
        });
        if (outcome.kind !== "ready") return undefined;
        if (
          activeVersionKey.current === requestKey &&
          outcome.assets.some((asset) => asset.status === "resolved" && asset.mark === "unrecorded")
        ) {
          setHasUnrecordedProjectImages(true);
        }
        return outcome.assets;
      },
    };
  }, [canvasId, client, versionId]);
  useEffect(() => {
    if (canvasId === undefined) {
      setLoaded({ kind: "unavailable" });
      return;
    }
    let cancelled = false;
    setLoaded({ kind: "loading" });
    client
      .get(canvasId, versionId)
      .then((outcome) => {
        if (cancelled) return;
        setLoaded(
          outcome.kind === "ready"
            ? {
                kind: "ready",
                definition: outcome.version.definition,
                sequence: outcome.version.sequence,
              }
            : { kind: "unavailable" },
        );
      })
      .catch(() => {
        if (!cancelled) setLoaded({ kind: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [canvasId, client, versionId]);

  if (loaded.kind === "unavailable") {
    return <p className="canvas-preview-shot__caption">The previewed Canvas is unavailable.</p>;
  }
  return (
    <figure className="canvas-preview-shot">
      {loaded.kind === "ready" ? (
        <>
          <span aria-hidden="true" className="canvas-preview-shot__frame" inert>
            <span className="canvas-preview-shot__page">
              <CanvasView
                input={loaded.definition}
                placement="thread"
                {...(designAssetRuntime === undefined ? {} : { designAssetRuntime })}
              />
            </span>
          </span>
          <figcaption className="canvas-preview-shot__caption">
            {`Version ${String(loaded.sequence)}, previewed by the agent`}
            {hasUnrecordedProjectImages ? (
              <span className="canvas-preview-shot__note">
                Project images are shown as they are now
              </span>
            ) : null}
          </figcaption>
        </>
      ) : (
        <figcaption className="canvas-preview-shot__caption">
          Loading the previewed Canvas
        </figcaption>
      )}
    </figure>
  );
}

function decodedCanvasId(value: string): CanvasId | undefined {
  try {
    return decodeCanvasId(value);
  } catch {
    return undefined;
  }
}
