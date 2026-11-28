import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { LinearNodeId } from "./linearIssues";

/**
 * The only Linear issue identity a renderer may attach to a new thread. The
 * server re-reads the issue through the Integration port, redacts it, and
 * frames it; the client never assembles issue text.
 */
export const LinearIssueContextRequest = Schema.Struct({
  id: LinearNodeId,
});
export type LinearIssueContextRequest = typeof LinearIssueContextRequest.Type;

export const LinearIssueContextRefusedReason = Schema.Literals([
  "unauthorized",
  "unavailable",
  "rate-limited",
  "not-found",
  "forbidden",
]);
export type LinearIssueContextRefusedReason = typeof LinearIssueContextRefusedReason.Type;

export const decodeLinearIssueContextRequest = Schema.decodeUnknownSync(
  LinearIssueContextRequest,
  STRICT_DECODE_OPTIONS,
);
