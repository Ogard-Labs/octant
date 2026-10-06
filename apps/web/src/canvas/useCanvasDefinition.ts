import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasDefinition } from "@octant/contracts/canvas";
import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import { useEffect, useState } from "react";

export type LoadedCanvas =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly definition: CanvasDefinition }
  | { readonly kind: "unavailable" };

/**
 * The current version of a thread's Canvas, read from the host. A revision
 * (a new version id) swaps the document in place: blanking it first would
 * make the thread jump while the new version loads.
 */
export function useCanvasDefinition(
  client: CanvasClient | undefined,
  card: Pick<CanvasThreadReferenceCard, "canvasId" | "versionId">,
  enabled = true,
): LoadedCanvas {
  const [loaded, setLoaded] = useState<LoadedCanvas>({ kind: "loading" });
  const { canvasId, versionId } = card;
  useEffect(() => {
    if (!enabled || client === undefined) return;
    let cancelled = false;
    setLoaded((current) => (current.kind === "ready" ? current : { kind: "loading" }));
    void client
      .get(canvasId)
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
    // The version id changes when the Canvas is revised; read it again then.
  }, [canvasId, client, enabled, versionId]);
  return loaded;
}
