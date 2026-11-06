import { Schema } from "effect";

const textEncoder = new TextEncoder();
export const MAX_THREAD_WORKING_DIRECTORY_BYTES = 4_096;

export const ThreadWorkingDirectory = Schema.String.pipe(
  Schema.filter((value) => {
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
  Schema.brand("ThreadWorkingDirectory"),
);
export type ThreadWorkingDirectory = typeof ThreadWorkingDirectory.Type;

export const decodeThreadWorkingDirectory = Schema.decodeUnknownSync(ThreadWorkingDirectory);

export const ProjectWorkingFolderId = Schema.String.pipe(
  Schema.pattern(/^folder_[a-f0-9]{64}$/),
  Schema.brand("ProjectWorkingFolderId"),
);
export type ProjectWorkingFolderId = typeof ProjectWorkingFolderId.Type;
export const decodeProjectWorkingFolderId = Schema.decodeUnknownSync(ProjectWorkingFolderId);
export const ApprovedWorkingFolder = Schema.Struct({
  id: ProjectWorkingFolderId,
  label: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  kind: Schema.Literal("main", "extra"),
}).annotations({ parseOptions: { onExcessProperty: "error" as const } });
export type ApprovedWorkingFolder = typeof ApprovedWorkingFolder.Type;
export const ApprovedWorkingFolders = Schema.Array(ApprovedWorkingFolder).pipe(
  Schema.minItems(1),
  Schema.maxItems(17),
);

export const ThreadWorkingFolderChoice = Schema.Struct({
  workingFolderId: ProjectWorkingFolderId,
  workingDirectory: ThreadWorkingDirectory,
}).annotations({ parseOptions: { onExcessProperty: "error" as const } });
export type ThreadWorkingFolderChoice = typeof ThreadWorkingFolderChoice.Type;
