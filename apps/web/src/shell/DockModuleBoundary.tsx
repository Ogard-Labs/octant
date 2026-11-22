import { Component, type ReactNode } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";

/**
 * A tool's render or chunk failure cannot replace its owning conversation.
 * A dialog passes `onClose`: its opener cannot be pressed again while the
 * notice shows, so the notice itself has to offer the way out.
 * A surface that swaps what it shows passes `resetKey`: a failure clears when
 * it changes, but a healthy subtree is never remounted, so a reader opened over
 * another keeps the one underneath, and its unsaved edits, alive.
 */
export class DockModuleBoundary extends Component<
  {
    readonly children: ReactNode;
    readonly onClose?: () => void;
    readonly resetKey?: string;
  },
  { readonly failed: boolean; readonly resetKey: string | undefined }
> {
  override state = { failed: false, resetKey: this.props.resetKey };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  static getDerivedStateFromProps(
    props: { readonly resetKey?: string },
    state: { readonly resetKey: string | undefined },
  ) {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
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
