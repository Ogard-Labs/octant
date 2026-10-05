import type { CanvasExportOfferList } from "@octant/contracts/canvas-export";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CanvasExportPanel } from "./CanvasExportPanel";

const canvasId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const approvalId = "44444444-4444-4444-8444-444444444444";

function offers(): CanvasExportOfferList {
  return {
    schemaVersion: 1,
    kind: "canvas-export-offers",
    canvasId: canvasId as CanvasExportOfferList["canvasId"],
    versionId: versionId as CanvasExportOfferList["versionId"],
    sequence: 1,
    targets: [
      {
        targetId: "reading-copy" as CanvasExportOfferList["targets"][number]["targetId"],
        label: "Reading copy",
        formats: ["markdown"],
        status: "ready",
      },
      {
        targetId: "archive-copy" as CanvasExportOfferList["targets"][number]["targetId"],
        label: "Archive copy",
        formats: ["markdown"],
        status: "not-connected",
        message: "This destination is not connected.",
      },
    ],
  };
}

describe("CanvasExportPanel", () => {
  it("shows the rendered payload and the destination before anything is sent", async () => {
    const user = userEvent.setup();
    const onPrepare = vi.fn(async () => ({
      kind: "approval" as const,
      card: {
        schemaVersion: 1 as const,
        kind: "canvas-export-approval" as const,
        approvalId: approvalId as CanvasExportOfferList["canvasId"],
        canvasId: canvasId as CanvasExportOfferList["canvasId"],
        versionId: versionId as CanvasExportOfferList["versionId"],
        sequence: 1,
        targetId: "reading-copy" as CanvasExportOfferList["targets"][number]["targetId"],
        destinationLabel: "Reading copy",
        format: "markdown" as const,
        title: "Launch plan",
        payload: "# Launch plan\n",
        payloadDigest:
          "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as CanvasExportOfferList["targets"][number]["targetId"],
        byteLength: 15,
      },
    }));
    const onDecide = vi.fn();
    render(
      <CanvasExportPanel
        offers={offers()}
        onDecide={onDecide as never}
        onPrepare={onPrepare as never}
      />,
    );

    expect(screen.getByText("Not connected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review export" }));

    expect(onDecide).not.toHaveBeenCalled();
    expect(await screen.findByText("Export to Reading copy")).toBeInTheDocument();
    expect(screen.getByTestId("canvas-export-payload")).toHaveTextContent("# Launch plan");
  });

  it("says when no destination is ready", () => {
    render(
      <CanvasExportPanel
        offers={{ ...offers(), targets: [] }}
        onDecide={vi.fn()}
        onPrepare={vi.fn()}
      />,
    );

    expect(screen.getByTestId("canvas-export-empty")).toHaveTextContent(
      "No export destination is installed yet.",
    );
  });
});
