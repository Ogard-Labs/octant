import { Component, type ReactNode } from "react";
import { ShellState } from "./ShellState";

export interface SettingsSurfaceErrorBoundaryProps {
  readonly children: ReactNode;
  readonly onReload: () => void;
}

interface SettingsSurfaceErrorBoundaryState {
  readonly failed: boolean;
}

export class SettingsSurfaceErrorBoundary extends Component<
  SettingsSurfaceErrorBoundaryProps,
  SettingsSurfaceErrorBoundaryState
> {
  override state = { failed: false };

  static getDerivedStateFromError(): SettingsSurfaceErrorBoundaryState {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="shell-boundary">
        <ShellState
          action={{ label: "Reload Octant", onClick: this.props.onReload }}
          eyebrow="Settings"
          message="Reload Octant to retry loading the Settings surface."
          role="alert"
          state="warning"
          title="Settings unavailable"
        />
      </main>
    );
  }
}
