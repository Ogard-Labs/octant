import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewWorkspaceTab } from "./PreviewWorkspaceTab";
import { buildManifest } from "./previewViewTestModel";

const usePreviewController = vi.hoisted(() => vi.fn());
vi.mock("./usePreviewController", () => ({ usePreviewController }));

const manifest = buildManifest({ kind: "pdf", displayName: "report.pdf", bounds: { pages: 1 } });

describe("PreviewWorkspaceTab native handoff lifecycle", () => {
  afterEach(() => vi.clearAllMocks());

  it("wires authenticated handoff actions through the preview controller", async () => {
    const handoff = vi.fn(async () => undefined);
    usePreviewController.mockReturnValue({
      model: {
        status: "ready",
        target: manifest.target,
        manifest,
        manifestKind: "pdf",
        sourceVersion: manifest.sourceVersion,
        chunks: [],
        canRetry: false,
        canRevealInFinder: true,
        canQuickLook: true,
        canOpenExternally: true,
      },
      retry: vi.fn(),
      cancel: vi.fn(),
      handoff,
      cancelHandoff: vi.fn(),
      handoffPending: false,
    });
    render(
      <PreviewWorkspaceTab
        tab={{
          kind: "preview",
          id: "00000000-0000-4000-8000-000000000901" as never,
          mode: "code",
          title: "Report",
          targetId: manifest.target.targetId,
          projectId: manifest.target.projectId,
          hostId: manifest.target.hostId,
          targetKind: manifest.target.kind,
          opaqueRef: manifest.target.opaqueRef,
          displayName: manifest.target.displayName,
        }}
        client={undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reveal preview in Finder" }));
    fireEvent.click(screen.getByRole("button", { name: "Open preview in Quick Look" }));
    fireEvent.click(screen.getByRole("button", { name: "Open preview externally" }));
    expect(handoff).toHaveBeenNthCalledWith(1, "reveal-in-finder");
    expect(handoff).toHaveBeenNthCalledWith(2, "quick-look");
    expect(handoff).toHaveBeenNthCalledWith(3, "open-external");
  });

  it("surfaces pending cancellation and path-free status from the controller", () => {
    const cancelHandoff = vi.fn();
    usePreviewController.mockReturnValue({
      model: {
        status: "ready",
        target: manifest.target,
        manifest,
        manifestKind: "pdf",
        sourceVersion: manifest.sourceVersion,
        chunks: [],
        canRetry: false,
        canRevealInFinder: true,
        canQuickLook: true,
        canOpenExternally: true,
      },
      retry: vi.fn(),
      cancel: vi.fn(),
      handoff: vi.fn(async () => undefined),
      cancelHandoff,
      handoffPending: true,
      handoffMessage: "Opened Quick Look.",
    });
    render(
      <PreviewWorkspaceTab
        tab={{
          kind: "preview",
          id: "00000000-0000-4000-8000-000000000901" as never,
          mode: "code",
          title: "Report",
          targetId: manifest.target.targetId,
          projectId: manifest.target.projectId,
          hostId: manifest.target.hostId,
          targetKind: manifest.target.kind,
          opaqueRef: manifest.target.opaqueRef,
          displayName: manifest.target.displayName,
        }}
        client={undefined}
      />,
    );
    expect(screen.getByText("Opened Quick Look.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel native preview handoff" }));
    expect(cancelHandoff).toHaveBeenCalledOnce();
  });
});
