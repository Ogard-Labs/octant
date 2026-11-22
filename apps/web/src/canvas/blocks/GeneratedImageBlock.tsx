import { useEffect, useState } from "react";
import {
  CANVAS_IMAGE_BLOCK_ASSET_ID,
  type CanvasDesignAssetResolution,
  type CanvasImageBlock,
} from "@octant/contracts/canvas";
import type { DesignAssetRuntime } from "./designDocument";

type Drawn =
  | { readonly kind: "loading" }
  | { readonly kind: "drawn"; readonly url: string }
  | { readonly kind: "unavailable" };

function drawnFrom(assets: ReadonlyArray<CanvasDesignAssetResolution> | undefined): Drawn {
  const outcome = assets?.find(
    (entry) => String(entry.assetId) === String(CANVAS_IMAGE_BLOCK_ASSET_ID),
  );
  return outcome?.status === "resolved"
    ? { kind: "drawn", url: `data:${outcome.mediaType};base64,${outcome.data}` }
    : { kind: "unavailable" };
}

/**
 * An image block that draws a generated image. The host is asked each time
 * the block is drawn, under the Canvas version's own thread authority, so a
 * deleted image job or a reader who may no longer see it gets the frame that
 * says the image is unavailable, never a stale picture.
 */
export function GeneratedImageBlock({
  block,
  runtime,
}: {
  readonly block: CanvasImageBlock;
  readonly runtime: DesignAssetRuntime | undefined;
}) {
  const [drawn, setDrawn] = useState<Drawn>(
    runtime === undefined ? { kind: "unavailable" } : { kind: "loading" },
  );
  useEffect(() => {
    if (runtime === undefined) {
      setDrawn({ kind: "unavailable" });
      return;
    }
    setDrawn({ kind: "loading" });
    let current = true;
    runtime
      .resolve(String(block.blockId))
      .then((assets) => {
        if (current) setDrawn(drawnFrom(assets));
      })
      .catch(() => {
        if (current) setDrawn({ kind: "unavailable" });
      });
    return () => {
      current = false;
    };
  }, [block, runtime]);
  return (
    <figure className="canvas-block__image">
      {drawn.kind === "drawn" ? (
        <img className="canvas-block__image-picture" src={drawn.url} alt={block.alt} />
      ) : (
        <div role="img" aria-label={block.alt} className="canvas-block__image-frame">
          <span>{drawn.kind === "loading" ? "Loading image" : "Image unavailable"}</span>
        </div>
      )}
      <figcaption>{block.caption ?? block.alt}</figcaption>
    </figure>
  );
}
