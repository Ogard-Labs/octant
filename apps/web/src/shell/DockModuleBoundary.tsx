import { Component, type ReactNode } from "react";

/** A tool's render or chunk failure cannot replace its owning conversation. */
export class DockModuleBoundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <p role="alert">
        This tool could not be displayed. Close and reopen it, or refresh the app if it remains
        unavailable.
      </p>
    ) : (
      this.props.children
    );
  }
}
