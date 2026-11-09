import { decodePersonMemoryCommand } from "@octant/contracts/person-memory";
import type { PersonMemoryStore } from "../personMemory/personMemoryStore";
import { BENCHMARKS_PROJECT_ID } from "./benchmarkChatPort";

/**
 * Keeps the Benchmarks Project out of person memory, through the memory
 * settings' own "Projects kept out" list. A kept-out Project is never read
 * from (no memory block, no past-threads tool), never learned from, and never
 * searched, so a judge or contender thread sees nothing the person's memory
 * holds, and a benchmark prompt or answer never becomes a memory. Without it a
 * remembered fact could steer a contender or the judge, and a later run would
 * be measured against the leftovers of an earlier one.
 *
 * Adding the Project to the list is idempotent. The person may take it off the
 * list again in Settings; this runs when the Project is first created, so it
 * does not take that choice back.
 */
export function keepBenchmarksOutOfPersonMemory(
  store: Pick<PersonMemoryStore, "settings" | "view" | "change">,
): { readonly status: "kept-out" } | { readonly status: "refused"; readonly message: string } {
  const settings = store.settings();
  if (settings.excludedProjectIds.some((id) => String(id) === String(BENCHMARKS_PROJECT_ID))) {
    return { status: "kept-out" };
  }
  try {
    const result = store.change(
      decodePersonMemoryCommand({
        kind: "change-person-memory-settings",
        expectedVersion: store.view().version,
        settings: {
          ...settings,
          excludedProjectIds: [...settings.excludedProjectIds, BENCHMARKS_PROJECT_ID],
        },
      }),
    );
    if (result.kind === "person-memory") return { status: "kept-out" };
  } catch {
    // The list is full or the settings could not be written: the same refusal.
  }
  return {
    status: "refused",
    message: "The Benchmarks Project could not be kept out of memory, so no run was started.",
  };
}
