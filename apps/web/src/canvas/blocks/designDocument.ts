import { CANVAS_DESIGN_VIEWPORT, type CanvasDesignBlock } from "@octant/contracts/canvas";

/**
 * The page a design frame is drawn from.
 *
 * It is handed to a frame whose `sandbox` grants nothing, so no script runs
 * and the page cannot open, submit, or reach its parent. The policy below
 * also forbids every load but inline styles and `data:` images and fonts; a
 * policy can only narrow the one the app already passes to this page.
 *
 * Frames link to each other by fragment (`href="#checkout"`). With every
 * frame in one page, the frame a link names is shown by `:target` alone, so a
 * person clicks through a design without the page running anything.
 *
 * A `srcdoc` page resolves links against its parent's address, so a bare
 * `#checkout` would navigate the frame to the Octant page itself and draw it
 * blank. Each fragment link is written against the page's own address instead,
 * which the browser treats as a jump within the page.
 */

const FRAME_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

/**
 * One frame is shown at a time: the one the address names, the one holding
 * the section it names, or else the start frame.
 */
const FRAME_RULES = [
  // A page that sets no colours reads as a browser would show it, whatever
  // theme Octant is in.
  "html { color-scheme: light; background: white; color: black; }",
  "html, body { margin: 0; min-height: 100%; }",
  ".octant-frame { display: none; min-height: 100vh; }",
  ".octant-frame:target, .octant-frame:has(:target) { display: block; }",
  "body:not(:has(.octant-frame:target, .octant-frame :target)) .octant-frame[data-start] { display: block; }",
].join("\n");

export function designDocument(
  block: Pick<CanvasDesignBlock, "size" | "styles" | "frames">,
  options: { readonly frameIds?: ReadonlyArray<string>; readonly startFrameId?: string } = {},
): string {
  const viewport = CANVAS_DESIGN_VIEWPORT[block.size];
  const shown =
    options.frameIds === undefined
      ? block.frames
      : block.frames.filter((frame) => options.frameIds?.includes(String(frame.frameId)));
  const start = options.startFrameId ?? String(shown[0]?.frameId ?? "");
  const frames = shown
    .map((frame) => {
      const id = escapeAttribute(String(frame.frameId));
      const startMark = String(frame.frameId) === start ? " data-start" : "";
      return `<div class="octant-frame" id="${id}"${startMark}>${withOwnAddress(frame.html)}</div>`;
    })
    .join("");
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}">`,
    `<meta name="viewport" content="width=${String(viewport.width)}">`,
    `<style>${FRAME_RULES}</style>`,
    // The host refuses a stylesheet that closes its element; this keeps that
    // true for a document that reached the renderer some other way.
    `<style>${(block.styles ?? "").replace(/<\/style/gi, "<\\/style")}</style>`,
    `</head><body>${frames}</body></html>`,
  ].join("");
}

/** The host admits only fragment links, so every `href=` here starts with `#`. */
function withOwnAddress(html: string): string {
  return html.replace(/([\s/"'](?:xlink:)?href\s*=\s*["']?\s*)#/gi, "$1about:srcdoc#");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
