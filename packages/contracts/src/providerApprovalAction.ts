import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
export const MAX_OWNER_APPROVAL_BYTES = 65_536;
export const OwnerApprovalAction = Schema.Struct({
  kind: Schema.Literals(["file-read", "file-write", "file-edit", "shell"]),
  tool: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  input: Schema.NonEmptyString.check(
    Schema.isMaxLength(MAX_OWNER_APPROVAL_BYTES),
    Schema.makeFilter((text) => {
      try {
        const value: unknown = JSON.parse(text);
        return typeof value === "object" && value !== null && !Array.isArray(value);
      } catch {
        return false;
      }
    }),
  ),
  workingDirectory: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096)),
  ),
}).check(
  Schema.makeFilter(
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
export const decodeOwnerApprovalAction = Schema.decodeUnknownSync(
  OwnerApprovalAction,
  STRICT_DECODE_OPTIONS,
);
