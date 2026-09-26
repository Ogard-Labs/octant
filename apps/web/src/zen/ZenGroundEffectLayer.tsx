import type { ZenBackgroundFill, ZenGroundEffect } from "@octant/contracts/zen";
import { useEffect, useRef, useState } from "react";
import { watchDisplayPixelRatio, type PhotoSize } from "../theme/appBackdropPhoto";
import { drawZenGround } from "./zenGroundEffect";

export interface ZenGroundEffectLayerProps {
  /** The picture to print; an animated picture passes its still frame. */
  readonly src: string;
  readonly fill: ZenBackgroundFill;
  readonly effect: ZenGroundEffect;
}

/**
 * The picture ground, printed through the space's pixel or dither effect.
 *
 * It lies over the plain CSS ground and stays invisible until its first frame
 * is drawn, so choosing the effect never flashes an empty ground while the
 * picture decodes. A picture that cannot be read leaves the CSS ground as it
 * was rather than blanking it.
 */
export function ZenGroundEffectLayer({ src, fill, effect }: ZenGroundEffectLayerProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [picture, setPicture] = useState<{
    readonly source: HTMLImageElement;
    readonly size: PhotoSize;
  } | null>(null);
  const [painted, setPainted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (cancelled) return;
      setPicture({
        source: image,
        size: { width: image.naturalWidth, height: image.naturalHeight },
      });
    };
    image.onerror = () => {
      if (!cancelled) setPicture(null);
    };
    image.src = src;
    return () => {
      cancelled = true;
      setPicture(null);
      setPainted(false);
    };
  }, [src]);

  useEffect(() => {
    const target = canvas.current;
    if (picture === null || target === null) return;
    const paint = () => {
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const drawn = drawZenGround(
        target,
        picture.source,
        picture.size,
        { width: rect.width, height: rect.height },
        fill,
        effect,
      );
      setPainted(drawn);
    };
    paint();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(paint);
    observer?.observe(target);
    const stopPixelRatio = watchDisplayPixelRatio(paint);
    return () => {
      observer?.disconnect();
      stopPixelRatio();
    };
  }, [picture, fill, effect.kind, effect.cell, effect.levels]);

  return (
    <canvas
      aria-hidden="true"
      className="zen-ground-effect"
      data-effect={effect.kind}
      data-painted={painted ? "true" : "false"}
      ref={canvas}
    />
  );
}
