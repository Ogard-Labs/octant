import { createHash } from "node:crypto";
import type { ProviderRuntimeEvent, ShieldWatcherLabel } from "@octant/contracts";
import {
  SHIELD_WATCHER_SOURCE_PREFIX,
  watchOutsideContent,
} from "@octant/domain/shield-watcher-policy";
import type { RecordExternalContentIngestionInput } from "./externalContentIngestionStore";
import type { RecordExternalContentIngestion } from "./inheritedExternalContentMark";

export type RuntimeOutsideContentRead = Extract<
  ProviderRuntimeEvent,
  { readonly kind: "outside-content-read" }
>;

/** The labels a runtime's own outside-content tools are recorded under. */
export type RuntimeOutsideContentResult = Extract<
  ProviderRuntimeEvent,
  { readonly kind: "outside-content-result" }
>;

export const RUNTIME_OUTSIDE_CONTENT_SOURCE_LABELS = {
  "web-search": "runtime-web-search",
  "web-fetch": "runtime-web-fetch",
  "hosted-tool": "runtime-hosted-tool",
} as const satisfies Record<RuntimeOutsideContentRead["source"], string>;

export const RUNTIME_OUTSIDE_CONTENT_REFUSAL =
  "The model read outside content and this thread could not be marked with it, so the turn was stopped. Try again.";

/**
 * What a turn told the person when it stopped because the runtime read
 * outside content while the runtime's own reviewer was answering approvals.
 */
export const RUNTIME_OUTSIDE_CONTENT_AUTO_REVIEW_STOP =
  "The model read outside content, so this turn was stopped: the provider's own reviewer no longer answers approvals on this thread. Send a message to continue, and you will be asked yourself.";

// A tool name kept in the reference only when it is a plain identifier, such
// as `webSearch` or `webfetch`. An agent-written title may hold an address.
const PLAIN_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** How a runner records, and before its next turn re-records, a runtime's read. */
export interface RuntimeOutsideContentMarking {
  readonly mark: (
    threadId: string,
    event: RuntimeOutsideContentRead,
  ) => { readonly status: "marked" } | { readonly status: "refused" };
  /**
   * Records whatever an earlier turn of the thread could not, before the
   * thread's next turn may resume a provider session that holds that read.
   */
  readonly settleOwed: (threadId: string) => { readonly status: "clear" | "refused" };
  /**
   * Runs the Watcher over the text a runtime's own tool returned and journals
   * each label it finds, which marks the thread. Refused when a label could
   * not be journaled: the model has already read the page, so the caller stops
   * the turn as for a read that could not be marked.
   */
  readonly watch: (
    threadId: string,
    event: RuntimeOutsideContentResult,
  ) =>
    | { readonly status: "watched"; readonly labels: ReadonlyArray<ShieldWatcherLabel> }
    | { readonly status: "refused" };
}

/**
 * Marks a thread whose provider runtime ran its own web search or page fetch,
 * or a tool its provider hosts.
 *
 * The runtime hands the result straight to its model, so nothing can be
 * withheld: the mark is what lets Octant's own gates treat the thread as
 * having read outside content from here on. A refused mark stops the turn,
 * and the read stays owed: the thread's next turn records it before it starts
 * or is refused too, so "Try again" cannot resume the provider session that
 * read it while the thread is unmarked. What is owed lives in this process; a
 * host restart forgets it.
 *
 * The reference is opaque: the runtime's tool name when it is a plain
 * identifier, then a hash of the tool, the turn, the call and the query or
 * address. No query, address, or page content is journaled.
 */
export class RuntimeOutsideContentMarks implements RuntimeOutsideContentMarking {
  readonly #record: RecordExternalContentIngestion;
  readonly #owed = new Map<string, Map<string, RecordExternalContentIngestionInput>>();

  constructor(record: RecordExternalContentIngestion) {
    this.#record = record;
  }

  mark(
    threadId: string,
    event: RuntimeOutsideContentRead,
  ): { readonly status: "marked" } | { readonly status: "refused" } {
    const input = runtimeOutsideContentIngestion(threadId, event);
    if (this.#recorded(input)) return { status: "marked" };
    const owed = this.#owed.get(threadId) ?? new Map<string, RecordExternalContentIngestionInput>();
    owed.set(String(input.contentReference), input);
    this.#owed.set(threadId, owed);
    return { status: "refused" };
  }

  settleOwed(threadId: string): { readonly status: "clear" | "refused" } {
    const owed = this.#owed.get(threadId);
    if (owed === undefined) return { status: "clear" };
    for (const [reference, input] of owed) {
      if (this.#recorded(input)) owed.delete(reference);
    }
    if (owed.size > 0) return { status: "refused" };
    this.#owed.delete(threadId);
    return { status: "clear" };
  }

  watch(
    threadId: string,
    event: RuntimeOutsideContentResult,
  ):
    | { readonly status: "watched"; readonly labels: ReadonlyArray<ShieldWatcherLabel> }
    | { readonly status: "refused" } {
    const labels = watchOutsideContent(event.text);
    if (labels.length === 0) return { status: "watched", labels };
    const digest = createHash("sha256")
      .update(JSON.stringify([event.toolName, event.correlationId, event.toolCallId, event.text]))
      .digest("hex");
    // A label that cannot be journaled is owed like a read that could not be
    // marked, so the thread's next turn cannot resume this session first. Only
    // the label's own reference is kept, never the page text.
    let allRecorded = true;
    for (const label of labels) {
      const input: RecordExternalContentIngestionInput = {
        threadId,
        provenance: {
          origin: "tool-result",
          sourceLabel: `${SHIELD_WATCHER_SOURCE_PREFIX}${label}`,
        },
        contentReference: `${SHIELD_WATCHER_SOURCE_PREFIX}${label}-${digest}`,
        correlationId: event.correlationId,
        authorized: true,
      };
      if (this.#recorded(input)) continue;
      allRecorded = false;
      const owed =
        this.#owed.get(threadId) ?? new Map<string, RecordExternalContentIngestionInput>();
      owed.set(String(input.contentReference), input);
      this.#owed.set(threadId, owed);
    }
    const recorded = allRecorded;
    return recorded ? { status: "watched", labels } : { status: "refused" };
  }

  #recorded(input: RecordExternalContentIngestionInput): boolean {
    try {
      const recorded = this.#record(input);
      return recorded.kind === "recorded" || recorded.kind === "already-recorded";
    } catch {
      return false;
    }
  }
}

/** The ingestion a runtime's read records, with an opaque reference. */
export function runtimeOutsideContentIngestion(
  threadId: string,
  event: RuntimeOutsideContentRead,
): RecordExternalContentIngestionInput {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([event.toolName, event.correlationId, event.toolCallId, event.target ?? null]),
    )
    .digest("hex");
  const tool = PLAIN_TOOL_NAME.test(event.toolName) ? `${event.toolName}-` : "";
  return {
    threadId,
    provenance: {
      origin: "tool-result",
      sourceLabel: RUNTIME_OUTSIDE_CONTENT_SOURCE_LABELS[event.source],
    },
    contentReference: `runtime-web-${tool}${digest}`,
    correlationId: event.correlationId,
    authorized: true,
  };
}

/** Records nothing and settles nothing, for a caller with no journal. */
export const NO_RUNTIME_OUTSIDE_CONTENT_MARKS: RuntimeOutsideContentMarking = {
  mark: () => ({ status: "refused" }),
  settleOwed: () => ({ status: "clear" }),
  watch: () => ({ status: "refused" }),
};
