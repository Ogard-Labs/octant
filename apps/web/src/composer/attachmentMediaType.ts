import {
  ATTACHMENT_MEDIA_TYPE_PATTERN,
  UNKNOWN_ATTACHMENT_MEDIA_TYPE,
  isNativeImageAttachment,
} from "@octant/contracts";

/**
 * The media type a Work or Code file is attached under. Any file may be
 * attached; one whose type the browser cannot name is recorded as a byte
 * stream, and the host names it to the agent by path.
 */
export function attachmentMediaType(file: File): string {
  const mediaType = file.type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return ATTACHMENT_MEDIA_TYPE_PATTERN.test(mediaType) ? mediaType : UNKNOWN_ATTACHMENT_MEDIA_TYPE;
}

/** Whether a file goes to the model as a picture rather than by its path. */
export function isImageAttachment(file: File): boolean {
  return isNativeImageAttachment(attachmentMediaType(file));
}

/**
 * Attach dropped or chosen files where the thread's model may not read
 * images. Any other file still attaches, since the agent opens it by path;
 * an image for a model that reads none is refused with `refusal`, which the
 * host would otherwise say at send.
 */
export function attachAllowingFiles<Answer>(
  files: ReadonlyArray<File>,
  imageSupport: boolean | undefined,
  attach: (files: ReadonlyArray<File>) => Answer,
  refuse: (message: string) => void,
  refusal: string,
): Answer | undefined {
  if (imageSupport !== false) return attach(files);
  const others = files.filter((file) => !isImageAttachment(file));
  if (others.length < files.length) refuse(refusal);
  return others.length === 0 ? undefined : attach(others);
}
