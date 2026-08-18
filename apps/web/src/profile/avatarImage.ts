import {
  MAX_AVATAR_IMAGE_CHARACTERS,
  type AvatarImageDataUrl,
} from "@octant/contracts/user-profile";
import { gravatarImageUrl, normalizeGravatarEmail } from "@octant/domain";

/**
 * The square an avatar is stored at.
 *
 * Avatars ride in journaled shell settings, so the stored picture is the small
 * one the surface actually draws, not the original the user picked. 128px
 * covers the largest place an avatar appears at 2× pixel density.
 */
export const AVATAR_PIXELS = 128;

/** The size asked of Gravatar, before the same downscale every avatar gets. */
const GRAVATAR_REQUEST_PIXELS = 256;

/**
 * How long a Gravatar request may stay unanswered before it is given up on.
 *
 * A connection that is accepted and then never answered fails no other way, and
 * the profile step disables every exit — including Escape and Skip — while an
 * import is running, so an unbounded request traps a user on first launch until
 * the window is restarted.
 */
const GRAVATAR_TIMEOUT_MS = 10_000;

export type AvatarImportFailure =
  | { readonly kind: "unsupported-type"; readonly message: string }
  | { readonly kind: "unreadable"; readonly message: string }
  | { readonly kind: "too-large"; readonly message: string }
  | { readonly kind: "gravatar-missing"; readonly message: string }
  | { readonly kind: "gravatar-unreachable"; readonly message: string };

export type AvatarImportResult =
  | { readonly kind: "imported"; readonly dataUrl: AvatarImageDataUrl }
  | { readonly kind: "failed"; readonly failure: AvatarImportFailure };

/**
 * Everything this module needs from the browser, named so tests can supply it.
 *
 * Decoding and canvas work are the only parts that cannot run headless, and
 * `fetch` is the one call that leaves this Mac. Keeping them in one seam means
 * the import rules — what is accepted, what is refused, and what the user is
 * told — are testable without a real browser.
 */
export interface AvatarImageEnvironment {
  readonly decode: (blob: Blob) => Promise<{ readonly width: number; readonly height: number }>;
  readonly encode: (
    source: unknown,
    pixels: number,
  ) => Promise<{ readonly dataUrl: string } | undefined>;
  readonly fetch: typeof fetch;
  readonly digest: (value: string) => Promise<string>;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * Turn a file the user picked into a bounded, inlined avatar.
 *
 * The original never leaves this Mac and is never stored: it is decoded,
 * drawn once at avatar size, and re-encoded. A file that is not an image the
 * host can decode is refused by name rather than stored as something the
 * surface would later fail to draw.
 */
export async function importAvatarFromFile(
  file: File,
  environment: AvatarImageEnvironment = browserAvatarEnvironment(),
): Promise<AvatarImportResult> {
  if (!IMAGE_TYPES.has(file.type)) {
    return failed({
      kind: "unsupported-type",
      message: "That file is not a PNG, JPEG, WebP, or GIF image.",
    });
  }
  return encodeBlob(file, environment, "That image could not be read on this Mac.");
}

/**
 * Fetch the Gravatar for an address, once, and inline it.
 *
 * This is the only part of a profile that contacts anything outside this Mac,
 * and it happens only when the user asks for it. The picture is copied into
 * settings rather than linked, so the avatar renders offline afterwards and
 * gravatar.com is never contacted again on the host's own initiative. `d=404`
 * means a miss is reported as a miss: Octant never stores the placeholder
 * Gravatar would otherwise generate and call it the user's picture.
 */
export async function importAvatarFromGravatar(
  email: string,
  environment: AvatarImageEnvironment = browserAvatarEnvironment(),
): Promise<AvatarImportResult> {
  const hash = await environment.digest(normalizeGravatarEmail(email));
  const abandon = new AbortController();
  const bound = setTimeout(() => abandon.abort(), GRAVATAR_TIMEOUT_MS);
  const unreachable = failed({
    kind: "gravatar-unreachable",
    message: "Octant could not reach gravatar.com. Check the connection, or upload a photo.",
  });
  // The deadline has to cover reading the body too. Headers that arrive and
  // then a stream that stalls is the same hang as a request that is never
  // answered, and the profile step disables its rail, Escape, and Skip for the
  // whole of it. Encoding afterwards is local work and needs no deadline.
  try {
    let response: Response;
    try {
      response = await environment.fetch(gravatarImageUrl(hash, GRAVATAR_REQUEST_PIXELS), {
        signal: abandon.signal,
      });
    } catch {
      return unreachable;
    }
    if (response.status === 404) {
      return failed({
        kind: "gravatar-missing",
        message: "That address has no Gravatar. Upload a photo, or keep your initials.",
      });
    }
    if (!response.ok) {
      return failed({
        kind: "gravatar-unreachable",
        message: `gravatar.com answered ${String(response.status)}. Try again, or upload a photo.`,
      });
    }
    const unreadable = "The Gravatar came back in a format this Mac could not read.";
    let body: Blob;
    try {
      body = await response.blob();
    } catch {
      // A body that cannot even be read is still a failed import, and has to be
      // reported as one — never left as a button that quietly did nothing. A
      // body given up on is the connection failing, not an unreadable format.
      return abandon.signal.aborted
        ? unreachable
        : failed({ kind: "unreadable", message: unreadable });
    }
    return encodeBlob(body, environment, unreadable);
  } finally {
    clearTimeout(bound);
  }
}

async function encodeBlob(
  blob: Blob,
  environment: AvatarImageEnvironment,
  unreadableMessage: string,
): Promise<AvatarImportResult> {
  let source: { readonly width: number; readonly height: number };
  try {
    source = await environment.decode(blob);
  } catch {
    return failed({ kind: "unreadable", message: unreadableMessage });
  }
  const encoded = await environment.encode(source, AVATAR_PIXELS);
  if (encoded === undefined) {
    return failed({ kind: "unreadable", message: unreadableMessage });
  }
  if (encoded.dataUrl.length > MAX_AVATAR_IMAGE_CHARACTERS) {
    // The bound belongs to the store, not to the picker: refusing here keeps
    // an image that would bloat every replay of these settings out of them,
    // and says so instead of silently keeping the initials.
    return failed({
      kind: "too-large",
      message: "That image is too detailed to store. Try a simpler or smaller one.",
    });
  }
  return { kind: "imported", dataUrl: encoded.dataUrl as AvatarImageDataUrl };
}

function failed(failure: AvatarImportFailure): AvatarImportResult {
  return { kind: "failed", failure };
}

/** The real browser seam: decode with `createImageBitmap`, draw on a canvas. */
export function browserAvatarEnvironment(): AvatarImageEnvironment {
  return {
    decode: (blob) => createImageBitmap(blob),
    encode: async (source, pixels) => {
      const canvas = document.createElement("canvas");
      canvas.width = pixels;
      canvas.height = pixels;
      const context = canvas.getContext("2d");
      if (context === null) return undefined;
      const bitmap = source as ImageBitmap;
      // Cover, not stretch: the shortest side fills the square and the rest is
      // cropped evenly, so a portrait photo keeps its proportions.
      const side = Math.min(bitmap.width, bitmap.height);
      context.drawImage(
        bitmap,
        (bitmap.width - side) / 2,
        (bitmap.height - side) / 2,
        side,
        side,
        0,
        0,
        pixels,
        pixels,
      );
      const webp = canvas.toDataURL("image/webp", 0.85);
      const dataUrl = webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
      return { dataUrl };
    },
    fetch: (...args) => fetch(...args),
    digest: async (value) => {
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    },
  };
}
