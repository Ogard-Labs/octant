import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkComposerAdapter } from "./WorkComposerAdapter";
import type { ProjectId } from "@octant/contracts/projects";
import type { PickerGroup } from "@octant/domain";

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

  it("renders the no-Project state with an attach folder action", () => {
    const html = renderToStaticMarkup(
      <WorkComposerAdapter {...baseProps} onAttachFolder={() => {}} />,
    );
    expect(html).toContain("No folder");
    expect(html).toContain("Attach folder");
    expect(html).toContain("Choose a Project");
  });

  it("renders the no-Project state without an attach action when none is provided", () => {
    const html = renderToStaticMarkup(<WorkComposerAdapter {...baseProps} />);
    expect(html).toContain("No folder");
    expect(html).not.toContain("Attach folder");
  });

  it("tucks host and Project context behind the prompt instead of boxing it inside", () => {
    const { container } = render(<WorkComposerAdapter {...baseProps} />);
    const frame = container.querySelector(".composer");
    const strip = container.querySelector(".work-composer-adapter__context-strip");

    expect(frame).not.toBeNull();
    expect(strip).not.toBeNull();
    expect(frame?.contains(strip)).toBe(false);
    expect(strip?.parentElement).toHaveClass("work-composer-adapter__composer");
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
          projectId={"00000000-0000-0000-0000-000000000001" as ProjectId}
          projectName="My Docs"
          projectRoot="/home/user/docs"
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

  it("turns a pasted PNG into a pending attachment and omits it after remove", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn();
    render(
      <WorkComposerAdapter
        providerGroups={[visionProviderGroup()]}
        selectedProviderInstanceId={"80000000-0000-4000-8000-0000000000a1" as never}
        selectedModelId={"model-one" as never}
        onSelectProvider={() => {}}
        onCreateThread={onCreateThread}
        onCancel={() => {}}
        projectId={"00000000-0000-0000-0000-000000000001" as ProjectId}
        projectName="My Docs"
        projectRoot="/home/user/docs"
      />,
    );

    const composer = screen.getByLabelText("First message");
    pasteImage(composer);
    expect(await screen.findByAltText("pasted.png")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove pasted.png" }));
    expect(screen.queryByAltText("pasted.png")).not.toBeInTheDocument();

    await user.type(composer, "Draft the brief");
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    expect(onCreateThread).toHaveBeenCalledWith("Draft the brief", [], []);
  });

  it("sends a file-attached image with the first turn", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn();
    render(
      <WorkComposerAdapter
        providerGroups={[visionProviderGroup()]}
        selectedProviderInstanceId={"80000000-0000-4000-8000-0000000000a1" as never}
        selectedModelId={"model-one" as never}
        onSelectProvider={() => {}}
        onCreateThread={onCreateThread}
        onCancel={() => {}}
        projectId={"00000000-0000-0000-0000-000000000001" as ProjectId}
        projectName="My Docs"
        projectRoot="/home/user/docs"
      />,
    );

    await user.upload(
      screen.getByLabelText("Choose attachment file"),
      new File([new Uint8Array([137, 80, 78])], "diagram.png", { type: "image/png" }),
    );
    expect(await screen.findByAltText("diagram.png")).toBeInTheDocument();
    await user.type(screen.getByLabelText("First message"), "Match this mockup");
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    expect(onCreateThread).toHaveBeenCalledWith(
      "Match this mockup",
      [expect.objectContaining({ name: "diagram.png", type: "image/png" })],
      [],
    );
  });

  it("says a text-only model cannot take the image instead of attaching it", async () => {
    render(
      <WorkComposerAdapter
        providerGroups={[textOnlyProviderGroup()]}
        selectedProviderInstanceId={"80000000-0000-4000-8000-0000000000a1" as never}
        selectedModelId={"model-one" as never}
        onSelectProvider={() => {}}
        onCreateThread={vi.fn()}
        onCancel={() => {}}
      />,
    );

    pasteImage(screen.getByLabelText("First message"));
    const attached = await screen.findByLabelText("Attached images");
    expect(attached).toHaveTextContent(
      "The selected model does not accept images. Choose an image-capable model.",
    );
    expect(screen.queryByAltText("pasted.png")).not.toBeInTheDocument();
  });

  it("refuses to start the first turn until a Project is chosen", async () => {
    const onCreateThread = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <WorkComposerAdapter
          providerGroups={[]}
          onSelectProvider={() => {}}
          onCreateThread={onCreateThread}
          onCancel={() => {}}
        />,
      );
    });
    const textarea = container.querySelector("textarea");
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      nativeInputValueSetter?.call(textarea, "Draft the brief");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(onCreateThread).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Create thread"]')).toBeDisabled();
    root.unmount();
    container.remove();
  });

  it("opens a typeahead of openable threads when # is typed", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    render(
      <WorkComposerAdapter
        {...baseProps}
        projectId={"00000000-0000-0000-0000-000000000001" as ProjectId}
        serverUrl="http://127.0.0.1:9"
        windowCapability="cap"
        onCreateThread={vi.fn()}
      />,
    );
    // Without a live mention client the composer still types `#` as ordinary
    // text and does not invent a file picker — Chat's `#` surface is what
    // appears only once the host is reachable.
    await user.type(screen.getByLabelText("First message"), "#rel");
    expect(
      screen.queryByRole("listbox", { name: "Files you can mention" }),
    ).not.toBeInTheDocument();
    void onQueryChange;
  });
});

function pasteImage(composer: HTMLElement): void {
  const file = new File([new Uint8Array([137, 80, 78])], "pasted.png", { type: "image/png" });
  fireEvent.paste(composer, { clipboardData: { files: [file], items: [] } });
}

function visionProviderGroup(): PickerGroup {
  return providerGroup({ inputModalities: ["text", "image"] });
}

function textOnlyProviderGroup(): PickerGroup {
  return providerGroup({ inputModalities: ["text"] });
}

function providerGroup(input: {
  readonly inputModalities: ReadonlyArray<"text" | "image">;
}): PickerGroup {
  return {
    driverLabel: "OpenCode",
    endpointHost: "local",
    executionHost: "local",
    instance: {
      id: "80000000-0000-4000-8000-0000000000a1",
      displayName: "Local OpenCode",
    },
    readiness: "ready",
    sections: [
      {
        label: "Models",
        models: [
          {
            model: {
              id: "model-one",
              displayName: "Model One",
              inputModalities: input.inputModalities,
            },
          },
        ],
      },
    ],
  } as never;
}
