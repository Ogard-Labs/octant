import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkspaceDropOverlay } from "./WorkspaceDropOverlay";
import type { WorkspaceTabDropDestination } from "./workspaceTabDragGeometry";

const groupId = "00000000-0000-4000-8000-000000001301" as never;
const tabId = "00000000-0000-4000-8000-000000001302" as never;

describe("WorkspaceDropOverlay", () => {
  it("renders a non-interactive directional preview with a visible text cue", () => {
    const destination: WorkspaceTabDropDestination = {
      kind: "edge",
      sourceGroupId: groupId,
      targetGroupId: groupId,
      tabId,
      edge: "right",
    };
    const { container } = render(
      <WorkspaceDropOverlay destination={destination} targetGroupId={groupId} />,
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

  it("does not render for reorder or a different target group", () => {
    const destination: WorkspaceTabDropDestination = {
      kind: "reorder",
      sourceGroupId: groupId,
      targetGroupId: groupId,
      tabId,
      index: 0,
    };
    const { container, rerender } = render(
      <WorkspaceDropOverlay destination={destination} targetGroupId={groupId} />,
    );
    expect(container).toBeEmptyDOMElement();

    rerender(
      <WorkspaceDropOverlay
        destination={{ ...destination, kind: "center", index: 0 }}
        targetGroupId={"00000000-0000-4000-8000-000000001303" as never}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a center-group cue without relying on color", () => {
    render(
      <WorkspaceDropOverlay
        destination={{
          kind: "center",
          sourceGroupId: groupId,
          targetGroupId: groupId,
          tabId,
          index: 0,
        }}
        targetGroupId={groupId}
      />,
    );

    expect(screen.getByText("Move to this tab group")).toBeVisible();
  });
});
