import { Alert } from "react-native";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { useMobileSession } from "../session/MobileSessionContext";
import { useMobileThreads } from "./MobileThreadsContext";
import { UndoNotice } from "./UndoNotice";
import { useThreadRowAction } from "./useThreadRowAction";
import type { MobileInboxRow } from "@octant/client-runtime";

/** The way back from a thread just settled, over whichever list settled it. */
export function ThreadUndo() {
  const { rows, undoable } = useMobileThreads();
  // The row as its computer now has it: settling moved its version on.
  const row = rows.find(
    (entry) =>
      undoable !== undefined &&
      entry.hostId === undoable.hostId &&
      entry.mode === undoable.mode &&
      entry.threadId === undoable.threadId &&
      entry.completedAt !== undefined,
  );
  return row === undefined ? null : <Settled row={row} />;
}

function Settled(props: { readonly row: MobileInboxRow }) {
  const { row } = props;
  const { transports } = useMobileSession();
  const { clearUndo, refresh } = useMobileThreads();
  const { run } = useThreadRowAction({
    row,
    transport: transports.find((entry) => entry.hostId === row.hostId),
    onDone: () => {
      clearUndo();
      void refresh();
    },
    onFailed: (message) => {
      clearUndo();
      Alert.alert(formatScreenshotSafeLabel(row.title), message);
    },
  });
  return (
    <UndoNotice onGone={clearUndo} onUndo={() => run({ kind: "reopen" })} text="Thread settled" />
  );
}
