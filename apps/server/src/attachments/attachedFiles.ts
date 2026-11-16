import { isNativeImageAttachment } from "@octant/contracts";

/**
 * Files a person attached that a turn names by path rather than sends.
 *
 * Work and Code take a file of any type as an attachment (maintainer decision,
 * 2026-11-16). An image a model reads goes to it as a picture, and a file the
 * provider takes natively goes to it natively; every other file stays in the
 * thread's attachments folder, which the session reads at every level and
 * never writes, and the turn tells the agent where it is so it opens the file
 * with its own tools.
 */

export interface AttachedFileByPath {
  readonly displayName: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly path: string;
}

/** Splits a turn's attachments into the images it sends as pictures and every other file. */
export function partitionAttachedFiles<Reference extends { readonly mediaType: string }>(
  references: ReadonlyArray<Reference>,
): { readonly images: ReadonlyArray<Reference>; readonly files: ReadonlyArray<Reference> } {
  return {
    images: references.filter((reference) => isNativeImageAttachment(reference.mediaType)),
    files: references.filter((reference) => !isNativeImageAttachment(reference.mediaType)),
  };
}

/**
 * The sentence a turn carries for files it names by path. A display name is
 * the person's and is quoted as data; the path is Octant's own.
 */
export function attachedFilesMessage(files: ReadonlyArray<AttachedFileByPath>): string {
  const lines = files.map(
    (file) =>
      `- ${JSON.stringify(file.displayName)} (${file.mediaType}, ${String(file.byteLength)} bytes): ${file.path}`,
  );
  return [
    files.length === 1
      ? "The person attached a file to this message. It is read-only; open it with your file tools:"
      : "The person attached files to this message. They are read-only; open them with your file tools:",
    ...lines,
  ].join("\n");
}
