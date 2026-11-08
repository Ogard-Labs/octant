import { Schema } from "effect";
const strict = { parseOptions: { onExcessProperty: "error" as const } };
export const MAX_OWNER_APPROVAL_BYTES = 65_536;
export const OwnerApprovalAction = Schema.Struct({
  kind: Schema.Literal("file-read", "file-write", "file-edit", "shell"),
  tool: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  input: Schema.NonEmptyString.pipe(
    Schema.maxLength(MAX_OWNER_APPROVAL_BYTES),
    Schema.filter((text) => {
      try {
        const value: unknown = JSON.parse(text);
        return typeof value === "object" && value !== null && !Array.isArray(value);
      } catch {
        return false;
      }
    }),
  ),
  workingDirectory: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4_096))),
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (action) =>
        (action.kind !== "shell" ||
          (action.tool === "Bash" &&
            action.workingDirectory !== undefined &&
            action.workingDirectory.startsWith("/") &&
            !action.workingDirectory.includes("\0"))) &&
        new TextEncoder().encode(JSON.stringify(action)).byteLength <= MAX_OWNER_APPROVAL_BYTES,
    ),
  );
export type OwnerApprovalAction = typeof OwnerApprovalAction.Type;
export const decodeOwnerApprovalAction = Schema.decodeUnknownSync(OwnerApprovalAction);
