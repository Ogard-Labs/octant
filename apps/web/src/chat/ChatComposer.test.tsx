import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  decodeContentSha256,
  decodePreviewContextSelectionId,
  decodePreviewTargetId,
} from "@octant/contracts/previews";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatComposer, type ChatComposerProps } from "./ChatComposer";
import { OctantCommandProvider } from "../palette/CommandRegistry";
import type { OctantCommand } from "../palette/commandModel";

function renderComposer(overrides: Partial<ChatComposerProps> = {}) {
  const props: ChatComposerProps = {
    draft: "",
    isSending: false,
    model: {
      options: [{ id: "model-a", label: "Model A" }],
      value: "model-a",
    },
    onDraftChange: vi.fn(),
    onFileSelected: vi.fn(),
    onModelChange: vi.fn(),
    onProviderChange: vi.fn(),
    onResearchEnabledChange: vi.fn(),
    onResearchRoutingChange: vi.fn(),
    onSend: vi.fn(async () => true),
    provider: {
      options: [{ id: "provider-a", label: "Provider A" }],
      value: "provider-a",
    },
    research: {
      backend: { kind: "selected", backend: "searxng" },
      enabled: false,
      routing: "automatic",
    },
    ...overrides,
  };
  return { props, ...render(<ChatComposer {...props} />) };
}

describe("ChatComposer", () => {
  it("starts as a compact one-line composer and hides a redundant provider picker", () => {
    renderComposer();

    expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute("rows", "1");
    expect(screen.getByRole("toolbar", { name: "Composer controls" })).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Provider" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Model" })).toBeVisible();
  });

  it("keeps its caller-owned multiline draft until the send succeeds", async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn();
    const onSend = vi.fn(async () => true);
    const { rerender, props } = renderComposer({
      draft: "Keep this\ndraft",
      onDraftChange,
      onSend,
    });

    const draft = screen.getByLabelText("Message");
    expect(draft).toHaveValue("Keep this\ndraft");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSend).toHaveBeenCalledWith("Keep this\ndraft");
    expect(draft).toHaveValue("Keep this\ndraft");

    rerender(<ChatComposer {...props} draft="" onDraftChange={onDraftChange} onSend={onSend} />);
    expect(screen.getByLabelText("Message")).toHaveValue("");
  });

  it("restores the caret when returning to a thread", () => {
    renderComposer({
      caretIndex: 4,
      caretRestoreKey: "thread-a",
      draft: "half-written",
    });
    const message = screen.getByLabelText("Message") as HTMLTextAreaElement;
    expect(message.selectionStart).toBe(4);
    expect(message.selectionEnd).toBe(4);
  });

  it("sends with Enter, keeps Shift+Enter for newlines, and exposes Stop while streaming", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => true);
    const onStop = vi.fn();
    const { rerender, props } = renderComposer({ draft: "Reply", isSending: true, onSend, onStop });

    await user.click(screen.getByRole("button", { name: "Stop response" }));
    expect(onStop).toHaveBeenCalledOnce();

    rerender(
      <ChatComposer {...props} draft="Reply" isSending={false} onSend={onSend} onStop={onStop} />,
    );
    const draft = screen.getByLabelText("Message");
    await user.click(draft);
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onSend).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("Reply");
  });

  it("passes only the chosen File to the attachment callback and explains unsupported attachments", async () => {
    const user = userEvent.setup();
    const onFileSelected = vi.fn();
    renderComposer({
      attachment: { kind: "unavailable", reason: "The selected model cannot accept attachments." },
      onFileSelected,
    });

    expect(screen.getByRole("button", { name: "Add attachment" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "The selected model cannot accept attachments.",
    );

    const file = new File(["image"], "diagram.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Choose attachment file"), file);
    expect(onFileSelected).not.toHaveBeenCalled();
  });

  it("forwards the selected File without reading or exposing a file path", async () => {
    const user = userEvent.setup();
    const onFileSelected = vi.fn();
    renderComposer({ onFileSelected });

    const file = new File(["image"], "diagram.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Choose attachment file"), file);

    expect(onFileSelected).toHaveBeenCalledWith(file);
    expect(onFileSelected.mock.calls[0]).toHaveLength(1);
  });

  it("reports resolved research routing and exposes provider and model controls through callbacks", async () => {
    const user = userEvent.setup();
    const onProviderChange = vi.fn();
    const onModelChange = vi.fn();
    const onResearchEnabledChange = vi.fn();
    const onResearchRoutingChange = vi.fn();
    renderComposer({
      model: {
        options: [
          { id: "model-a", label: "Model A" },
          { id: "model-b", label: "Model B" },
        ],
        value: "model-a",
      },
      onModelChange,
      onProviderChange,
      onResearchEnabledChange,
      onResearchRoutingChange,
      provider: {
        options: [
          { id: "provider-a", label: "Provider A" },
          { id: "provider-b", label: "Provider B" },
        ],
        value: "provider-a",
      },
      research: {
        backend: { kind: "unavailable", reason: "SearXNG is not configured." },
        enabled: true,
        routing: "searxng",
      },
    });

    await user.click(screen.getByRole("combobox", { name: "Provider" }));
    await user.click(await screen.findByRole("option", { name: "Provider B" }));
    await user.click(screen.getByRole("combobox", { name: "Model" }));
    await user.click(await screen.findByRole("option", { name: "Model B" }));
    await user.click(screen.getByRole("button", { name: "Disable web research" }));
    await user.click(screen.getByRole("combobox", { name: "Research routing" }));
    await user.click(await screen.findByRole("option", { name: "Provider-native" }));

    expect(onProviderChange).toHaveBeenCalledWith("provider-b");
    expect(onModelChange).toHaveBeenCalledWith("model-b");
    expect(onResearchEnabledChange).toHaveBeenCalledWith(false);
    expect(onResearchRoutingChange).toHaveBeenCalledWith("provider-native");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Research unavailable: SearXNG is not configured.",
    );
  });

  it("offers one select per declared model option with Default first and reports changes", async () => {
    const user = userEvent.setup();
    const onModelOptionChange = vi.fn();
    const { rerender, props } = renderComposer({
      modelOptions: [
        { id: "effort", displayName: "Effort", values: ["low", "high"], value: "high" },
        { id: "service-tier", displayName: "Service tier", values: ["fast"] },
      ],
      onModelOptionChange,
    });

    expect(screen.getByRole("combobox", { name: "Effort" })).toHaveTextContent("Effort: high");
    expect(screen.getByRole("combobox", { name: "Service tier" })).toHaveTextContent(
      "Service tier: Default",
    );

    await user.click(screen.getByRole("combobox", { name: "Effort" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "Effort: Default",
      "Effort: low",
      "Effort: high",
    ]);
    await user.click(screen.getByRole("option", { name: "Effort: Default" }));
    expect(onModelOptionChange).toHaveBeenCalledWith("effort", undefined);

    await user.click(screen.getByRole("combobox", { name: "Service tier" }));
    await user.click(await screen.findByRole("option", { name: "Service tier: fast" }));
    expect(onModelOptionChange).toHaveBeenCalledWith("service-tier", "fast");

    rerender(<ChatComposer {...props} modelOptions={[]} />);
    expect(screen.queryByRole("combobox", { name: "Effort" })).toBeNull();
    rerender(<ChatComposer {...props} isSending />);
    expect(screen.getByRole("combobox", { name: "Effort" })).toBeDisabled();
  });

  it("makes disabled reasons available without relying on color", async () => {
    renderComposer({
      draft: "Can I send?",
      sendDisabledReason: "Choose an available provider before sending.",
    });

    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Choose an available provider before sending.",
    );
  });

  it("lists pending preview selections and removes one through its explicit control", async () => {
    const user = userEvent.setup();
    const onRemovePreviewSelection = vi.fn();
    const selectionId = decodePreviewContextSelectionId("11111111-2222-4333-8444-555555555555");
    const targetId = decodePreviewTargetId("22222222-3333-4444-8555-666666666666");
    renderComposer({
      draft: "Summarize the report",
      pendingPreviewSelections: [
        {
          id: selectionId,
          displayName: "report.pdf",
          selection: {
            kind: "pdf",
            targetId,
            sourceVersion: {
              contentSha256: decodeContentSha256(
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
              ),
              byteSize: 1024,
              observedAt: "2026-07-22T00:00:00.000Z" as never,
            },
            page: 1,
          },
        },
      ],
      onRemovePreviewSelection,
    });

    const list = screen.getByRole("list", { name: "Attached preview selections" });
    expect(list).toBeVisible();
    expect(list).toHaveTextContent("report.pdf");
    await user.click(screen.getByRole("button", { name: "Remove report.pdf selection" }));
    expect(onRemovePreviewSelection).toHaveBeenCalledWith(selectionId);
  });

  it("renders compact accessible extension receipts and supports keyboard removal", async () => {
    const user = userEvent.setup();
    const onRemoveExtensionSelection = vi.fn();
    const selection = {
      kind: "plugin" as const,
      extensionId: "30000000-0000-4000-8000-000000000001" as never,
      packageId: "31000000-0000-4000-8000-000000000001" as never,
      componentId: "instructions" as never,
      packageVersion: "1.2.3" as never,
      packageDigest: `sha256:${"a".repeat(64)}` as never,
      catalogEpoch: `sha256:${"c".repeat(64)}` as never,
      origin: { kind: "draft" as const, reference: "draft-1" },
    };
    renderComposer({
      draft: "Build the project",
      pendingExtensionSelections: [
        {
          reference: "@build-tools",
          label: "Build guidance",
          selection,
          status: { kind: "selected" },
        },
      ],
      onRemoveExtensionSelection,
    });

    const list = screen.getByRole("list", { name: "Selected extensions" });
    expect(list).toHaveTextContent("Build guidance");
    expect(list).toHaveTextContent("Selection verified");
    const remove = screen.getByRole("button", { name: "Remove Build guidance extension" });
    remove.focus();
    await user.keyboard("{Enter}");
    expect(onRemoveExtensionSelection).toHaveBeenCalledWith("@build-tools");
  });
});

/**
 * A caller-owned draft, exactly as the workspace owns it in production, so the
 * `/` affordance is exercised through real typing rather than rerenders.
 */
function SlashHarness(props: {
  readonly commands: ReadonlyArray<OctantCommand>;
  readonly onDraftChange?: (draft: string) => void;
  readonly onResolveExtensionReference?: (draft: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  return (
    <OctantCommandProvider commands={props.commands}>
      <ChatComposer
        draft={draft}
        isSending={false}
        model={{ options: [{ id: "model-a", label: "Model A" }], value: "model-a" }}
        onDraftChange={(next) => {
          setDraft(next);
          props.onDraftChange?.(next);
        }}
        onFileSelected={vi.fn()}
        onModelChange={vi.fn()}
        onProviderChange={vi.fn()}
        onResearchEnabledChange={vi.fn()}
        onResearchRoutingChange={vi.fn()}
        onSend={vi.fn(async () => true)}
        provider={{ options: [{ id: "provider-a", label: "Provider A" }], value: "provider-a" }}
        research={{ backend: { kind: "disabled" }, enabled: false, routing: "automatic" }}
        {...(props.onResolveExtensionReference === undefined
          ? {}
          : { onResolveExtensionReference: props.onResolveExtensionReference })}
      />
    </OctantCommandProvider>
  );
}

describe("ChatComposer slash commands", () => {
  const newChat = vi.fn();
  const skillReference = `$bundled:writing:sha256:${"a".repeat(64)}`;

  function hostCommands(): ReadonlyArray<OctantCommand> {
    return [
      {
        id: "thread:new:chat",
        title: "New chat",
        group: "Threads",
        action: { kind: "run", run: newChat },
      },
      {
        id: "skill:writing",
        title: "Writing review",
        group: "Skills",
        detail: "Skill",
        action: { kind: "address", reference: skillReference },
      },
    ];
  }

  beforeEach(() => vi.clearAllMocks());

  it("offers no slash affordance when this host published no commands", async () => {
    const user = userEvent.setup();
    render(<SlashHarness commands={[]} />);

    const draft = screen.getByLabelText("Message");
    await user.type(draft, "/");

    expect(draft).not.toHaveAttribute("aria-expanded");
    expect(screen.queryByRole("listbox", { name: "Commands you can run" })).not.toBeInTheDocument();
  });

  it("filters host commands from a leading slash and runs one by keyboard alone", async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn();
    render(<SlashHarness commands={hostCommands()} onDraftChange={onDraftChange} />);

    const draft = screen.getByLabelText("Message");
    await user.type(draft, "/new");

    const list = screen.getByRole("listbox", { name: "Commands you can run" });
    const option = within(list).getByRole("option", { name: /New chat/ });
    expect(option).toHaveAttribute("aria-selected", "true");
    expect(draft).toHaveAttribute("aria-expanded", "true");
    expect(draft).toHaveAttribute("aria-controls", list.id);
    expect(draft).toHaveAttribute("aria-activedescendant", option.id);
    // The skill is withheld: this composer was given no host resolution path.
    expect(within(list).queryByRole("option", { name: /Writing review/ })).not.toBeInTheDocument();

    await user.keyboard("{Enter}");

    expect(newChat).toHaveBeenCalledOnce();
    expect(onDraftChange).toHaveBeenLastCalledWith("");
    expect(screen.getByLabelText("Message")).toHaveValue("");
  });

  it("closes on Escape without running anything and keeps the draft as ordinary text", async () => {
    const user = userEvent.setup();
    render(<SlashHarness commands={hostCommands()} />);

    const draft = screen.getByLabelText("Message");
    await user.type(draft, "/new");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox", { name: "Commands you can run" })).not.toBeInTheDocument();
    expect(newChat).not.toHaveBeenCalled();
    expect(draft).toHaveValue("/new");
  });

  it("hands a chosen skill to the host resolution path instead of resolving it itself", async () => {
    const user = userEvent.setup();
    const onResolveExtensionReference = vi.fn(async () => true);
    render(
      <SlashHarness
        commands={hostCommands()}
        onResolveExtensionReference={onResolveExtensionReference}
      />,
    );

    const draft = screen.getByLabelText("Message");
    await user.type(draft, "/writ");
    const list = screen.getByRole("listbox", { name: "Commands you can run" });
    await user.click(within(list).getByRole("option", { name: /Writing review/ }));

    expect(onResolveExtensionReference).toHaveBeenCalledWith(skillReference);
    expect(screen.getByLabelText("Message")).toHaveValue("");
  });
});
