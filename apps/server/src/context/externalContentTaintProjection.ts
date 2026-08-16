import type { ContentProvenance, ThreadExternalContentTaint } from "@octant/contracts";
import {
  emptyThreadContentTaint,
  projectThreadContentTaint,
  type ThreadContentTaintEvent,
} from "@octant/domain/untrusted-content-policy";

/**
 * In-memory thread-lifetime projection for `external-content-ingested`.
 * Rebuildable from provenance events; never clears on session/turn boundaries.
 * S1's toolCallAuthorityService queries this (or an equivalent journal rebuild)
 * before policy step 7.
 */
export class ExternalContentTaintProjection {
  readonly #byThread = new Map<string, ThreadExternalContentTaint>();

  get(threadId: string): ThreadExternalContentTaint {
    return this.#byThread.get(threadId) ?? emptyThreadContentTaint();
  }

  recordIngested(threadId: string, provenance: ContentProvenance): ThreadExternalContentTaint {
    return this.#apply(threadId, { kind: "content-ingested", provenance });
  }

  noteSessionBoundary(threadId: string): ThreadExternalContentTaint {
    return this.#apply(threadId, { kind: "session-boundary" });
  }

  noteTurnBoundary(threadId: string): ThreadExternalContentTaint {
    return this.#apply(threadId, { kind: "turn-boundary" });
  }

  reset(): void {
    this.#byThread.clear();
  }

  #apply(threadId: string, event: ThreadContentTaintEvent): ThreadExternalContentTaint {
    const next = projectThreadContentTaint(this.get(threadId), event);
    this.#byThread.set(threadId, next);
    return next;
  }
}

export function applyProvenanceToThreadTaint(
  initial: ThreadExternalContentTaint,
  events: ReadonlyArray<ThreadContentTaintEvent>,
): ThreadExternalContentTaint {
  return events.reduce((state, event) => projectThreadContentTaint(state, event), initial);
}
