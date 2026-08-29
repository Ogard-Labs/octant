import { createHash } from "node:crypto";
import type {
  ExternalContentIngestionResult,
  RecordExternalContentIngestionInput,
} from "../context/externalContentIngestionStore";
import type { AppManagedToolSet } from "./appManagedToolSet";

export interface TaintAppManagedToolResultsInput {
  readonly tools: AppManagedToolSet;
  readonly threadId: unknown;
  readonly recordExternalContentIngestion: (
    input: RecordExternalContentIngestionInput,
  ) => ExternalContentIngestionResult;
  readonly uuid: () => string;
}

/**
 * Journal thread-lifetime taint for successful native app-managed tool results
 * before they reach the next model turn.
 *
 * Host-side refusals stay unrecorded: they are Octant answers, not untrusted
 * content. Recording failure withholds the result rather than handing it to
 * the model without a taint event. Structured tool JSON is kept as-is; the
 * journal never stores the body.
 */
export function taintAppManagedToolResults(
  input: TaintAppManagedToolResultsInput,
): AppManagedToolSet {
  return {
    definitions: input.tools.definitions,
    execute: async (call) => {
      const outcome = await input.tools.execute(call);
      if (outcome.isError === true) return outcome;
      return taintSuccessfulResult(input, call.name, outcome);
    },
  };
}

function taintSuccessfulResult(
  input: TaintAppManagedToolResultsInput,
  toolName: string,
  outcome: { readonly result: unknown; readonly isError?: boolean },
): { readonly result: unknown; readonly isError?: boolean } {
  let body: string;
  try {
    const serialized = JSON.stringify(outcome.result);
    if (typeof serialized !== "string") {
      return { result: { error: "tool-unavailable" }, isError: true };
    }
    body = serialized;
  } catch {
    return { result: { error: "tool-unavailable" }, isError: true };
  }
  const ingested = input.recordExternalContentIngestion({
    threadId: input.threadId,
    provenance: { origin: "tool-result", sourceLabel: toolName },
    contentReference: `app-managed-${toolName}-${createHash("sha256").update(body).digest("hex")}`,
    correlationId: input.uuid(),
    authorized: true,
  });
  if (ingested.kind === "refused") {
    return { result: { error: "tool-unavailable" }, isError: true };
  }
  return outcome;
}
