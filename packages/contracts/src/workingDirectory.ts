import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";

const textEncoder = new TextEncoder();
export const MAX_THREAD_WORKING_DIRECTORY_BYTES = 4_096;

export const ThreadWorkingDirectory = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => {
      if (value === ".") return true;
      if (
        value.length === 0 ||
        value.includes("\0") ||
        value.includes("\\") ||
        value.startsWith("/") ||
        value.endsWith("/") ||
        value.normalize("NFC") !== value ||
        textEncoder.encode(value).byteLength > MAX_THREAD_WORKING_DIRECTORY_BYTES
      ) {
        return false;
      }
      return value
        .split("/")
        .every((component) => component !== "" && component !== "." && component !== "..");
    }),
  ),
  Schema.brand("ThreadWorkingDirectory"),
);
export type ThreadWorkingDirectory = typeof ThreadWorkingDirectory.Type;

export const decodeThreadWorkingDirectory = Schema.decodeUnknownSync(
  ThreadWorkingDirectory,
  STRICT_DECODE_OPTIONS,
);

export const ProjectWorkingFolderId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^folder_[a-f0-9]{64}$/)),
  Schema.brand("ProjectWorkingFolderId"),
);
export type ProjectWorkingFolderId = typeof ProjectWorkingFolderId.Type;
export const decodeProjectWorkingFolderId = Schema.decodeUnknownSync(
  ProjectWorkingFolderId,
  STRICT_DECODE_OPTIONS,
);
export const ApprovedWorkingFolder = Schema.Struct({
  id: ProjectWorkingFolderId,
  label: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_THREAD_WORKING_DIRECTORY_BYTES),
  ),
  kind: Schema.Literals(["main", "extra"]),
});
export type ApprovedWorkingFolder = typeof ApprovedWorkingFolder.Type;
export const ApprovedWorkingFolders = Schema.Array(ApprovedWorkingFolder).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(17),
);

export const ThreadWorkingFolderChoice = Schema.Struct({
  workingFolderId: ProjectWorkingFolderId,
  workingDirectory: ThreadWorkingDirectory,
});
export type ThreadWorkingFolderChoice = typeof ThreadWorkingFolderChoice.Type;
