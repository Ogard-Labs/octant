import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PreviewShell } from "./PreviewShell";
import { buildChunk, buildManifest } from "./previewViewTestModel";
import type { PreviewControllerModel } from "./usePreviewController";

describe("PreviewShell structured registry fold", () => {
  it("renders a PDF through PreviewRegistry when the controller carries a manifest", () => {
    const manifest = buildManifest({
      kind: "pdf",
      displayName: "report.pdf",
      fidelity: { level: "limited", notice: "Text extraction only." },
      bounds: { pages: 1 },
    });
    const model: PreviewControllerModel = {
      status: "ready",
      target: manifest.target,
      manifest,
      manifestKind: "pdf",
      sourceVersion: manifest.sourceVersion,
      chunks: [
        buildChunk({
          kind: "pdf",
          sequence: 0,
          descriptor: { kind: "pdf", page: 1 },
          payload: { kind: "pdf", pageText: "Shell PDF body" },
          isFinal: true,
        }),
      ],
      canRetry: false,
      canRevealInFinder: true,
      canQuickLook: true,
      canOpenExternally: true,
    };
    render(<PreviewShell target={manifest.target} model={model} />);
    expect(screen.getByText("Text extraction only.")).toBeInTheDocument();
    expect(screen.getByRole("document", { name: "Page 1 text" })).toHaveTextContent(
      "Shell PDF body",
    );
  });

  it("offers authenticated handoff actions from truthful capabilities", async () => {
    const onHandoff = vi.fn(async () => undefined);
    const manifest = buildManifest({
      kind: "pdf",
      displayName: "report.pdf",
      bounds: { pages: 1 },
    });
    const model: PreviewControllerModel = {
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
    };
    render(<PreviewShell target={manifest.target} model={model} onHandoff={onHandoff} />);
    expect(screen.getByRole("button", { name: "Reveal preview in Finder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open preview in Quick Look" })).toBeInTheDocument();
    await screen.getByRole("button", { name: "Open preview externally" }).click();
    expect(onHandoff).toHaveBeenCalledWith("open-external");
  });

  it("hides native handoff actions after the preview source becomes stale", () => {
    const onHandoff = vi.fn(async () => undefined);
    const manifest = buildManifest({
      kind: "pdf",
      displayName: "report.pdf",
      bounds: { pages: 1 },
    });
    const model: PreviewControllerModel = {
      status: "stale",
      target: manifest.target,
      manifest,
      manifestKind: "pdf",
      sourceVersion: manifest.sourceVersion,
      chunks: [],
      canRetry: true,
      canRevealInFinder: true,
      canQuickLook: true,
      canOpenExternally: false,
    };
    render(<PreviewShell target={manifest.target} model={model} onHandoff={onHandoff} />);
    expect(screen.queryByRole("button", { name: "Reveal preview in Finder" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open preview in Quick Look" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open preview externally" })).toBeNull();
  });

  it("offers cancellation while a native handoff is pending", async () => {
    const onCancelHandoff = vi.fn();
    const manifest = buildManifest({
      kind: "pdf",
      displayName: "report.pdf",
      bounds: { pages: 1 },
    });
    const model: PreviewControllerModel = {
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
    };
    render(
      <PreviewShell
        target={manifest.target}
        model={model}
        onHandoff={vi.fn(async () => undefined)}
        handoffPending
        onCancelHandoff={onCancelHandoff}
      />,
    );
    await screen.getByRole("button", { name: "Cancel native preview handoff" }).click();
    expect(onCancelHandoff).toHaveBeenCalledOnce();
  });

  it("surfaces a handoff status message without disclosing a path", () => {
    const manifest = buildManifest({
      kind: "pdf",
      displayName: "report.pdf",
      bounds: { pages: 1 },
    });
    const model: PreviewControllerModel = {
      status: "ready",
      target: manifest.target,
      manifest,
      manifestKind: "pdf",
      sourceVersion: manifest.sourceVersion,
      chunks: [],
      canRetry: false,
      canRevealInFinder: false,
      canQuickLook: false,
      canOpenExternally: false,
    };
    render(
      <PreviewShell
        target={manifest.target}
        model={model}
        handoffMessage="Opened in the native application."
      />,
    );
    expect(screen.getByText("Opened in the native application.")).toBeInTheDocument();
    expect(screen.queryByText(/\/private\//)).toBeNull();
  });
});
