import "../styles/canvas-inline.css";
import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { ThreadCanvasPreviewReceipt } from "@octant/contracts";
import { type CanvasDefinition, decodeCanvasId } from "@octant/contracts/canvas";
import { useEffect, useState } from "react";
import { CanvasView } from "./CanvasView";

type LoadedVersion =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly definition: CanvasDefinition }
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
  const { canvasId, versionId, sequence } = props.preview;
  const [loaded, setLoaded] = useState<LoadedVersion>({ kind: "loading" });
  useEffect(() => {
    let id;
    try {
      id = decodeCanvasId(canvasId);
    } catch {
      setLoaded({ kind: "unavailable" });
      return;
    }
    let cancelled = false;
    setLoaded({ kind: "loading" });
    client
      .get(id, versionId)
      .then((outcome) => {
        if (cancelled) return;
        setLoaded(
          outcome.kind === "ready"
            ? { kind: "ready", definition: outcome.version.definition }
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
        <span aria-hidden="true" className="canvas-preview-shot__frame" inert>
          <span className="canvas-preview-shot__page">
            <CanvasView input={loaded.definition} placement="thread" />
          </span>
        </span>
      ) : null}
      <figcaption className="canvas-preview-shot__caption">
        {`Version ${String(sequence)}, as the agent previewed it`}
      </figcaption>
    </figure>
  );
}
