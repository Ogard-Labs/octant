import { Schema } from "effect";

/**
 * The thread statuses the sidebar speaks about, in descending strength.
 *
 * This vocabulary started in the renderer and moved into a domain policy so a
 * thread row and a Project heading could not rank the same facts differently.
 * It lives here because a saved Project View now stores which statuses it wants
 * to see: the words are written to disk and read back, so they are a wire
 * contract, and a value the schema does not name cannot round-trip.
 *
 * Every status is a fact the sidebar already carries. A status it cannot
 * observe — a failed run, a blocked check — is absent rather than inferred from
 * silence, so adding one means giving the sidebar the fact first.
 *
 * `idle` is not here. It is the absence of a claim rather than a state a view
 * could filter for, and a schema that accepted it would invite a saved filter
 * asking for threads that have nothing to report.
 */
export const SidebarThreadStatus = Schema.Literal("working", "attention", "woke", "unread");
export type SidebarThreadStatus = typeof SidebarThreadStatus.Type;

/**
 * The same words as an ordered array, strongest first.
 *
 * The schema fixes the set; this fixes the order. Ranking is what makes one
 * status the one a folded Project reports and one Project louder than another,
 * so the order travels with the vocabulary instead of being restated by each
 * surface that needs it.
 */
export const SIDEBAR_THREAD_STATUS_ORDER = [
  "working",
  "attention",
  "woke",
  "unread",
] as const satisfies ReadonlyArray<SidebarThreadStatus>;

export const decodeSidebarThreadStatus = Schema.decodeUnknownSync(SidebarThreadStatus);
