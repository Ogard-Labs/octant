import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComposerInputElement } from "../composer/ComposerInput";
import { useThreadMentions } from "./useThreadMentions";
import { ThreadReferencesContext } from "../threadReferences/ThreadReferences";
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

  it("shows a listed thread's Project, state and model beside its hit", async () => {
    const user = userEvent.setup();
    render(
      <ThreadReferencesContext.Provider
        value={{
          find: () => ({
            mode: "code",
            projectName: "octant",
            thread: {
              threadId: "thread-release-notes",
              title: "Release notes",
              projectId: "project-1",
              activity: "attention",
              awaitingKind: "approval",
              provider: { displayName: "Claude", driverKind: "claude" },
              modelId: "claude-opus-5-5",
            },
          }),
        }}
      >
        <ControlledComposer
          isSending={false}
          model={{ options: [{ id: "model-a", label: "Model A" }], value: "model-a" }}
          onFileSelected={vi.fn()}
          onModelChange={vi.fn()}
          onProviderChange={vi.fn()}
          onResearchEnabledChange={vi.fn()}
          onResearchRoutingChange={vi.fn()}
          onSend={vi.fn(async () => true)}
          provider={{ options: [{ id: "provider-a", label: "Provider A" }], value: "provider-a" }}
          research={{ backend: { kind: "disabled" }, enabled: false, routing: "automatic" }}
          threadMentions={mentions({
            candidates: [
              candidate("Release notes", {
                mode: "code",
                placement: { kind: "project", label: "octant" },
              }),
            ],
          })}
        />
      </ThreadReferencesContext.Provider>,
    );

    await user.type(screen.getByLabelText("Message"), "#rel");

    const option = await screen.findByRole("option", { name: /Release notes/ });
    // The row's marks load with the list, so the host's words show first.
    await waitFor(() => expect(option).toHaveTextContent("Needs you"));
    expect(option).toHaveTextContent("Opus 5.5");
    expect(option).toHaveTextContent("Code · octant");
    expect(option.querySelector(".project-mark, .project-icon")).not.toBeNull();
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

    // A click lands the caret where it points; the simulated click puts it at
    // the start, so End brings it to the end of `#rel` as a click there would.
    await user.click(screen.getByLabelText("Message"));
    await user.keyboard("{End}");

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

    expect(screen.getByText("No thread you can open matches. Kept as plain text.")).toBeVisible();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("#nothing");
  });

  it("shows a mention as one inline chip whose card says it is read-only and removes it with its text", async () => {
    const user = userEvent.setup();
    const onRemoveChip = vi.fn();
    const onDraftChange = vi.fn();
    renderComposer({
      draft: "See #[Release notes] first",
      onDraftChange,
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

    const chip = await screen.findByRole("button", {
      name: "Thread: Release notes, Work, Launch, Read-only",
    });
    expect(screen.getByRole("textbox", { name: "Message" })).toContainElement(chip);
    expect(screen.getByRole("textbox", { name: "Message" })).not.toHaveTextContent("#[");
    chip.focus();
    await user.keyboard("{Enter}");
    const card = await screen.findByRole("dialog", { name: "Thread details" });
    expect(card).toHaveTextContent("This turn reads up to its last 12 messages, read-only.");
    await user.click(within(card).getByRole("button", { name: "Remove" }));

    expect(onRemoveChip).toHaveBeenCalledWith("thread-1");
    expect(onDraftChange).toHaveBeenLastCalledWith("See first", 4);
  });

  it("keeps and sends the thread that was not cut when two share a title side by side", async () => {
    const roadmap = (threadId: string) => ({
      threadId: threadId as never,
      title: "Roadmap",
      mode: "chat" as const,
      placementLabel: "Recents",
    });
    // Held outside the component: a client made on each render restarts the search.
    const client = {
      search: vi.fn(),
      searchThread: vi.fn(),
      resolve: vi.fn(async () => ({ mentions: [], unavailable: [] })),
    } as never;
    let send: (() => Promise<ReadonlyArray<unknown>>) | undefined;
    function Mentions() {
      const [draft, setDraft] = useState("#[Roadmap] #[Roadmap]");
      const threadMentions = useThreadMentions({
        client,
        draft,
        initialChips: [roadmap("thread-a"), roadmap("thread-b")],
      });
      send = threadMentions.resolveForSend;
      return (
        <ChatComposer
          draft={draft}
          isSending={false}
          model={{ options: [{ id: "model-a", label: "Model A" }], value: "model-a" }}
          onDraftChange={setDraft}
          onFileSelected={vi.fn()}
          onModelChange={vi.fn()}
          onProviderChange={vi.fn()}
          onResearchEnabledChange={vi.fn()}
          onResearchRoutingChange={vi.fn()}
          onSend={vi.fn(async () => true)}
          provider={{ options: [{ id: "provider-a", label: "Provider A" }], value: "provider-a" }}
          research={{ backend: { kind: "disabled" }, enabled: false, routing: "automatic" }}
          {...(threadMentions.composer === undefined
            ? {}
            : { threadMentions: threadMentions.composer })}
        />
      );
    }
    render(<Mentions />);
    const message = screen.getByRole<ComposerInputElement>("textbox", { name: "Message" });
    message.focus();
    message.setSelectionRange(0, 11);

    fireEvent.cut(message, { clipboardData: { setData: vi.fn() } });

    await waitFor(() => expect(message).toHaveValue("#[Roadmap]"));
    let sent: ReadonlyArray<unknown> | undefined;
    await act(async () => {
      sent = await send?.();
    });
    expect(sent).toEqual(["thread-b"]);
  });

  it("labels an explicitly mentioned Chat as able to receive a message", async () => {
    renderComposer({
      draft: "#[Target Chat] ",
      threadMentions: mentions({
        dialogueEnabled: true,
        chips: [
          {
            threadId: "thread-chat" as never,
            title: "Target Chat",
            mode: "chat",
            placementLabel: "Recents",
          },
        ],
      }),
    });

    expect(
      await screen.findByRole("button", {
        name: "Thread: Target Chat, Chat, Recents, Can receive a message",
      }),
    ).toBeVisible();
  });

  it("shows why a chip is unavailable and no fact about its thread", async () => {
    const user = userEvent.setup();
    renderComposer({
      draft: "#[Secret] ",
      threadMentions: mentions({
        chips: [
          {
            threadId: "thread-2" as never,
            title: "Secret",
            mode: "chat",
            placementLabel: "Unfiled",
            unavailableReason: "you cannot open this thread",
          },
        ],
        onOpenSideChat: vi.fn(),
      }),
    });

    await user.click(
      await screen.findByRole("button", {
        name: "Thread: Secret, Unavailable: you cannot open this thread",
      }),
    );
    const card = await screen.findByRole("dialog", { name: "Thread details" });
    expect(card).toHaveTextContent(
      "Unavailable: you cannot open this thread. Nothing from it is included.",
    );
    expect(card).not.toHaveTextContent("Unfiled");
    expect(within(card).getByRole("button", { name: "Side Chat" })).toBeDisabled();
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

    await user.click(await screen.findByRole("button", { name: /^Thread: Release notes/ }));
    await user.click(await screen.findByRole("button", { name: "Reopen Side Chat" }));

    expect(onOpenSideChat).toHaveBeenCalledWith("thread-1");
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
        reason: "This model cannot read images. Pick one that can.",
      },
    });

    pasteImage(screen.getByLabelText("Message"), [imageFile()]);

    expect(onFileSelected).not.toHaveBeenCalled();
    expect(onImagePasteRejected).toHaveBeenCalledWith(
      "This model cannot read images. Pick one that can.",
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

  it("puts an ordinary text paste into the message as plain text", () => {
    const onFileSelected = vi.fn();
    const { props } = renderComposer({ onFileSelected, imageAttachment: { kind: "supported" } });

    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        items: [],
        types: ["text/plain"],
        getData: (type: string) => (type === "text/plain" ? "plain words" : ""),
      },
    });
    act(() => {
      screen.getByLabelText("Message").dispatchEvent(event);
    });

    expect(onFileSelected).not.toHaveBeenCalled();
    expect(props.onDraftChange).toHaveBeenCalledWith("plain words");
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

  it("pastes an image onto a message queued while a response is streaming", () => {
    const onFileSelected = vi.fn();
    renderComposer({ onFileSelected, imageAttachment: { kind: "supported" }, isSending: true });

    pasteImage(screen.getByLabelText("Message"), [imageFile()]);

    expect(onFileSelected).toHaveBeenCalledOnce();
  });
});
