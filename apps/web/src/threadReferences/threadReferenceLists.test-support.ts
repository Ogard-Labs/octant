import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import type { ThreadReferenceLists } from "./ThreadReferences";

/** A window that lists these threads, in a Project named octant. */
export function listsOf(
  lists: Partial<Record<"chat" | "work" | "code", ReadonlyArray<ChatThreadNavigationItem>>>,
  onOpen: ThreadReferenceLists["onOpen"] = () => undefined,
): ThreadReferenceLists {
  return {
    chat: lists.chat ?? [],
    work: lists.work ?? [],
    code: lists.code ?? [],
    withProviderMark: (thread) => thread,
    projects: [{ id: "project-1", name: "octant" }],
    onOpen,
  };
}
