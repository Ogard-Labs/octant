import { Schema } from "effect";

/**
 * A file's media type as `type/subtype`, lower case, the way a browser or the
 * host names it. Work and Code take a file of any type as an attachment
 * (maintainer decision, 2026-11-16): an image a provider takes natively is
 * sent as an image, and any other file stays in the thread's attachments
 * folder for the agent to read by path, so the type is recorded, not
 * restricted. Parameters such as `; charset=` are not part of it.
 */
export const ATTACHMENT_MEDIA_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** The media type recorded for a file whose type the browser could not name. */
export const UNKNOWN_ATTACHMENT_MEDIA_TYPE = "application/octet-stream";

/** The image types every supported provider takes natively as an image. */
export const NATIVE_IMAGE_ATTACHMENT_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export function isNativeImageAttachment(mediaType: string): boolean {
  return (NATIVE_IMAGE_ATTACHMENT_MEDIA_TYPES as ReadonlyArray<string>).includes(mediaType);
}

export const AnyAttachmentMediaType = Schema.String.pipe(
  Schema.pattern(ATTACHMENT_MEDIA_TYPE_PATTERN),
);
