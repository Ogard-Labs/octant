import type { ReactNode, RefObject } from "react";
import { ShadcnDialogShell } from "../shadcn/dialog";

export interface OctantDialogProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly initialFocus?: RefObject<HTMLElement | null>;
  readonly label: string;
  readonly onClose: () => void;
  readonly open: boolean;
  readonly popupId?: string;
  readonly restoreFocus?: RefObject<HTMLElement | null>;
}

/** Octant dialog adapter over the owned shadcn/Base UI Dialog recipe. */
export function OctantDialog(props: OctantDialogProps) {
  return <ShadcnDialogShell {...props} />;
}
