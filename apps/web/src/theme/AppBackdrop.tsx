import type { ResolvedAppBackground } from "@octant/domain";
import { useEffect, useRef, useState } from "react";
import {
  decodePhoto,
  drawPrinted,
  watchDisplayPixelRatio,
  type DecodedPhoto,
} from "./appBackdropPhoto";

export type BackgroundImageFetcher = (backgroundId: string) => Promise<Blob>;

/**
 * Where the ground is drawn: under one welcome surface, masked away behind
 * its composer; under the whole shell, where there is no composer to clear
 * and only the edges soften; or under a Zen space, which fills the window
 * edge to edge.
 */
export type AppBackdropPlacement = "welcome" | "shell" | "zen";

export interface AppBackdropProps {
  readonly resolved: ResolvedAppBackground;
  /** Reads a photo through the window's authenticated background route. */
  readonly fetcher: BackgroundImageFetcher;
  readonly placement: AppBackdropPlacement;
}

export function AppBackdrop({ resolved, fetcher, placement }: AppBackdropProps) {
  const photoCanvas = useRef<HTMLCanvasElement>(null);
  const [photo, setPhoto] = useState<DecodedPhoto | null>(null);
  const active = resolved.kind !== "none";
  const photoId = resolved.kind === "photo" ? resolved.backgroundId : null;
  // A built-in printed through an effect is drawn on the canvas from its
  // still frame, like a photo; left plain it stays a CSS image, which keeps
  // an animated preset moving.
  const printedBuiltinUrl =
    resolved.kind === "builtin" && resolved.effect.kind !== "none"
      ? resolved.backgroundStillUrl
      : null;
  const pictureSource = photoId ?? printedBuiltinUrl;

  useEffect(() => {
    if (pictureSource === null) {
      setPhoto(null);
      return;
    }
    let cancelled = false;
    let decoded: DecodedPhoto | null = null;
    const read =
      photoId !== null
        ? fetcher(photoId)
        : fetch(pictureSource).then((response) => {
            if (!response.ok) throw new Error("The built-in background could not be read.");
            return response.blob();
          });
    read
      .then(decodePhoto)
      .then((result) => {
        if (cancelled) {
          result.release();
          return;
        }
        decoded = result;
        setPhoto(result);
      })
      .catch(() => {
        if (!cancelled) setPhoto(null);
      });
    return () => {
      cancelled = true;
      decoded?.release();
      setPhoto(null);
    };
  }, [fetcher, photoId, pictureSource]);

  useEffect(() => {
    const canvas = photoCanvas.current;
    if (photo === null || canvas === null) return;
    const paint = () => {
      const rect = canvas.getBoundingClientRect();
      const viewport = { width: rect.width, height: rect.height };
      drawPrinted(canvas, photo.source, photo.size, viewport, resolved.effect);
    };
    paint();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(paint);
    observer?.observe(canvas);
    const stopPixelRatio = watchDisplayPixelRatio(paint);
    return () => {
      observer?.disconnect();
      stopPixelRatio();
    };
  }, [photo, resolved.effect.kind, resolved.effect.cell, resolved.effect.levels]);

  if (!active) return null;

  const builtinUrl =
    resolved.kind === "builtin" && printedBuiltinUrl === null ? resolved.backgroundUrl : null;

  return (
    <div
      aria-hidden="true"
      className="app-backdrop"
      data-octant-app-backdrop={resolved.kind}
      data-placement={placement}
    >
      {builtinUrl === null ? null : (
        <div
          aria-hidden="true"
          className="app-backdrop__builtin"
          data-animated={resolved.backgroundAnimated ? "true" : "false"}
          style={{ backgroundImage: `url("${builtinUrl}")` }}
        />
      )}
      {pictureSource === null ? null : (
        <canvas
          className="app-backdrop__photo"
          data-dithered={resolved.effect.kind === "none" ? "false" : "true"}
          data-effect={resolved.effect.kind}
          data-photo-ready={photo !== null}
          ref={photoCanvas}
          // A photo sits under the page at its own strength; a built-in fills
          // the ground the way its plain CSS image does.
          style={{ opacity: photoId === null ? 1 : resolved.photoOpacity }}
        />
      )}
    </div>
  );
}
