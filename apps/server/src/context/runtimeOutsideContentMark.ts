import type { ProviderRuntimeEvent } from "@octant/contracts";
import type { RecordExternalContentIngestion } from "./inheritedExternalContentMark";

export type RuntimeOutsideContentRead = Extract<
  ProviderRuntimeEvent,
  { readonly kind: "outside-content-read" }
>;

/** The labels a runtime's own web tools are recorded under. */
export const RUNTIME_OUTSIDE_CONTENT_SOURCE_LABELS = {
  "web-search": "runtime-web-search",
  "web-fetch": "runtime-web-fetch",
} as const satisfies Record<RuntimeOutsideContentRead["source"], string>;

// A whole ingestion payload may be 2,048 bytes. At four bytes a character at
// most, this leaves room for the thread, the turn and the label.
const REFERENCE_MAX_CHARACTERS = 256;

export const RUNTIME_OUTSIDE_CONTENT_REFUSAL =
  "The model read outside content and this thread could not be marked with it, so the turn was stopped. Try again.";

/**
 * Marks a thread whose provider runtime ran its own web search or page fetch.
 *
 * The runtime hands the result straight to its model, so nothing can be
 * withheld: the mark is what lets Octant's own gates treat the thread as
 * having read outside content from here on. `refused` means the mark could
 * not be recorded, and the caller stops the turn rather than let it continue
 * unmarked. A caller with no way to record a mark is refused too.
 *
 * The reference names the runtime's tool, the turn and the call, then the
 * query or address. It is opaque and path-free like every reference, so the
 * separators of an address are replaced, and it never holds page content.
 */
export function markThreadReadByRuntime(input: {
  readonly record: RecordExternalContentIngestion | undefined;
  readonly threadId: string;
  readonly event: RuntimeOutsideContentRead;
}): { readonly status: "marked" } | { readonly status: "refused" } {
  const { record, event } = input;
  if (record === undefined) return { status: "refused" };
  const reference = [event.toolName, event.correlationId, event.toolCallId, event.target]
    .filter((part) => part !== undefined)
    .join(":")
    .replace(/[/\\\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  try {
    const recorded = record({
      threadId: input.threadId,
      provenance: {
        origin: "tool-result",
        sourceLabel: RUNTIME_OUTSIDE_CONTENT_SOURCE_LABELS[event.source],
      },
      contentReference: Array.from(reference).slice(0, REFERENCE_MAX_CHARACTERS).join("").trim(),
      correlationId: event.correlationId,
      authorized: true,
    });
    return recorded.kind === "recorded" || recorded.kind === "already-recorded"
      ? { status: "marked" }
      : { status: "refused" };
  } catch {
    return { status: "refused" };
  }
}
