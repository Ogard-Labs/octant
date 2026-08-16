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
