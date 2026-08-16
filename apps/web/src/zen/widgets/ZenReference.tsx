import type { ZenReferenceElementPayload } from "@octant/contracts/zen";

export interface ZenReferenceProps {
  readonly element: ZenReferenceElementPayload;
}

/**
 * References never execute caller-supplied content. A small allowlist derives a
 * YouTube no-cookie embed without following redirects; every other reference is
 * an explicit external link only.
 */
export function ZenReference({ element }: ZenReferenceProps) {
  const url = new URL(element.url);
  const label = element.label ?? url.hostname;
  const embedUrl = toYouTubeEmbedUrl(url);

  return (
    <section aria-label={`Reference ${label}`} className="zen-reference">
      <p className="zen-reference__external" role="status">
        External content
      </p>
      <p className="zen-reference__url">{url.hostname}</p>
      {embedUrl === null ? (
        <p className="zen-reference__blocked">
          Embedded preview is unavailable. Open this reference externally.
        </p>
      ) : (
        <iframe
          allow="fullscreen"
          className="zen-reference__embed"
          referrerPolicy="no-referrer"
          sandbox="allow-presentation allow-scripts"
          src={embedUrl}
          title={`Embedded ${label}`}
        />
      )}
      <a href={element.url} rel="noreferrer" target="_blank">
        {`Open ${label} externally`}
      </a>
    </section>
  );
}

function toYouTubeEmbedUrl(url: URL): string | null {
  const hostname = url.hostname.toLowerCase();
  let videoId: string | null = null;
  if (hostname === "youtu.be") {
    videoId = url.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (
    hostname === "youtube.com" ||
    hostname === "www.youtube.com" ||
    hostname === "m.youtube.com"
  ) {
    if (url.pathname === "/watch") videoId = url.searchParams.get("v");
    else if (url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/embed/")) {
      videoId = url.pathname.split("/").filter(Boolean)[1] ?? null;
    }
  } else if (hostname === "www.youtube-nocookie.com" && url.pathname.startsWith("/embed/")) {
    videoId = url.pathname.split("/").filter(Boolean)[1] ?? null;
  }
  if (videoId === null || !/^[A-Za-z0-9_-]{6,64}$/.test(videoId)) return null;
  return `https://www.youtube-nocookie.com/embed/${videoId}`;
}
