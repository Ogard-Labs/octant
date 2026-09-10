import { useEffect, useState } from "react";
import type { BundledWhatsNewView, OctantHostBridge } from "../shell/hostBridge";
import { WhatsNewDialog } from "./WhatsNewDialog";

export interface WhatsNewAfterUpdateProps {
  readonly hostBridge?: OctantHostBridge;
  readonly firstRunVisible: boolean;
}

/**
 * After a version the person chose to install finishes applying on relaunch,
 * show what that version changed. First-run setup stays out of it.
 */
export function WhatsNewAfterUpdate(props: WhatsNewAfterUpdateProps) {
  const read = props.hostBridge?.readBundledWhatsNew;
  const acknowledge = props.hostBridge?.acknowledgeWhatsNew;
  const [document, setDocument] = useState<BundledWhatsNewView>();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (read === undefined || props.firstRunVisible) return;
    let cancelled = false;
    void read()
      .then((next) => {
        if (cancelled) return;
        setDocument(next);
        if (next.kind === "notes" && next.showAfterApply) setOpen(true);
      })
      .catch(() => {
        if (!cancelled) {
          setDocument({ kind: "empty", version: "", showAfterApply: false });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.firstRunVisible, read]);

  if (read === undefined) return null;

  return (
    <WhatsNewDialog
      document={document}
      onClose={() => {
        setOpen(false);
        void acknowledge?.();
      }}
      open={open}
    />
  );
}
