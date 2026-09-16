import type { ResolvedAppBackground } from "@octant/domain";
import { useEffect, useRef, useState } from "react";
import {
  decodePhoto,
  drawDitheredPhoto,
  drawPhoto,
  watchDisplayPixelRatio,
  type DecodedPhoto,
} from "./appBackdropPhoto";
import { startAppPattern, type AppPatternHandle, type InkRgb } from "./appBackdropPattern";

export type BackgroundImageFetcher = (backgroundId: string) => Promise<Blob>;

/**
 * Where the ground is drawn: under one welcome surface, masked away behind
 * its composer; under the whole shell, where there is no composer to clear
 * and only the edges soften; or under a Zen space, which fills the window
 * edge to edge and wants the whole cloud, unmasked, as its floor.
 */
export type AppBackdropPlacement = "welcome" | "shell" | "zen";

export interface AppBackdropProps {
  readonly resolved: ResolvedAppBackground;
  /** Reads a photo through the window's authenticated background route. */
  readonly fetcher: BackgroundImageFetcher;
  readonly placement: AppBackdropPlacement;
}

interface ThemeInk {
  readonly palette: ReadonlyArray<InkRgb>;
  readonly mode: "light" | "dark";
}

// Mid grey is what the pattern draws before any theme has been applied, and
// in a test document that never applies one; the provider replaces it on the
// first paint of a real theme.
const FALLBACK_INK: InkRgb = [0.56, 0.56, 0.56];

function parseHexInk(value: string): InkRgb | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (match === null) return null;
  const hex = match[1] ?? "";
  return [
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255,
  ];
}

function readThemeInk(): ThemeInk {
  const root = document.documentElement;
  const accent = getComputedStyle(root).getPropertyValue("--octant-accent");
  const fallback = parseHexInk(accent) ?? FALLBACK_INK;
  const count = Number.parseInt(root.dataset.octantPatternInkCount ?? "1", 10);
  const palette = Array.from(
    { length: Number.isFinite(count) ? Math.max(1, count) : 1 },
    (_, index) =>
      parseHexInk(
        getComputedStyle(root).getPropertyValue(`--octant-pattern-ink-${String(index + 1)}`),
      ),
  ).filter((value): value is InkRgb => value !== null);
  return {
    palette: palette.length === 0 ? [fallback] : palette,
    mode: root.dataset.octantThemeMode === "light" ? "light" : "dark",
  };
}

function sameInk(left: ThemeInk, right: ThemeInk): boolean {
  return (
    left.mode === right.mode &&
    left.palette.length === right.palette.length &&
    left.palette.every((color, index) => {
      const other = right.palette[index];
      return (
        other !== undefined &&
        color.every((channel, channelIndex) => channel === other[channelIndex])
      );
    })
  );
}

/**
 * The bounded pattern palette the theme provider painted on the root, kept
 * current as the theme changes. The provider writes inline custom properties,
 * so watching the root's `style` attribute is what makes a preset switch
 * recolour the ground without a reload.
 */
function useThemeInk(): ThemeInk {
  const [ink, setInk] = useState<ThemeInk>(readThemeInk);
  useEffect(() => {
    const update = () => {
      const next = readThemeInk();
      setInk((current) => (sameInk(current, next) ? current : next));
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "data-octant-theme-mode"],
    });
    return () => observer.disconnect();
  }, []);
  return ink;
}

export function AppBackdrop({ resolved, fetcher, placement }: AppBackdropProps) {
  const ink = useThemeInk();
  const patternCanvas = useRef<HTMLCanvasElement>(null);
  const photoCanvas = useRef<HTMLCanvasElement>(null);
  const pattern = useRef<AppPatternHandle | null>(null);
  const [patternSupported, setPatternSupported] = useState(true);
  const [photo, setPhoto] = useState<DecodedPhoto | null>(null);
  const active = resolved.kind !== "none";
  const photoId = resolved.kind === "photo" ? resolved.backgroundId : null;
  const showPattern = resolved.patternEnabled && patternSupported && resolved.patternOpacity > 0;

  useEffect(() => {
    const canvas = patternCanvas.current;
    if (!active || canvas === null || !showPattern) return;
    const handle = startAppPattern(canvas, {
      ink: ink.palette[0] ?? FALLBACK_INK,
      palette: ink.palette,
      animated: resolved.animated,
      speed: resolved.patternSpeed,
      intensity: resolved.patternIntensity,
    });
    if (handle === null) {
      setPatternSupported(false);
      return;
    }
    pattern.current = handle;
    return () => {
      handle.stop();
      pattern.current = null;
    };
    // The ink and the dials are pushed into the running loop below;
    // restarting it for any of them would drop the cloud back to its first
    // frame every time a slider moved.
  }, [active, showPattern]);

  useEffect(() => {
    pattern.current?.setPalette(ink.palette);
  }, [ink]);

  useEffect(() => {
    pattern.current?.setAnimated(resolved.animated);
  }, [resolved.animated]);

  useEffect(() => {
    pattern.current?.setSpeed(resolved.patternSpeed);
  }, [resolved.patternSpeed]);

  useEffect(() => {
    pattern.current?.setIntensity(resolved.patternIntensity);
  }, [resolved.patternIntensity]);

  useEffect(() => {
    if (photoId === null) {
      setPhoto(null);
      return;
    }
    let cancelled = false;
    let decoded: DecodedPhoto | null = null;
    fetcher(photoId)
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
  }, [fetcher, photoId]);

  useEffect(() => {
    const canvas = photoCanvas.current;
    if (photo === null || canvas === null) return;
    const paint = () => {
      const rect = canvas.getBoundingClientRect();
      const viewport = { width: rect.width, height: rect.height };
      if (resolved.photoDithered) {
        drawDitheredPhoto(canvas, photo.source, photo.size, viewport);
      } else {
        drawPhoto(canvas, photo.source, photo.size, viewport);
      }
    };
    paint();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(paint);
    observer?.observe(canvas);
    const stopPixelRatio = watchDisplayPixelRatio(paint);
    return () => {
      observer?.disconnect();
      stopPixelRatio();
    };
  }, [photo, resolved.photoDithered]);

  if (!active) return null;

  const builtinUrl = resolved.kind === "builtin" ? resolved.backgroundUrl : null;

  return (
    <div
      aria-hidden="true"
      className="app-backdrop"
      data-animated={resolved.animated ? "true" : "false"}
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
      {photoId === null ? null : (
        <canvas
          className="app-backdrop__photo"
          data-dithered={resolved.photoDithered ? "true" : "false"}
          data-photo-ready={photo !== null}
          ref={photoCanvas}
          style={{ opacity: resolved.photoOpacity }}
        />
      )}
      {showPattern ? (
        <canvas
          className="app-backdrop__pattern"
          data-blend={ink.mode === "light" ? "multiply" : "screen"}
          ref={patternCanvas}
          style={{ opacity: resolved.patternOpacity }}
        />
      ) : null}
    </div>
  );
}
