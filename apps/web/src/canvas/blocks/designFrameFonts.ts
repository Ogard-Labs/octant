import geistSans from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url&inline";
import geistMono from "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?url&inline";

/**
 * Octant's bundled faces, handed to a themed design frame by the host.
 *
 * A `srcdoc` frame inherits the app's content policy, whose `font-src 'self'`
 * refuses the `data:` font a page could name itself, and the frame's own
 * policy refuses everything else. Chromium logs exactly that refusal for an
 * `@font-face` with a `data:` source. A font built from bytes is not a load,
 * so the host builds each face from the bundled file in the frame's own realm
 * and adds it to the frame's fonts. That needs a same-origin frame; with no
 * script permitted, the page itself still runs nothing.
 */
const FACES: ReadonlyArray<{ readonly family: string; readonly source: string }> = [
  { family: "Geist Variable", source: geistSans },
  { family: "Geist Mono Variable", source: geistMono },
];

let decoded:
  | ReadonlyArray<{ readonly family: string; readonly bytes: Uint8Array<ArrayBuffer> }>
  | undefined;

function faceBytes(): ReadonlyArray<{
  readonly family: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}> {
  decoded ??= FACES.map(({ family, source }) => {
    const base64 = source.slice(source.indexOf(",") + 1);
    return { family, bytes: Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)) };
  });
  return decoded;
}

/** Adds Octant's faces to a same-origin frame's page. Does nothing it cannot reach. */
export function installFrameFonts(frame: HTMLIFrameElement): void {
  const view = frame.contentWindow as (Window & typeof globalThis) | null;
  const page = frame.contentDocument;
  if (view === null || page === null || typeof view.FontFace !== "function") return;
  for (const { family, bytes } of faceBytes()) {
    const face = new view.FontFace(family, bytes, { weight: "100 900", display: "swap" });
    page.fonts.add(face);
    void face.load().catch(() => undefined);
  }
}
