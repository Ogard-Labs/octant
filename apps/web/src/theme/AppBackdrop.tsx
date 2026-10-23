import type { ResolvedAppBackground } from "@octant/domain";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { runCharacterField } from "./appBackdropCharacters";
import { runMovingPrint } from "./appBackdropPrint";
import {
  decodePhoto,
  drawPrinted,
  watchDisplayPixelRatio,
  type DecodedPhoto,
} from "./appBackdropPhoto";

export type BackgroundImageFetcher = (backgroundId: string) => Promise<Blob>;

/** The new-thread start screens, the only place the shell's ground answers a click. */
const START_SCREEN_SELECTOR = ".draft-thread, .work-composer-adapter, .code-composer-adapter";

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
  const charactersCanvas = useRef<HTMLCanvasElement>(null);
  const pixelsCanvas = useRef<HTMLCanvasElement>(null);
  const wavesWithin = placement === "shell" ? START_SCREEN_SELECTOR : undefined;
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
    // A print set to Wave is drawn cell by cell so a click can move it; a
    // still print keeps the one-pass print below.
    if (resolved.backgroundAnimated && resolved.effect.kind !== "none") {
      return runMovingPrint(
        canvas,
        { picture: { source: photo.source, size: photo.size } },
        resolved.effect,
        true,
        wavesWithin,
      );
    }
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
  }, [
    photo,
    resolved.backgroundAnimated,
    resolved.effect.kind,
    resolved.effect.cell,
    resolved.effect.levels,
    wavesWithin,
  ]);

  const characters = resolved.kind === "characters";
  useEffect(() => {
    const canvas = charactersCanvas.current;
    if (!characters || canvas === null) return;
    return runCharacterField(canvas, resolved.backgroundAnimated, wavesWithin);
  }, [characters, wavesWithin, resolved.backgroundAnimated]);

  const pixels = resolved.kind === "pixels";
  useEffect(() => {
    const canvas = pixelsCanvas.current;
    if (!pixels || canvas === null) return;
    return runMovingPrint(canvas, {}, resolved.effect, resolved.backgroundAnimated, wavesWithin);
  }, [
    pixels,
    wavesWithin,
    resolved.backgroundAnimated,
    resolved.effect.kind,
    resolved.effect.cell,
    resolved.effect.levels,
  ]);

  if (!active) return null;

  const builtinUrl =
    resolved.kind === "builtin" && printedBuiltinUrl === null ? resolved.backgroundUrl : null;
  // Both pictures ride as custom properties and the stylesheet picks one by
  // the window's resolved scheme, so a theme switch swaps the ground without
  // a render. An inline background-image would outrank that choice.
  const builtinStyle =
    builtinUrl === null
      ? undefined
      : ({
          "--app-backdrop-image": `url("${builtinUrl}")`,
          ...(resolved.backgroundLightUrl === null
            ? {}
            : { "--app-backdrop-image-light": `url("${resolved.backgroundLightUrl}")` }),
        } as CSSProperties);

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
          style={builtinStyle}
        />
      )}
      {characters ? (
        <canvas
          className="app-backdrop__characters"
          data-animated={resolved.backgroundAnimated ? "true" : "false"}
          ref={charactersCanvas}
        />
      ) : null}
      {pixels ? (
        <canvas
          className="app-backdrop__pixels"
          data-animated={resolved.backgroundAnimated ? "true" : "false"}
          ref={pixelsCanvas}
        />
      ) : null}
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
