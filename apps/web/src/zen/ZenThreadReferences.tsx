import { useContext, useMemo, type ReactNode } from "react";
import { ThreadReferencesContext } from "../threadReferences/ThreadReferences";

/**
 * The thread names inside Zen's surface. Zen covers the shell, which stays
 * mounted underneath, so a thread opened from a card there would change a pane
 * nobody can see: opening one leaves Zen first.
 */
export function ZenThreadReferences(props: {
  readonly onLeave: () => void;
  readonly children: ReactNode;
}) {
  const lists = useContext(ThreadReferencesContext);
  const { onLeave } = props;
  const leaving = useMemo(
    () =>
      lists && {
        ...lists,
        onOpen: (thread: Parameters<typeof lists.onOpen>[0]) => {
          onLeave();
          lists.onOpen(thread);
        },
      },
    [lists, onLeave],
  );
  return (
    <ThreadReferencesContext.Provider value={leaving}>
      {props.children}
    </ThreadReferencesContext.Provider>
  );
}
