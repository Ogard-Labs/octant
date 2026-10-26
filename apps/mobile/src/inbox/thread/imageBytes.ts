export type ReadBytesResult =
  | { readonly status: "ok"; readonly bytes: Uint8Array }
  | { readonly status: "unreadable" };

/** A picked file that cannot be fetched must not upload the error body as an image. */
export async function readUriBytes(uri: string): Promise<ReadBytesResult> {
  const response = await fetch(uri);
  if (!response.ok) return { status: "unreadable" };
  return { status: "ok", bytes: new Uint8Array(await response.arrayBuffer()) };
}

const EXTENSION_MEDIA_TYPES: ReadonlyArray<readonly [string, string]> = [
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".pdf", "application/pdf"],
  [".txt", "text/plain"],
];

/**
 * The media type to upload a picked file as, when the thread takes it: the
 * type the picker reported, or else the one its name implies. A file whose type
 * neither names (a HEIC photo, say) is not guessed into one the thread takes;
 * the host would refuse bytes that are not the type the upload claims.
 */
export function acceptedMediaType(input: {
  readonly reported: string | null | undefined;
  readonly name: string;
  readonly accepted: ReadonlyArray<string>;
}): string | undefined {
  const reported = input.reported?.split(";", 1)[0]?.trim().toLowerCase();
  if (reported !== undefined && reported !== "") {
    return input.accepted.includes(reported) ? reported : undefined;
  }
  const lower = input.name.toLowerCase();
  const implied = EXTENSION_MEDIA_TYPES.find(([extension]) => lower.endsWith(extension))?.[1];
  return implied !== undefined && input.accepted.includes(implied) ? implied : undefined;
}

/** A name for an attachment the picker left unnamed, such as a camera photo. */
export function defaultAttachmentName(mediaType: string, id: string): string {
  const extension =
    EXTENSION_MEDIA_TYPES.find(([, candidate]) => candidate === mediaType)?.[0] ?? "";
  const stem = mediaType.startsWith("image/") ? "photo" : "file";
  return `${stem}-${id.slice(0, 8)}${extension}`;
}
