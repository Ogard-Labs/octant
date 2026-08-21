import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ThreadMentionCandidate } from "@octant/contracts";
import {
  ChatComposer,
  type ChatComposerProps,
  type ChatComposerThreadMentions,
} from "./ChatComposer";

/**
 * Composer coverage for the `#thread` typeahead and image paste.
 * Kept beside the original ChatComposer suite rather than inside it so the two
 * new surfaces have their own readable harness.
 */
function renderComposer(overrides: Partial<ChatComposerProps> = {}) {
  const props: ChatComposerProps = {
    draft: "",
    isSending: false,
    model: { options: [{ id: "model-a", label: "Model A" }], value: "model-a" },
    onDraftChange: vi.fn(),
    onFileSelected: vi.fn(),
    onModelChange: vi.fn(),
    onProviderChange: vi.fn(),
    onResearchEnabledChange: vi.fn(),
    onResearchRoutingChange: vi.fn(),
    onSend: vi.fn(async () => true),
    provider: { options: [{ id: "provider-a", label: "Provider A" }], value: "provider-a" },
    research: { backend: { kind: "disabled" }, enabled: false, routing: "automatic" },
    ...overrides,
  };
  return { props, ...render(<ChatComposer {...props} />) };
}

/** The draft is caller-owned, so typing needs a caller that actually keeps it. */
function ControlledComposer(props: Omit<ChatComposerProps, "draft" | "onDraftChange">) {
  const [draft, setDraft] = useState("");
  return <ChatComposer {...props} draft={draft} onDraftChange={setDraft} />;
}

function renderControlled(overrides: Partial<ChatComposerProps> = {}) {
  const {
    draft: _draft,
    onDraftChange: _onDraftChange,
    ...rest
  } = {
    isSending: false,
    model: { options: [{ id: "model-a", label: "Model A" }], value: "model-a" },
    onFileSelected: vi.fn(),
    onModelChange: vi.fn(),
    onProviderChange: vi.fn(),
    onResearchEnabledChange: vi.fn(),
    onResearchRoutingChange: vi.fn(),
    onSend: vi.fn(async () => true),
    provider: { options: [{ id: "provider-a", label: "Provider A" }], value: "provider-a" },
    research: {
      backend: { kind: "disabled" as const },
      enabled: false,
      routing: "automatic" as const,
    },
    ...overrides,
  } as ChatComposerProps;
  return render(<ControlledComposer {...rest} />);
}

function candidate(title: string, overrides: Partial<ThreadMentionCandidate> = {}) {
  return {
    threadId: `thread-${title.toLowerCase().replace(/\s+/g, "-")}`,
    mode: "chat",
    title,
    placement: { kind: "unfiled" },
    updatedAt: "2026-08-14T10:00:00.000Z",
    ...overrides,
  } as ThreadMentionCandidate;
}

function mentions(overrides: Partial<ChatComposerThreadMentions> = {}): ChatComposerThreadMentions {
  return {
    candidates: [],
    chips: [],
    onQueryChange: vi.fn(),
    onSelectCandidate: vi.fn(),
    onRemoveChip: vi.fn(),
    ...overrides,
  };
}

function imageFile(name = "shot.png", type = "image/png", bytes = 64): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function pasteImage(target: HTMLElement, files: ReadonlyArray<File>) {
  const clipboardData = {
    files,
    items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
    types: files.length > 0 ? ["Files"] : ["text/plain"],
    getData: () => "",
  };
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: clipboardData });
  target.dispatchEvent(event);
  return event;
}

describe("ChatComposer thread mentions", () => {
  it("opens a typeahead of openable threads when # is typed", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    renderControlled({
      threadMentions: mentions({ candidates: [candidate("Release notes")], onQueryChange }),
    });

    const message = screen.getByLabelText("Message");
    await user.click(message);
    await user.type(message, "look at #rel");

    expect(onQueryChange).toHaveBeenLastCalledWith("rel");
    expect(screen.getByRole("listbox", { name: "Threads you can mention" })).toBeVisible();
    expect(message).toHaveAttribute("aria-expanded", "true");
  });

  it("closes the typeahead on Escape without touching the draft", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    renderControlled({
      threadMentions: mentions({ candidates: [candidate("Release notes")], onQueryChange }),
    });

    const message = screen.getByLabelText("Message");
    await user.click(message);
    await user.type(message, "#rel");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(message).toHaveValue("#rel");
    expect(onQueryChange).toHaveBeenLastCalledWith(undefined);
  });

  it("shows each hit with its mode and placement in words", async () => {
    const user = userEvent.setup();
    renderComposer({
      draft: "#rel",
      threadMentions: mentions({
        candidates: [
          candidate("Release notes", {
            mode: "work",
            placement: { kind: "project", label: "Launch" },
          }),
        ],
      }),
    });

    await user.click(screen.getByLabelText("Message"));

    const listbox = screen.getByRole("listbox", { name: "Threads you can mention" });
    const option = within(listbox).getByRole("option");
    expect(option).toHaveTextContent("Release notes");
    expect(option).toHaveTextContent("Work");
    expect(option).toHaveTextContent("Launch");
    expect(option).toHaveAttribute("aria-selected", "true");
  });

  it("inserts a chip on Enter and tells the caller which thread was chosen", async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn();
    const onSelectCandidate = vi.fn();
    const hit = candidate("Release notes");
    renderComposer({
      draft: "look at #rel",
      onDraftChange,
      threadMentions: mentions({ candidates: [hit], onSelectCandidate }),
    });

    const message = screen.getByLabelText("Message");
    message.focus();
    (message as HTMLTextAreaElement).setSelectionRange(12, 12);
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(onDraftChange).toHaveBeenCalledWith("look at #[Release notes] ", 25);
    expect(onSelectCandidate).toHaveBeenCalledWith(hit);
  });

  it("keeps Enter as send when no typeahead is open", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => true);
    renderComposer({ draft: "plain message", onSend, threadMentions: mentions() });

    const message = screen.getByLabelText("Message");
    message.focus();
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("plain message");
  });

  it("leaves unmatched #text as ordinary text with an honest empty state", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => true);
    renderComposer({ draft: "#nothing", onSend, threadMentions: mentions({ candidates: [] }) });

    const message = screen.getByLabelText("Message");
    message.focus();
    (message as HTMLTextAreaElement).setSelectionRange(8, 8);
    await user.keyboard("{ArrowLeft}{ArrowRight}");

    expect(
      screen.getByText("No matching thread you can open. Leaving this as ordinary text."),
    ).toBeVisible();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("#nothing");
  });

  it("renders a chip as a read-only receipt with a removable control", async () => {
    const user = userEvent.setup();
    const onRemoveChip = vi.fn();
    renderComposer({
      draft: "#[Release notes] ",
      threadMentions: mentions({
        chips: [
          {
            threadId: "thread-1" as never,
            title: "Release notes",
            mode: "work",
            placementLabel: "Launch",
          },
        ],
        onRemoveChip,
      }),
    });

    const list = screen.getByRole("list", { name: "Mentioned threads" });
    expect(list).toHaveTextContent("Work · Launch · Read-only");
    const remove = screen.getByRole("button", { name: "Remove Release notes thread mention" });
    remove.focus();
    await user.keyboard("{Enter}");

    expect(onRemoveChip).toHaveBeenCalledWith("thread-1");
  });

  it("shows an unavailable chip without a Side Chat affordance", () => {
    renderComposer({
      draft: "#[Secret] ",
      threadMentions: mentions({
        chips: [
          {
            threadId: "thread-2" as never,
            title: "Secret",
            mode: "chat",
            placementLabel: "Unfiled",
            unavailableReason: "You cannot open this thread.",
          },
        ],
        onOpenSideChat: vi.fn(),
      }),
    });

    expect(screen.getByRole("list", { name: "Mentioned threads" })).toHaveTextContent(
      "Unavailable: You cannot open this thread.",
    );
    expect(screen.getByRole("button", { name: "Open Side Chat about Secret" })).toBeDisabled();
  });

  it("offers to reopen an existing Side Chat sidecar from a chip", async () => {
    const user = userEvent.setup();
    const onOpenSideChat = vi.fn();
    renderComposer({
      draft: "#[Release notes] ",
      threadMentions: mentions({
        chips: [
          {
            threadId: "thread-1" as never,
            title: "Release notes",
            mode: "chat",
            placementLabel: "Unfiled",
            hasSideChat: true,
          },
        ],
        onOpenSideChat,
      }),
    });

    await user.click(screen.getByRole("button", { name: "Open Side Chat about Release notes" }));

    expect(onOpenSideChat).toHaveBeenCalledWith("thread-1");
    expect(
      screen.getByRole("button", { name: "Open Side Chat about Release notes" }),
    ).toHaveTextContent("Reopen Side Chat");
  });
});

describe("ChatComposer @file absence", () => {
  it("does not offer a file mention picker, because Chat has no filesystem authority", async () => {
    const user = userEvent.setup();
    renderControlled();

    const message = screen.getByLabelText("Message");
    await user.click(message);
    await user.type(message, "look at @src");

    expect(
      screen.queryByRole("listbox", { name: "Files you can mention" }),
    ).not.toBeInTheDocument();
  });
});

describe("ChatComposer image paste", () => {
  it("turns a pasted PNG into a pending attachment through the ordinary file path", () => {
    const onFileSelected = vi.fn();
    renderComposer({ onFileSelected, imageAttachment: { kind: "supported" } });

    const file = imageFile();
    const event = pasteImage(screen.getByLabelText("Message"), [file]);

    expect(onFileSelected).toHaveBeenCalledWith(file);
    expect(event.defaultPrevented).toBe(true);
  });

  it("accepts every image type Chat allows", () => {
    const onFileSelected = vi.fn();
    renderComposer({ onFileSelected, imageAttachment: { kind: "supported" } });

    pasteImage(screen.getByLabelText("Message"), [
      imageFile("a.png", "image/png"),
      imageFile("b.jpg", "image/jpeg"),
      imageFile("c.webp", "image/webp"),
      imageFile("d.gif", "image/gif"),
    ]);

    expect(onFileSelected).toHaveBeenCalledTimes(4);
  });

  it("does not read image bytes when the provider cannot accept images", () => {
    const onFileSelected = vi.fn();
    const onImagePasteRejected = vi.fn();
    renderComposer({
      onFileSelected,
      onImagePasteRejected,
      imageAttachment: {
        kind: "unavailable",
        reason: "The selected model does not accept images. Choose an image-capable model.",
      },
    });

    pasteImage(screen.getByLabelText("Message"), [imageFile()]);

    expect(onFileSelected).not.toHaveBeenCalled();
    expect(onImagePasteRejected).toHaveBeenCalledWith(
      "The selected model does not accept images. Choose an image-capable model.",
    );
  });

  it("states the unavailable reason in the composer status", () => {
    renderComposer({
      attachment: { kind: "supported" },
      imageAttachment: { kind: "unavailable", reason: "Images are unavailable here." },
    });

    const statuses = screen.getAllByRole("status");
    expect(statuses[statuses.length - 1]).toHaveTextContent("Images are unavailable here.");
  });

  it("leaves an ordinary text paste to the browser", () => {
    const onFileSelected = vi.fn();
    renderComposer({ onFileSelected, imageAttachment: { kind: "supported" } });

    const event = pasteImage(screen.getByLabelText("Message"), []);

    expect(onFileSelected).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("reports an out-of-bounds image instead of attaching it", () => {
    const onFileSelected = vi.fn();
    const onImagePasteRejected = vi.fn();
    renderComposer({
      onFileSelected,
      onImagePasteRejected,
      imageAttachment: { kind: "supported" },
    });

    pasteImage(screen.getByLabelText("Message"), [imageFile("vector.svg", "image/svg+xml")]);

    expect(onFileSelected).not.toHaveBeenCalled();
    expect(onImagePasteRejected).toHaveBeenCalledWith(
      "vector.svg: image/svg+xml images cannot be attached.",
    );
  });

  it("does not paste while a response is streaming", () => {
    const onFileSelected = vi.fn();
    renderComposer({ onFileSelected, imageAttachment: { kind: "supported" }, isSending: true });

    pasteImage(screen.getByLabelText("Message"), [imageFile()]);

    expect(onFileSelected).not.toHaveBeenCalled();
  });
});
