import { useState, type ReactNode } from "react";
import type { MobileInboxRow, MobileRemoteTransport } from "@octant/client-runtime";
import { ThreadRowActionsSheet } from "./ThreadRowActionsSheet";

export interface ThreadRowMenuProps {
  readonly row: MobileInboxRow;
  readonly transport: MobileRemoteTransport | undefined;
  readonly onChanged: () => void;
  readonly children: (offer: {
    /** What a long press on the row opens; absent where the system's menu answers it. */
    readonly onLongPress?: (() => void) | undefined;
    /** Opens the actions without a press, for a screen reader. */
    readonly onOffer: () => void;
  }) => ReactNode;
}

/** A thread row with its actions behind a long press. */
export function ThreadRowMenu(props: ThreadRowMenuProps) {
  const [open, setOpen] = useState(false);
  const offer = () => setOpen(true);
  return (
    <>
      {props.children({ onLongPress: offer, onOffer: offer })}
      {open ? (
        <ThreadRowActionsSheet
          onChanged={props.onChanged}
          onClose={() => setOpen(false)}
          row={props.row}
          transport={props.transport}
        />
      ) : null}
    </>
  );
}
