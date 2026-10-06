import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ThreadMentionClient } from "@octant/client-runtime";
import type { ThreadMentionCandidate } from "@octant/contracts";
import { decodeWorkspaceTabId } from "@octant/contracts/shell";
import { ThreadComposer } from "../composer/ThreadComposer";
import { ProjectThreadRows } from "../projects/ProjectThreadList";
import { WorkspaceDragStatus } from "../shell/WorkspaceDropOverlay";
import type { WorkspaceSurfaceDragState } from "../shell/useWorkspaceTabDrag";
import { resetComposerThreadDropStore, setActiveComposerThreadDropKey } from "./composerThreadDrop";
import { useThreadMentions } from "./useThreadMentions";

const requestId = "00000000-0000-4000-8000-000000000091" as never;

function candidate(overrides: Partial<ThreadMentionCandidate> = {}): ThreadMentionCandidate {
  return {
    threadId: "thread-notes",
    mode: "work",
    title: "Release notes",
    placement: { kind: "project", label: "Launch" },
    updatedAt: "2026-08-14T10:00:00.000Z",
    ...overrides,
  } as ThreadMentionCandidate;
}

function stubClient(overrides: Partial<ThreadMentionClient> = {}): ThreadMentionClient {
  return {
    search: vi.fn().mockResolvedValue([candidate()]),
    resolve: vi.fn().mockResolvedValue({ mentions: [], unavailable: [] }),
    openSideChat: vi.fn(),
    execute: vi.fn(),
    ...overrides,
  } as ThreadMentionClient;
}

function DropHarness(props: {
  readonly client: ThreadMentionClient;
  readonly currentThreadId?: string;
  readonly initialDraft?: string;
}) {
  const [draft, setDraft] = useState(props.initialDraft ?? "Keep this draft");
  const mentions = useThreadMentions({
    client: props.client,
    draft,
    requestId: () => requestId,
  });
  return (
    <div>
      <output aria-label="draft">{draft}</output>
      <output aria-label="chips">{mentions.chips.map((chip) => chip.title).join(",")}</output>
      <output aria-label="status">{mentions.composer?.statusMessage ?? "none"}</output>
      <button
        onClick={() =>
          void mentions.attachDroppedThread({
            threadId: "thread-notes",
            searchHint: "Release notes",
            onDraftChange: setDraft,
            ...(props.currentThreadId === undefined
              ? {}
              : { currentThreadId: props.currentThreadId }),
          })
        }
        type="button"
      >
        attach notes
      </button>
      <button
        onClick={() =>
          void mentions.attachDroppedThread({
            threadId: "thread-secret",
            searchHint: "Secret transcript body",
            onDraftChange: setDraft,
          })
        }
        type="button"
      >
        attach missing
      </button>
      <button
        onClick={() =>
          void mentions.attachDroppedThread({
            threadId: "",
            onDraftChange: setDraft,
          })
        }
        type="button"
      >
        attach empty
      </button>
    </div>
  );
}

const thread = {
  threadId: "thread-one",
  title: "Controller foundation",
  provider: { displayName: "Claude", driverKind: "claude" },
} as const;

describe("attaching a sidebar thread as composer context", () => {
  it("inserts the host chip without sending or reading the transcript", async () => {
    const user = userEvent.setup();
    const client = stubClient();
    render(<DropHarness client={client} />);

    await user.click(screen.getByRole("button", { name: "attach notes" }));

    await waitFor(() =>
      expect(screen.getByLabelText("draft")).toHaveTextContent("Keep this draft #[Release notes]"),
    );
    expect(screen.getByLabelText("chips")).toHaveTextContent("Release notes");
    expect(screen.getByLabelText("status")).toHaveTextContent("not sent");
    expect(client.resolve).not.toHaveBeenCalled();
    expect(client.search).toHaveBeenCalledWith(requestId, "Release notes");
  });

  it("keeps the draft when the host will not offer the thread", async () => {
    const user = userEvent.setup();
    const client = stubClient();
    render(<DropHarness client={client} initialDraft="Do not lose this" />);

    await user.click(screen.getByRole("button", { name: "attach missing" }));

    await waitFor(() =>
      expect(screen.getByLabelText("status")).toHaveTextContent("cannot be mentioned"),
    );
    expect(screen.getByLabelText("draft")).toHaveTextContent("Do not lose this");
    expect(screen.getByLabelText("draft")).not.toHaveTextContent("Secret");
    expect(screen.getByLabelText("chips")).toHaveTextContent("");
    expect(client.resolve).not.toHaveBeenCalled();
  });

  it("refuses the composer's own thread and a non-thread without asking the host", async () => {
    const user = userEvent.setup();
    const client = stubClient();
    render(<DropHarness client={client} currentThreadId="thread-notes" />);

    await user.click(screen.getByRole("button", { name: "attach notes" }));
    await waitFor(() =>
      expect(screen.getByLabelText("status")).toHaveTextContent("already that thread"),
    );
    expect(client.search).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "attach empty" }));
    await waitFor(() => expect(screen.getByLabelText("status")).toHaveTextContent("not a thread"));
    expect(screen.getByLabelText("draft")).toHaveTextContent("Keep this draft");
    expect(client.search).not.toHaveBeenCalled();
  });

  it("does not add a second chip when the thread is already attached", async () => {
    const user = userEvent.setup();
    const client = stubClient();
    render(<DropHarness client={client} />);

    await user.click(screen.getByRole("button", { name: "attach notes" }));
    await waitFor(() => expect(screen.getByLabelText("chips")).toHaveTextContent("Release notes"));
    await user.click(screen.getByRole("button", { name: "attach notes" }));
    await waitFor(() =>
      expect(screen.getByLabelText("status")).toHaveTextContent("already attached"),
    );
    expect(screen.getByLabelText("draft").textContent?.match(/#\[Release notes\]/g)).toHaveLength(
      1,
    );
  });
});

describe("composer thread drop target", () => {
  it("shows a text cue while a thread is over the composer", () => {
    resetComposerThreadDropStore();
    setActiveComposerThreadDropKey("composer-1");
    render(
      <ThreadComposer
        ariaLabel="Chat composer"
        input={<textarea aria-label="Message" className="composer-input" defaultValue="Draft" />}
        row={{ actions: { kind: "send", send: { ariaLabel: "Send", onSend: vi.fn() } } }}
        threadDropKey="composer-1"
      />,
    );

    expect(screen.getByText("Attach as context")).toBeVisible();
    expect(screen.getByLabelText("Chat composer")).toHaveAttribute("data-drop-target", "true");
    expect(screen.getByLabelText("Message")).toHaveValue("Draft");
    act(() => setActiveComposerThreadDropKey(undefined));
  });

  it("announces an attach without saying the pane will open", () => {
    const drag: WorkspaceSurfaceDragState = {
      destination: { kind: "composer", composerKey: "composer-1" },
      point: { x: 10, y: 10 },
      source: {
        dragKey: "thread:row-1",
        surface: {
          kind: "welcome",
          id: decodeWorkspaceTabId("00000000-0000-4000-8000-000000001103"),
          mode: "chat",
          title: "Release notes",
        },
        title: "Release notes",
      },
    };
    render(<WorkspaceDragStatus drag={drag} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Attach Release notes as context. The draft will not be sent.",
    );
    expect(screen.getByRole("status")).not.toHaveTextContent("Open");
  });
});

describe("keyboard attach from a thread row", () => {
  it("offers Attach as context on the row menu and does not open the thread", async () => {
    const user = userEvent.setup();
    const onAttachAsContext = vi.fn();
    const onSelectThread = vi.fn();
    render(
      <ProjectThreadRows
        actions={{ onAttachAsContext }}
        onSelectThread={onSelectThread}
        threads={[thread]}
      />,
    );

    const row = screen.getByRole("button", { name: /Controller foundation/ });
    row.focus();
    await user.pointer({ target: row, keys: "[MouseRight]" });
    const item = await screen.findByRole("menuitem", { name: "Attach as context" });
    item.focus();
    await user.keyboard("{Enter}");

    expect(onAttachAsContext).toHaveBeenCalledWith("thread-one", "Controller foundation");
    expect(onSelectThread).not.toHaveBeenCalled();
  });
});
