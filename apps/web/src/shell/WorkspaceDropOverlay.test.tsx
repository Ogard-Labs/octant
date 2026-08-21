import { decodePaneId } from "@octant/contracts/shell";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkspaceDropOverlay } from "./WorkspaceDropOverlay";
import type { WorkspaceSurfaceDropDestination } from "./workspaceTabDragGeometry";

const paneId = decodePaneId("00000000-0000-4000-8000-000000001301");

describe("WorkspaceDropOverlay", () => {
  it("renders a non-interactive directional preview with a visible text cue", () => {
    const destination: WorkspaceSurfaceDropDestination = {
      kind: "edge",
      targetPaneId: paneId,
      edge: "right",
    };
    const { container } = render(
      <WorkspaceDropOverlay destination={destination} targetPaneId={String(paneId)} />,
    );

    expect(container.querySelector(".workspace-drop-overlay")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(container.querySelector(".workspace-drop-overlay")).toHaveAttribute(
      "data-drop-edge",
      "right",
    );
    expect(screen.getByText("Split right")).toBeVisible();
  });

  it("does not render without a destination or for a different target pane", () => {
    const { container, rerender } = render(
      <WorkspaceDropOverlay destination={null} targetPaneId={String(paneId)} />,
    );
    expect(container).toBeEmptyDOMElement();

    rerender(
      <WorkspaceDropOverlay
        destination={{ kind: "center", targetPaneId: paneId }}
        targetPaneId="00000000-0000-4000-8000-000000001303"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a center-drop cue without relying on color", () => {
    render(
      <WorkspaceDropOverlay
        destination={{ kind: "center", targetPaneId: paneId }}
        targetPaneId={String(paneId)}
      />,
    );

    expect(screen.getByText("Open in this pane")).toBeVisible();
  });
});
