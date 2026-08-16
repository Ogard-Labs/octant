import { useEffect, useState } from "react";
import type { ResolvedSidebarBackground } from "@octant/theme/backgrounds";

export type BackgroundFetcher = (backgroundId: string) => Promise<Blob>;

export interface SidebarBackgroundLayerProps {
  readonly resolved: ResolvedSidebarBackground;
  readonly fetcher: BackgroundFetcher;
}

export function SidebarBackgroundLayer({ resolved, fetcher }: SidebarBackgroundLayerProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    if (resolved.kind !== "custom" || resolved.backgroundId === null) {
      setBlobUrl(null);
      return;
    }
    let revoked = false;
    let createdUrl: string | null = null;
    fetcher(resolved.backgroundId)
      .then((blob) => {
        if (revoked) return;
        createdUrl = URL.createObjectURL(blob);
        setBlobUrl(createdUrl);
      })
      .catch(() => {
        if (!revoked) setBlobUrl(null);
      });
    return () => {
      revoked = true;
      if (createdUrl !== null) URL.revokeObjectURL(createdUrl);
    };
  }, [resolved.kind, resolved.backgroundId, fetcher]);

  if (resolved.kind === "none") return null;

  // Preset CSS may be a full `background` shorthand (layered gradients + base
  // color), so use the `background` shorthand property, not `backgroundImage`
  // (which rejects a trailing color-only layer). Custom backgrounds are a
  // single image url, which `background` also accepts.
  const background =
    resolved.kind === "preset"
      ? resolved.backgroundCss
      : blobUrl !== null
        ? `url('${blobUrl}') center/cover no-repeat`
        : null;

  return (
    <>
      <div
        data-octant-sidebar-background
        style={background !== null ? { background } : { display: "none" }}
        aria-hidden="true"
      />
      <div
        data-octant-sidebar-overlay
        style={{
          backgroundColor: resolved.overlayColor,
          opacity: resolved.overlayOpacity / 100,
        }}
        aria-hidden="true"
      />
    </>
  );
}
