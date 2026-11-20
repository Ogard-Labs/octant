import type {
  CanvasHtmlImportDrop,
  CanvasHtmlImportDropKind,
  ProjectTerminalOutput,
} from "@octant/contracts";

/**
 * What the phone keeps of a Project terminal's output: the host's own bound,
 * so the phone holds no more of a long session than the host would send to a
 * reader who fell behind.
 */
export const PHONE_TERMINAL_KEPT_CHARACTERS = 64 * 1024;

/** The shell's output after one read: the host's tail replaces it, new text extends it. */
export function appendTerminalOutput(shown: string, output: ProjectTerminalOutput): string {
  const next = output.replace ? output.text : shown + output.text;
  return next.length > PHONE_TERMINAL_KEPT_CHARACTERS
    ? next.slice(next.length - PHONE_TERMINAL_KEPT_CHARACTERS)
    : next;
}

// CSI (colours, cursor moves), OSC (titles, links) ended by BEL or ST, and
// the remaining two-byte escapes. The phone draws plain text, not a screen,
// so these are dropped rather than shown as noise.
// oxlint-disable-next-line no-control-regex -- the escapes are what this removes
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// oxlint-disable-next-line no-control-regex -- the escapes are what this removes
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// oxlint-disable-next-line no-control-regex -- the escapes are what this removes
const ESCAPE = /\u001b[@-Z\\-_]/g;
// oxlint-disable-next-line no-control-regex -- the escapes are what this removes
const OTHER_CONTROLS = /[\u0000-\u0007\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * A terminal's raw output as plain lines: escapes dropped, a backspace taking
 * the character before it, and a carriage return starting its line again, as
 * a prompt redrawing itself or a progress bar does.
 */
export function terminalPlainText(raw: string): string {
  const stripped = raw.replace(OSC, "").replace(CSI, "").replace(ESCAPE, "");
  return stripped
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const lastReturn = line.lastIndexOf("\r");
      const tail = lastReturn === -1 ? line : line.slice(lastReturn + 1);
      let kept = "";
      for (const character of tail) {
        if (character === "\b") kept = kept.slice(0, -1);
        else kept += character;
      }
      return kept.replace(OTHER_CONTROLS, "");
    })
    .join("\n");
}

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
