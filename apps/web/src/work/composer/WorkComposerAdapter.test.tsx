import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkComposerAdapter } from "./WorkComposerAdapter";
import type { ProjectId } from "@octant/contracts/projects";

const baseProps = {
  providerGroups: [],
  onSelectProvider: () => {},
  onCreateThread: () => {},
  onCancel: () => {},
};

describe("WorkComposerAdapter", () => {
  it("renders with project folder context", () => {
    const html = renderToStaticMarkup(
      <WorkComposerAdapter
        {...baseProps}
        projectId={"00000000-0000-0000-0000-000000000001" as ProjectId}
        projectName="My Docs"
        projectRoot="/home/user/docs"
      />,
    );
    expect(html).toContain("Octant Work");
    expect(html).toContain("What are we working on?");
    expect(html).toContain("My Docs");
    expect(html).toContain("confined folder");
  });

  it("renders rootless state with attach folder action", () => {
    const html = renderToStaticMarkup(
      <WorkComposerAdapter {...baseProps} onAttachFolder={() => {}} />,
    );
    expect(html).toContain("No folder");
    expect(html).toContain("Attach folder");
    expect(html).toContain("without a folder");
  });

  it("renders rootless state without attach action when not provided", () => {
    const html = renderToStaticMarkup(<WorkComposerAdapter {...baseProps} />);
    expect(html).toContain("No folder");
    expect(html).not.toContain("Attach folder");
  });

  it("renders disabled send button when empty", () => {
    const html = renderToStaticMarkup(<WorkComposerAdapter {...baseProps} />);
    expect(html).toContain('aria-label="Create thread"');
    expect(html).toContain("disabled");
  });

  it("renders error message when provided", () => {
    const html = renderToStaticMarkup(
      <WorkComposerAdapter {...baseProps} errorMessage="Provider unavailable" />,
    );
    expect(html).toContain("Provider unavailable");
    expect(html).toContain('role="alert"');
  });

  it("renders creating state", () => {
    const html = renderToStaticMarkup(<WorkComposerAdapter {...baseProps} creating />);
    expect(html).toContain("disabled");
  });

  it("does not expose Code-specific controls", () => {
    const html = renderToStaticMarkup(<WorkComposerAdapter {...baseProps} />);
    expect(html).not.toContain("Delivery target");
    expect(html).not.toContain("Access policy");
    expect(html).not.toContain("Full access");
    expect(html).not.toContain("Base repository");
  });

  it("has keyboard hint", () => {
    const html = renderToStaticMarkup(<WorkComposerAdapter {...baseProps} />);
    expect(html).toContain("Press Enter to start");
    expect(html).toContain("Escape to close");
  });

  it("renders the multi-model pool control slot in the context strip", () => {
    const html = renderToStaticMarkup(
      <WorkComposerAdapter {...baseProps} poolControl={<span>Pool control slot</span>} />,
    );
    expect(html).toContain("Pool control slot");
  });

  it("renders no pool control when the slot is not provided", () => {
    const html = renderToStaticMarkup(<WorkComposerAdapter {...baseProps} />);
    expect(html).not.toContain("Pool control slot");
  });
});

import { createRoot } from "react-dom/client";
import { act } from "react";

describe("WorkComposerAdapter interactions", () => {
  it("submits on Enter and cancels on Escape", async () => {
    const onCreateThread = vi.fn();
    const onCancel = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <WorkComposerAdapter
          providerGroups={[]}
          onSelectProvider={() => {}}
          onCreateThread={onCreateThread}
          onCancel={onCancel}
        />,
      );
    });
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      nativeInputValueSetter?.call(textarea, "Draft the brief");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onCreateThread).toHaveBeenCalled();
    await act(async () => {
      textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalled();
    root.unmount();
    container.remove();
  });
});
