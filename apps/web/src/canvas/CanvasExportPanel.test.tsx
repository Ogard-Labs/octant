import type { CanvasExportOfferList } from "@octant/contracts/canvas-export";
import { decodeCanvasExportFolderView } from "@octant/contracts/canvas-export-folder";
import { decodeFolderBrowseResult } from "@octant/contracts/folder-browse";
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

  it("says a delivered export could not be recorded instead of reporting a failure", async () => {
    const user = userEvent.setup();
    const onPrepare = vi.fn(async () => ({
      kind: "approval" as const,
      card: {
        schemaVersion: 1 as const,
        kind: "canvas-export-approval" as const,
        approvalId,
        canvasId,
        versionId,
        sequence: 1,
        targetId: "reading-copy",
        destinationLabel: "Reading copy",
        format: "markdown" as const,
        title: "Launch plan",
        payload: "# Launch plan\n",
        payloadDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        byteLength: 15,
      },
    }));
    const onDecide = vi.fn(async () => ({
      kind: "unrecorded" as const,
      outcome: {
        kind: "receipt" as const,
        receipt: { kind: "remote-id" as const, remoteId: "copy-1" },
      },
      message: "The export was delivered, but this host could not record it.",
    }));
    render(
      <CanvasExportPanel
        offers={offers()}
        onDecide={onDecide as never}
        onPrepare={onPrepare as never}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Review export" }));
    await user.click(await screen.findByRole("button", { name: "Approve export" }));

    expect(await screen.findByText(/Exported\. copy-1/)).toHaveTextContent(
      "The export was delivered, but this host could not record it.",
    );
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

  it("names the file the export will write, and says when it replaces one", async () => {
    const user = userEvent.setup();
    const onPrepare = vi.fn(async () => ({
      kind: "approval" as const,
      card: {
        schemaVersion: 1 as const,
        kind: "canvas-export-approval" as const,
        approvalId,
        canvasId,
        versionId,
        sequence: 1,
        targetId: "folder-on-this-mac",
        destinationLabel: "A folder on this Mac",
        format: "markdown" as const,
        title: "Launch plan",
        destinationPath: "/Users/henrik/Documents/Exports/Launch plan.md",
        replacesExisting: true,
        payload: "# Launch plan\n",
        payloadDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        byteLength: 15,
      },
    }));
    render(
      <CanvasExportPanel offers={offers()} onDecide={vi.fn()} onPrepare={onPrepare as never} />,
    );

    await user.click(screen.getByRole("button", { name: "Review export" }));

    expect(await screen.findByTestId("canvas-export-destination")).toHaveTextContent(
      "Replaces /Users/henrik/Documents/Exports/Launch plan.md",
    );
  });

  it("shows the chosen folder and sends back the candidate the host listed", async () => {
    const user = userEvent.setup();
    const candidateId = "88888888-8888-4888-8888-888888888888";
    const choose = vi.fn(async () => true);
    const onExportFolderChosen = vi.fn();
    render(
      <CanvasExportPanel
        folder={{
          view: decodeCanvasExportFolderView({
            kind: "canvas-export-folder-view",
            settings: {
              kind: "canvas-export-folder-settings",
              overrides: [],
              version: 0,
              updatedAt: "2026-08-01T21:00:00.000Z",
            },
            scope: "project",
            hostId: "local",
            mode: "work",
          }),
          busy: false,
          message: undefined,
          browse: async () =>
            decodeFolderBrowseResult({
              candidates: [
                {
                  candidateId,
                  displayName: "Exports",
                  isGitRepository: false,
                  isSelectable: true,
                },
              ],
              breadcrumbs: [{ label: "henrik" }],
              hasMore: false,
              browsedAt: "2026-08-01T21:00:00.000Z",
            }),
          choose,
        }}
        offers={offers()}
        onDecide={vi.fn()}
        onExportFolderChosen={onExportFolderChosen}
        onPrepare={vi.fn()}
      />,
    );

    expect(screen.getByTestId("canvas-export-folder")).toHaveTextContent("No folder chosen yet");

    await user.click(screen.getByRole("button", { name: "Choose folder…" }));
    await user.click(await screen.findByRole("button", { name: "Select" }));

    expect(choose).toHaveBeenCalledWith(candidateId);
    expect(onExportFolderChosen).toHaveBeenCalled();
  });
});
