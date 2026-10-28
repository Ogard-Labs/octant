import type { CanvasHtmlFileRequest, CanvasHtmlFileResult } from "@octant/contracts/canvas-export";

/**
 * Save or copy a Canvas as one self-contained HTML file, from this window.
 *
 * The host renders the file under the same read check as opening the Canvas
 * and hands it back; the window then writes it to a download or the
 * clipboard. Nothing is uploaded and no destination is called, so there is no
 * approval card: the file only reaches the person's own device. Each function
 * returns the line the Canvas surface shows, and never claims a save or a
 * copy that did not happen.
 */
export type CanvasHtmlFileLoader = (
  request: CanvasHtmlFileRequest,
) => Promise<CanvasHtmlFileResult>;

export async function saveCanvasHtmlFile(
  load: CanvasHtmlFileLoader,
  request: CanvasHtmlFileRequest,
): Promise<string> {
  const result = await render(load, request);
  if (result.kind !== "ready") return result.message;
  if (!download(result.html, result.fileName)) {
    return "This window cannot save files. Use Copy HTML instead.";
  }
  return withNotes(`Saved ${result.fileName}.`, result);
}

export async function copyCanvasHtml(
  load: CanvasHtmlFileLoader,
  request: CanvasHtmlFileRequest,
): Promise<string> {
  const result = await render(load, request);
  if (result.kind !== "ready") return result.message;
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== "function") {
    return "This window has no clipboard to copy to. Use Save as HTML file instead.";
  }
  try {
    await clipboard.writeText(result.html);
  } catch {
    // The host refused the clipboard; nothing was copied and nothing is claimed.
    return "The clipboard refused the HTML. Use Save as HTML file instead.";
  }
  return withNotes("Copied the Canvas as HTML.", result);
}

async function render(
  load: CanvasHtmlFileLoader,
  request: CanvasHtmlFileRequest,
): Promise<CanvasHtmlFileResult> {
  try {
    return await load(request);
  } catch {
    return { kind: "refused", code: "unavailable", message: "The HTML file could not be made." };
  }
}

/** What the person should know about what the file holds. */
function withNotes(
  receipt: string,
  result: Extract<CanvasHtmlFileResult, { readonly kind: "ready" }>,
): string {
  const notes = [receipt];
  if (result.imagesLeftOut > 0) {
    notes.push(
      result.imagesLeftOut === 1
        ? "One image was left out to keep the file small."
        : `${String(result.imagesLeftOut)} images were left out to keep the file small.`,
    );
  }
  if (result.writesDesignMarkup) {
    notes.push("Design markup is included as written; Octant does not check it for secrets.");
  }
  return notes.join(" ");
}

function download(html: string, fileName: string): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = "noreferrer";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } finally {
    URL.revokeObjectURL(url);
  }
}
