import type { ResolvedAppBackground } from "@octant/domain";
import { useEffect, useRef, useState } from "react";
import { decodePhoto, drawDitheredPhoto, type DecodedPhoto } from "./appBackdropPhoto";
import { startAppPattern, type AppPatternHandle, type InkRgb } from "./appBackdropPattern";

export type BackgroundImageFetcher = (backgroundId: string) => Promise<Blob>;

/**
 * Where the ground is drawn: under one welcome surface, masked away behind
 * its composer, or under the whole shell, where there is no composer to
 * clear and only the edges soften.
 */
export type AppBackdropPlacement = "welcome" | "shell";

export interface AppBackdropProps {
  readonly resolved: ResolvedAppBackground;
  /** Reads a photo through the window's authenticated background route. */
  readonly fetcher: BackgroundImageFetcher;
  readonly placement: AppBackdropPlacement;
}

interface ThemeInk {
  readonly rgb: InkRgb;
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
  return {
    rgb: parseHexInk(accent) ?? FALLBACK_INK,
    mode: root.dataset.octantThemeMode === "light" ? "light" : "dark",
  };
}

function sameInk(left: ThemeInk, right: ThemeInk): boolean {
  return (
    left.mode === right.mode &&
    left.rgb[0] === right.rgb[0] &&
    left.rgb[1] === right.rgb[1] &&
    left.rgb[2] === right.rgb[2]
  );
}

/**
 * The accent the theme provider painted on the root, kept current as the
 * theme changes. The provider writes inline custom properties, so watching
 * the root's `style` attribute is what makes a preset switch recolour the
 * ground without a reload.
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
  const showPattern = patternSupported && resolved.patternOpacity > 0;

  useEffect(() => {
    const canvas = patternCanvas.current;
    if (!active || canvas === null || !showPattern) return;
    const handle = startAppPattern(canvas, {
      ink: ink.rgb,
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
    pattern.current?.setInk(ink.rgb);
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
      drawDitheredPhoto(canvas, photo.source, photo.size, {
        width: rect.width,
        height: rect.height,
      });
    };
    paint();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(paint);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [photo]);

  if (!active) return null;

  return (
    <div
      aria-hidden="true"
      className="app-backdrop"
      data-animated={resolved.animated ? "true" : "false"}
      data-octant-app-backdrop={resolved.kind}
      data-placement={placement}
    >
      {photoId === null ? null : (
        <canvas
          className="app-backdrop__photo"
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
