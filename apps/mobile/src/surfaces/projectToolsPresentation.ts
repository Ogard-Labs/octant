import type { CanvasHtmlImportDrop, CanvasHtmlImportDropKind } from "@octant/contracts";

/**
 * An address typed on a phone keyboard, as the desktop's Project page takes
 * it: a bare host gets https, and the host decides whether it opens at all.
 */
export function projectPageAddress(typed: string): string | undefined {
  const value = typed.trim();
  if (value.length === 0) return undefined;
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
}

const DROP_LABEL: Readonly<Record<CanvasHtmlImportDropKind, readonly [string, string]>> = {
  "script-file": ["script file", "script files"],
  stylesheet: ["stylesheet", "stylesheets"],
  file: ["image, font, or media file", "images, fonts, or media files"],
  link: ["link out of the page", "links out of the page"],
  "embedded-document": ["embedded page", "embedded pages"],
  "form-target": ["form destination", "form destinations"],
  "page-setting": ["page setting", "page settings"],
  "svg-animation": ["SVG animation", "SVG animations"],
};

/** What the import took out of the page, one line per kind, in the desktop's words. */
export function importDropLines(dropped: ReadonlyArray<CanvasHtmlImportDrop>): readonly string[] {
  return dropped.map((drop) => {
    const [one, many] = DROP_LABEL[drop.kind];
    const more = drop.count > drop.examples.length ? ", …" : "";
    const examples = drop.examples.length === 0 ? "" : ` (${drop.examples.join(", ")}${more})`;
    return `${String(drop.count)} ${drop.count === 1 ? one : many}${examples}`;
  });
}
