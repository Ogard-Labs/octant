import { OctantEmpty } from "../ui/base/OctantEmpty";
import { Component, type ReactNode } from "react";

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
        <OctantEmpty
          action={{ label: "Reload Octant", onClick: this.props.onReload }}
          eyebrow="Settings"
          message="Reload Octant to retry loading the Settings surface."
          layout="page"
          role="alert"
          state="warning"
          title="Settings unavailable"
        />
      </main>
    );
  }
}
