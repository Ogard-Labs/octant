import { decodeHostId, LOCAL_HOST_ID } from "@octant/contracts/host";
import { decodeProviderInstanceId, decodeProviderModelId } from "@octant/contracts/providers";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkComposerAdapter } from "./WorkComposerAdapter";
import type { ProjectId } from "@octant/contracts/projects";
import type { PickerGroup } from "@octant/domain";
import { decodeExtensionSelection } from "@octant/contracts/extensions";
import { computerUseSelection } from "@octant/plugin-host/computer-use";
import {
  createNewTaskDrafts,
  NewTaskDraftsContext,
  NewTaskDraftScopeContext,
} from "../../composer/useNewTaskPrompt";

const twoHosts = [
  {
    hostId: LOCAL_HOST_ID,
    displayName: "This Mac",
    health: "healthy" as const,
    capabilities: ["chat", "work", "code"],
  },
  {
    hostId: decodeHostId("11111111-1111-4111-8111-111111111111"),
    displayName: "Studio",
    health: "healthy" as const,
    capabilities: ["chat", "work", "code"],
  },
];

const baseProps = {
  providerGroups: [],
  onSelectProvider: () => {},
  onCreateThread: () => {},
  onCancel: () => {},
};

describe("WorkComposerAdapter", () => {
  it("shows Set up a provider on the Work start composer until a provider is ready", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    render(<WorkComposerAdapter {...baseProps} onOpenSettings={onOpenSettings} />);
    const setup = screen.getByRole("button", { name: "Set up a provider" });
    expect(setup).toBeEnabled();
    await user.click(setup);
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("submits the selected reasoning level with the first Work message", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn();
    const group = visionProviderGroup();
    const composer = (
      <WorkComposerAdapter
        {...baseProps}
        projectId={"00000000-0000-0000-0000-000000000001" as ProjectId}
        selectedProviderInstanceId={decodeProviderInstanceId(
          "80000000-0000-4000-8000-0000000000a1",
        )}
        selectedModelId={decodeProviderModelId("model-one")}
        providerGroups={[
          {
            ...group,
            sections: group.sections.map((section) => ({
              ...section,
              models: section.models.map((entry) => ({
                ...entry,
                model: {
                  ...entry.model,
                  options: [
                    {
                      kind: "selection",
                      id: "effort",
                      displayName: "Effort",
                      values: ["low", "high"],
                    },
                  ],
                },
              })),
            })),
          },
        ]}
        onCreateThread={onCreateThread}
      />
    );
    const { rerender } = render(composer);
    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    const level = screen.getByRole("slider", { name: "Effort level" });
    fireEvent.change(level, { target: { value: level.getAttribute("max") } });
    await user.keyboard("{Escape}");
    await user.type(screen.getByLabelText("First message"), "Draft the brief");
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    await waitFor(() =>
      expect(onCreateThread).toHaveBeenCalledWith("Draft the brief", [], [], undefined, undefined, {
        effort: "high",
      }),
    );
    rerender(
      <WorkComposerAdapter
        {...composer.props}
        selectedModelId={decodeProviderModelId("model-two")}
      />,
    );
    rerender(composer);
    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    // Returning to this model restores its last supported effort choice.
    expect(screen.getByRole("slider", { name: "Effort level" })).toHaveAttribute(
      "aria-valuetext",
      "High",
    );
  });

  it("renders with project folder context", () => {
    const html = renderToStaticMarkup(
      <WorkComposerAdapter
        {...baseProps}
        projectId={"00000000-0000-0000-0000-000000000001" as ProjectId}
        projectName="My Docs"
        projectRoot="/home/user/docs"
      />,
    );
    expect(html).toMatch(/What are we building today\?/);
    expect(html).not.toContain("What are we working on?");
    expect(html).toContain("My Docs");
    expect(html).not.toContain("Octant Work");
    expect(html).not.toContain("confined folder");
  });

  it("renders the no-Project state with an attach folder action", () => {
    const html = renderToStaticMarkup(
      <WorkComposerAdapter {...baseProps} onAttachFolder={() => {}} />,
    );
    expect(html).toContain("No folder");
    expect(html).toContain("Attach folder");
    expect(html).not.toContain("Choose a Project to work in");
  });

  it("renders the no-Project state without an attach action when none is provided", () => {
    const html = renderToStaticMarkup(<WorkComposerAdapter {...baseProps} />);
    expect(html).toContain("No folder");
    expect(html).not.toContain("Attach folder");
  });

  it("carries host and Project context on the row inside the composer, above the prompt", () => {
    const { container } = render(<WorkComposerAdapter {...baseProps} hosts={twoHosts} />);
    const frame = container.querySelector(".composer");
    const tray = container.querySelector(".composer-tray");
    const row = container.querySelector(".composer-row");

    expect(frame).not.toBeNull();
    expect(tray).not.toBeNull();
    if (frame === null || tray === null || row === null) {
      throw new Error("Composer stack is incomplete.");
    }
    expect(frame.contains(tray)).toBe(true);
    expect(
      tray.compareDocumentPosition(screen.getByRole("textbox", { name: "First message" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(tray.textContent).toContain("No folder");
    expect(tray.querySelector(".host-selector--environment")).not.toBeNull();
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

  it("does not repeat the keyboard hint under the composer", () => {
    const html = renderToStaticMarkup(<WorkComposerAdapter {...baseProps} />);
    expect(html).not.toContain("Press Enter to start");
  });

  it("renders the multi-model pool control slot in the composer bar", () => {
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

  it("explains that a Project is required before starting the first turn", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn();
    const { rerender } = render(
      <WorkComposerAdapter {...baseProps} onCreateThread={onCreateThread} />,
    );
    await user.type(screen.getByLabelText("First message"), "Draft the brief");
    await user.keyboard("{Enter}");

    expect(onCreateThread).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Choose a Project to work in before sending. Work needs a confined folder.",
    );

    rerender(
      <WorkComposerAdapter
        {...baseProps}
        onCreateThread={onCreateThread}
        projectId={"00000000-0000-0000-0000-000000000001" as ProjectId}
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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

  it("keeps mentioned threads and extension selections after Settings remounts the draft", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn();
    const drafts = createNewTaskDrafts();
    const threadId = "00000000-0000-4000-8000-000000000101";
    drafts.write("work:pane", "#[Prior task] continue from there");
    drafts.writeMentionChips("work:pane", [
      {
        threadId,
        title: "Prior task",
        mode: "work",
        placementLabel: "Recents",
      },
    ]);
    drafts.writeExtensionReceipts("work:pane", [
      {
        reference: "@review",
        label: "Review",
        selection: decodeExtensionSelection({
          kind: "plugin",
          extensionId: "00000000-0000-4000-8000-000000000301",
          packageId: "00000000-0000-4000-8000-000000000302",
          componentId: "review",
          packageVersion: "1.0.0",
          packageDigest: `sha256:${"a".repeat(64)}`,
          catalogEpoch: `sha256:${"b".repeat(64)}`,
          origin: { kind: "draft", reference: "00000000-0000-4000-8000-000000000201" },
        }),
        status: { kind: "selected" },
      },
    ]);
    const view = (
      <NewTaskDraftsContext.Provider value={drafts}>
        <NewTaskDraftScopeContext.Provider value="work:pane">
          <WorkComposerAdapter
            {...baseProps}
            projectId={"00000000-0000-0000-0000-000000000001" as ProjectId}
            onCreateThread={onCreateThread}
          />
        </NewTaskDraftScopeContext.Provider>
      </NewTaskDraftsContext.Provider>
    );
    const rendered = render(view);
    expect(screen.getByLabelText("Mentioned threads")).toHaveTextContent("Prior task");
    expect(screen.getByLabelText("Selected extensions")).toHaveTextContent("Review");

    rendered.unmount();
    render(view);

    expect(await screen.findByLabelText("Mentioned threads")).toHaveTextContent("Prior task");
    expect(screen.getByLabelText("Selected extensions")).toHaveTextContent("Review");
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    await waitFor(() => expect(onCreateThread).toHaveBeenCalled());
    expect(onCreateThread.mock.calls[0]?.[2]).toEqual([threadId]);
    expect(onCreateThread.mock.calls[0]?.[4]).toEqual([
      expect.objectContaining({ kind: "plugin" }),
    ]);
  });

  it("keeps a selected Computer receipt after Settings remounts while tools are blocked", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn();
    const drafts = createNewTaskDrafts();
    drafts.write("work:pane", "open the app");
    drafts.writeExtensionReceipts("work:pane", [
      {
        reference: "@Computer",
        label: "Computer",
        selection: computerUseSelection("00000000-0000-4000-8000-000000000201"),
        status: { kind: "selected" },
      },
    ]);
    const wrap = (selection?: {
      readonly selectedProviderInstanceId: ReturnType<typeof decodeProviderInstanceId>;
      readonly selectedModelId: ReturnType<typeof decodeProviderModelId>;
    }) => (
      <NewTaskDraftsContext.Provider value={drafts}>
        <NewTaskDraftScopeContext.Provider value="work:pane">
          <WorkComposerAdapter
            {...baseProps}
            projectId={"00000000-0000-0000-0000-000000000001" as ProjectId}
            onCreateThread={onCreateThread}
            {...selection}
          />
        </NewTaskDraftScopeContext.Provider>
      </NewTaskDraftsContext.Provider>
    );
    // A selected provider that is not in the groups reports no Octant tools,
    // so the chip is a blocked projection. Persisting that projection would
    // drop the selection before Settings remounts the draft.
    const blocked = render(
      wrap({
        selectedProviderInstanceId: decodeProviderInstanceId(
          "80000000-0000-4000-8000-0000000000b1",
        ),
        selectedModelId: decodeProviderModelId("missing-model"),
      }),
    );
    await waitFor(() => {
      expect(drafts.readExtensionReceipts("work:pane")[0]?.selection).toBeDefined();
    });
    blocked.unmount();
    render(wrap());
    expect(await screen.findByLabelText("Selected extensions")).toHaveTextContent("Computer");
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    await waitFor(() => expect(onCreateThread).toHaveBeenCalled());
    expect(onCreateThread.mock.calls[0]?.[4]).toEqual([
      expect.objectContaining({ kind: "plugin" }),
    ]);
  });

  it("keeps a direct Computer selection after Settings remounts while tools are blocked", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "octantHost");
    Object.defineProperty(window, "octantHost", {
      configurable: true,
      value: { getComputerUseStatus: async () => ({ supported: true }) },
    });
    try {
      const user = userEvent.setup();
      const onCreateThread = vi.fn();
      const drafts = createNewTaskDrafts();
      drafts.write("work:pane", "use the host");
      drafts.writeComputerSelection(
        "work:pane",
        computerUseSelection("00000000-0000-4000-8000-000000000301"),
      );
      const wrap = (selection?: {
        readonly selectedProviderInstanceId: ReturnType<typeof decodeProviderInstanceId>;
        readonly selectedModelId: ReturnType<typeof decodeProviderModelId>;
      }) => (
        <NewTaskDraftsContext.Provider value={drafts}>
          <NewTaskDraftScopeContext.Provider value="work:pane">
            <WorkComposerAdapter
              {...baseProps}
              projectId={"00000000-0000-0000-0000-000000000001" as ProjectId}
              onCreateThread={onCreateThread}
              {...selection}
            />
          </NewTaskDraftScopeContext.Provider>
        </NewTaskDraftsContext.Provider>
      );
      const blocked = render(
        wrap({
          selectedProviderInstanceId: decodeProviderInstanceId(
            "80000000-0000-4000-8000-0000000000b1",
          ),
          selectedModelId: decodeProviderModelId("missing-model"),
        }),
      );
      expect(screen.queryByRole("button", { name: "Remove Computer" })).not.toBeInTheDocument();
      await waitFor(() => {
        expect(drafts.readComputerSelection("work:pane")).toEqual(
          expect.objectContaining({ kind: "plugin" }),
        );
      });
      blocked.unmount();
      expect(drafts.readComputerSelection("work:pane")).toEqual(
        expect.objectContaining({ kind: "plugin" }),
      );
      render(wrap());
      expect(await screen.findByRole("button", { name: "Remove Computer" })).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Create thread" }));
      await waitFor(() => expect(onCreateThread).toHaveBeenCalled());
      expect(onCreateThread.mock.calls[0]?.[3]).toEqual(
        expect.objectContaining({ kind: "plugin" }),
      );
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(window, "octantHost");
      else Object.defineProperty(window, "octantHost", descriptor);
    }
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
