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

/**
 * Why a server Project's turn refuses a file it would name by path on a host
 * that composes no transfer to the server. A server thread's agent works with
 * the server's own file tools, and the thread's attachments folder is on this
 * host, so a path there names nothing the agent can open; the host copies the
 * file to the server first (`transferServerAttachments`), and without that the
 * turn is refused before it is accepted rather than sent with a path that
 * cannot be read.
 */
export const SERVER_PROJECT_FILE_ATTACHMENT_REFUSAL =
  "This thread works on a server, which cannot open a file attached here. Attach images only, or copy the file to the server's folder and name it in the message.";

/**
 * A file's bytes as text when they are text: valid UTF-8 with no NUL byte,
 * whatever its media type says, since a browser names many text files
 * (source code, logs, configuration) `application/octet-stream` or a vendor
 * type. Anything else is undefined, and is never decoded with replacement
 * characters a model would read as the file's content.
 */
export function attachedFileText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
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
