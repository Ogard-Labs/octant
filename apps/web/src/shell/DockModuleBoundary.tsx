import { Component, type ReactNode } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";

/**
 * A tool's render or chunk failure cannot replace its owning conversation.
 * A dialog passes `onClose`: its opener cannot be pressed again while the
 * notice shows, so the notice itself has to offer the way out.
 */
export class DockModuleBoundary extends Component<
  { readonly children: ReactNode; readonly onClose?: () => void },
  { readonly failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    const { onClose } = this.props;
    return (
      <OctantAlert
        action={
          onClose && (
            <OctantButton onClick={onClose} type="button" variant="secondary">
              Close
            </OctantButton>
          )
        }
        tone="warning"
      >
        This tool could not load. Close and reopen it, or refresh the app if it stays unavailable.
      </OctantAlert>
    );
  }
}
