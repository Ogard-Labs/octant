import { Schema } from "effect";

/**
 * The thread statuses a saved Project View may ask for.
 *
 * This vocabulary is defined here because a Project View's filters are written
 * to disk and read back by a later build: the moment a status word can be
 * saved, the set of legal words is a wire contract, and a value the schema does
 * not name cannot round-trip.
 *
 * Only the legal set lives here. How strongly the statuses rank against one
 * another decides which one a row shows and which Project a status sort puts
 * first, which is policy rather than a wire value — nothing writes a rank down —
 * so `@octant/domain` owns the ordering, the labels, and what a caller may
 * conclude from a status.
 *
 * Every status is a fact the sidebar already carries. A status it cannot
 * observe — a failed run, a blocked check — is absent rather than inferred from
 * silence, so adding one means giving the sidebar the fact first, and here it
 * also means a word a saved view can persist.
 *
 * `idle` is not here. It is the absence of a claim rather than a state a view
 * could filter for, and a schema that accepted it would invite a saved filter
 * asking for threads that have nothing to report.
 */
export const SidebarThreadStatus = Schema.Literal("working", "attention", "woke", "unread");
export type SidebarThreadStatus = typeof SidebarThreadStatus.Type;

export const decodeSidebarThreadStatus = Schema.decodeUnknownSync(SidebarThreadStatus);
