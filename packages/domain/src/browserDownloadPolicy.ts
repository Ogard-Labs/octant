/**
 * Pure rules for the files an agent's Browser may keep from a page. The page
 * decides nothing here: the name is reduced to a safe one, the type is read
 * from the bytes, and what looks like a program is refused whatever the page
 * calls it.
 */

/** Names ending in one of these are programs or installers, whatever the bytes say. */
const EXECUTABLE_EXTENSIONS: ReadonlyArray<string> = [
  ".app",
  ".pkg",
  ".dmg",
  ".exe",
  ".msi",
  ".bat",
  ".cmd",
  ".command",
  ".sh",
  ".scpt",
  ".jar",
  ".deb",
  ".rpm",
  ".appimage",
];

const MAX_SAFE_NAME_CHARACTERS = 120;
const SNIFF_BYTES = 4096;

export interface BrowserDownloadSniff {
  readonly mediaType: string;
  /** Mach-O, ELF, or PE/COFF: a program, whatever the file is called. */
  readonly executable: boolean;
}

/** How many leading bytes a caller needs to give {@link sniffBrowserDownload}. */
export const BROWSER_DOWNLOAD_SNIFF_BYTES = SNIFF_BYTES;

export function sniffBrowserDownload(head: Uint8Array): BrowserDownloadSniff {
  const at = (index: number): number => head[index] ?? -1;
  const starts = (...bytes: ReadonlyArray<number>): boolean =>
    bytes.every((byte, index) => at(index) === byte);
  if (starts(0x7f, 0x45, 0x4c, 0x46)) return { mediaType: "application/x-elf", executable: true };
  if (starts(0x4d, 0x5a)) return { mediaType: "application/x-msdownload", executable: true };
  if (
    starts(0xfe, 0xed, 0xfa, 0xce) ||
    starts(0xfe, 0xed, 0xfa, 0xcf) ||
    starts(0xce, 0xfa, 0xed, 0xfe) ||
    starts(0xcf, 0xfa, 0xed, 0xfe) ||
    starts(0xca, 0xfe, 0xba, 0xbe)
  ) {
    return { mediaType: "application/x-mach-binary", executable: true };
  }
  const known = (mediaType: string): BrowserDownloadSniff => ({ mediaType, executable: false });
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return known("application/pdf");
  if (starts(0x89, 0x50, 0x4e, 0x47)) return known("image/png");
  if (starts(0xff, 0xd8, 0xff)) return known("image/jpeg");
  if (starts(0x47, 0x49, 0x46, 0x38)) return known("image/gif");
  if (starts(0x52, 0x49, 0x46, 0x46) && at(8) === 0x57 && at(9) === 0x45) {
    return known("image/webp");
  }
  if (starts(0x50, 0x4b, 0x03, 0x04)) return known("application/zip");
  if (starts(0x1f, 0x8b)) return known("application/gzip");
  const sample = head.subarray(0, SNIFF_BYTES);
  if (sample.length > 0 && looksLikeText(sample)) {
    const text = new TextDecoder().decode(sample).trimStart().toLowerCase();
    if (text.startsWith("<!doctype html") || text.startsWith("<html")) return known("text/html");
    if (text.startsWith("<?xml")) return known("application/xml");
    return known("text/plain");
  }
  return known("application/octet-stream");
}

function looksLikeText(sample: Uint8Array): boolean {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(sample);
  } catch {
    // A sample cut in the middle of a multi-byte character is still text.
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(sample.subarray(0, -3));
    } catch {
      return false;
    }
  }
  for (const character of decoded) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x0c) {
      return false;
    }
  }
  return true;
}

export function browserDownloadNameIsExecutable(name: string): boolean {
  const lower = name.toLowerCase();
  return EXECUTABLE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * The page's suggested name as a basename that is safe to create: no path
 * parts, no control characters, no leading dot, a bounded length that keeps
 * the extension.
 */
export function safeBrowserDownloadName(suggested: string): string {
  const lastPart = suggested.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = lastPart.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const withoutDots = cleaned.replace(/^[.\s]+/, "");
  if (withoutDots === "") return "download";
  if (withoutDots.length <= MAX_SAFE_NAME_CHARACTERS) return withoutDots;
  const dot = withoutDots.lastIndexOf(".");
  const extension = dot > 0 && withoutDots.length - dot <= 16 ? withoutDots.slice(dot) : "";
  return `${withoutDots.slice(0, MAX_SAFE_NAME_CHARACTERS - extension.length)}${extension}`;
}

/** `report.pdf` taken twice becomes `report (2).pdf`. */
export function numberedBrowserDownloadName(name: string, copy: number): string {
  if (copy <= 1) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? `${name.slice(0, dot)} (${String(copy)})${name.slice(dot)}`
    : `${name} (${String(copy)})`;
}

/** Why a download of this name and these first bytes is refused, if it is. */
export function refuseBrowserDownloadType(
  name: string,
  head: Uint8Array,
): "executable" | undefined {
  return browserDownloadNameIsExecutable(name) || sniffBrowserDownload(head).executable
    ? "executable"
    : undefined;
}

const TYPE_LABELS: Readonly<Record<string, string>> = {
  "application/pdf": "PDF",
  "image/png": "PNG image",
  "image/jpeg": "JPEG image",
  "image/gif": "GIF image",
  "image/webp": "WebP image",
  "application/zip": "ZIP archive",
  "application/gzip": "gzip archive",
  "text/plain": "text",
  "text/html": "HTML",
  "application/xml": "XML",
  "application/octet-stream": "unknown type",
};

/** The type as a person reads it in the question. */
export function browserDownloadTypeLabel(mediaType: string): string {
  return TYPE_LABELS[mediaType] ?? mediaType;
}

export function formatBrowserDownloadSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The question a person answers before a downloaded file enters the workspace. */
export function browserDownloadQuestion(
  origin: string,
  file: { readonly name: string; readonly sizeBytes: number; readonly mediaType: string },
): string {
  return `Let the agent save ${file.name} (${formatBrowserDownloadSize(file.sizeBytes)}, ${browserDownloadTypeLabel(file.mediaType)}) from ${origin} into this thread's workspace?`;
}
