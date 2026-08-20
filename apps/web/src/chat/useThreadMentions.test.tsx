import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ThreadMentionClient } from "@octant/client-runtime";
import type { SideChatSidecar, ThreadMentionCandidate } from "@octant/contracts";
import { useThreadMentions } from "./useThreadMentions";

const requestId = "00000000-0000-4000-8000-000000000001" as never;

function candidate(overrides: Partial<ThreadMentionCandidate> = {}): ThreadMentionCandidate {
  return {
    threadId: "thread-1",
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

/**
 * Harness that mirrors the real caller: the draft lives outside the hook, and
 * the hook only reacts to it.
 */
function Harness(props: {
  readonly client: ThreadMentionClient;
  readonly initialDraft?: string;
  readonly onSideChatOpened?: (sidecar: SideChatSidecar) => void;
  readonly onThreadIds?: (threadIds: ReadonlyArray<string>) => void;
}) {
  const [draft, setDraft] = useState(props.initialDraft ?? "");
  const mentions = useThreadMentions({
    client: props.client,
    draft,
    requestId: () => requestId,
    ...(props.onSideChatOpened === undefined ? {} : { onSideChatOpened: props.onSideChatOpened }),
  });
  return (
    <div>
      <textarea aria-label="draft" onChange={(e) => setDraft(e.target.value)} value={draft} />
      <button onClick={() => mentions.composer?.onQueryChange("rel")} type="button">
        search
      </button>
      <button onClick={() => mentions.composer?.onSelectCandidate(candidate())} type="button">
        pick
      </button>
      <button
        onClick={() => mentions.composer?.onOpenSideChat?.("thread-1" as never)}
        type="button"
      >
        side chat
      </button>
      <button
        onClick={() =>
          void mentions
            .resolveForSend()
            .then((threadIds) => props.onThreadIds?.(threadIds.map(String)))
        }
        type="button"
      >
        resolve
      </button>
      <button onClick={mentions.clear} type="button">
        clear
      </button>
      <output aria-label="chips">
        {mentions.chips
          .map((chip) => `${chip.title}|${chip.placementLabel}|${chip.unavailableReason ?? "ok"}`)
          .join(",")}
      </output>
      <output aria-label="status">{mentions.composer?.statusMessage ?? "none"}</output>
      <output aria-label="candidates">
        {(mentions.composer?.candidates ?? []).map((hit) => hit.title).join(",")}
      </output>
    </div>
  );
}

describe("useThreadMentions", () => {
  it("asks the host for candidates and never invents one", async () => {
    const user = userEvent.setup();
    const client = stubClient();
    render(<Harness client={client} />);

    await user.click(screen.getByRole("button", { name: "search" }));

    await waitFor(() =>
      expect(screen.getByLabelText("candidates")).toHaveTextContent("Release notes"),
    );
    expect(client.search).toHaveBeenCalledWith(requestId, "rel", expect.anything());
  });

  it("shows no candidates when the host search fails", async () => {
    const user = userEvent.setup();
    const client = stubClient({ search: vi.fn().mockRejectedValue(new Error("offline")) });
    render(<Harness client={client} />);

    await user.click(screen.getByRole("button", { name: "search" }));

    await waitFor(() => expect(screen.getByLabelText("candidates")).toHaveTextContent(""));
  });

  it("keeps a chip only while its text survives in the draft", async () => {
    const user = userEvent.setup();
    render(<Harness client={stubClient()} initialDraft="#[Release notes] ok" />);

    await user.click(screen.getByRole("button", { name: "pick" }));
    expect(screen.getByLabelText("chips")).toHaveTextContent("Release notes|Launch|ok");

    await user.clear(screen.getByLabelText("draft"));
    await waitFor(() => expect(screen.getByLabelText("chips")).toHaveTextContent(""));
  });

  it("does not add the same thread twice", async () => {
    const user = userEvent.setup();
    render(<Harness client={stubClient()} initialDraft="#[Release notes]" />);

    await user.click(screen.getByRole("button", { name: "pick" }));
    await user.click(screen.getByRole("button", { name: "pick" }));

    expect(screen.getByLabelText("chips")).toHaveTextContent("Release notes|Launch|ok");
    expect(screen.getByLabelText("chips").textContent?.split(",")).toHaveLength(1);
  });

  it("marks a refused chip unavailable and still names it on the send", async () => {
    const user = userEvent.setup();
    const client = stubClient({
      resolve: vi.fn().mockResolvedValue({
        mentions: [],
        unavailable: [{ threadId: "thread-1", reason: "unauthorized" }],
      }),
    });
    const onThreadIds = vi.fn();
    render(<Harness client={client} initialDraft="#[Release notes]" onThreadIds={onThreadIds} />);

    await user.click(screen.getByRole("button", { name: "pick" }));
    await user.click(screen.getByRole("button", { name: "resolve" }));

    await waitFor(() =>
      expect(screen.getByLabelText("chips")).toHaveTextContent(
        "Release notes|Launch|you cannot open this thread",
      ),
    );
    // The chip is still named on the send: the host decides again when the
    // turn runs, and says so in the turn when it will not read the thread.
    expect(onThreadIds).toHaveBeenCalledWith(["thread-1"]);
    expect(screen.getByLabelText("status")).toHaveTextContent(
      "Some mentioned threads are unavailable and were not included.",
    );
  });

  it("says so when the check itself fails, and still names the chip", async () => {
    const user = userEvent.setup();
    const client = stubClient({ resolve: vi.fn().mockRejectedValue(new Error("offline")) });
    const onThreadIds = vi.fn();
    render(<Harness client={client} initialDraft="#[Release notes]" onThreadIds={onThreadIds} />);

    await user.click(screen.getByRole("button", { name: "pick" }));
    await user.click(screen.getByRole("button", { name: "resolve" }));

    await waitFor(() => expect(onThreadIds).toHaveBeenCalledWith(["thread-1"]));
    expect(screen.getByLabelText("status")).toHaveTextContent(
      "Mentioned threads could not be read. Nothing was included.",
    );
  });

  it("does not mint a Side Chat sidecar when the shell cannot open it", async () => {
    const user = userEvent.setup();
    const client = stubClient({
      openSideChat: vi.fn().mockResolvedValue({ sidecar: {}, created: true }),
    });
    render(<Harness client={client} initialDraft="#[Release notes]" />);

    await user.click(screen.getByRole("button", { name: "pick" }));
    await user.click(screen.getByRole("button", { name: "side chat" }));

    expect(client.openSideChat).not.toHaveBeenCalled();
  });

  it("hands the host's sidecar linkage to the shell", async () => {
    const user = userEvent.setup();
    const sidecar = {
      sourceThreadId: "thread-1",
      sourceMode: "work",
      sidecarThreadId: "00000000-0000-4000-8000-000000000201",
      title: "Side Chat about Release notes",
      createdAt: "2026-08-14T10:00:00.000Z",
    } as unknown as SideChatSidecar;
    const onSideChatOpened = vi.fn();
    const client = stubClient({
      openSideChat: vi.fn().mockResolvedValue({ sidecar, created: true }),
    });
    render(
      <Harness
        client={client}
        initialDraft="#[Release notes]"
        onSideChatOpened={onSideChatOpened}
      />,
    );

    await user.click(screen.getByRole("button", { name: "pick" }));
    await user.click(screen.getByRole("button", { name: "side chat" }));

    await waitFor(() => expect(onSideChatOpened).toHaveBeenCalledWith(sidecar));
  });

  it("reports a refused Side Chat rather than pretending it opened", async () => {
    const user = userEvent.setup();
    const onSideChatOpened = vi.fn();
    const client = stubClient({
      openSideChat: vi.fn().mockRejectedValue(new Error("unauthorized")),
    });
    render(
      <Harness
        client={client}
        initialDraft="#[Release notes]"
        onSideChatOpened={onSideChatOpened}
      />,
    );

    await user.click(screen.getByRole("button", { name: "pick" }));
    await user.click(screen.getByRole("button", { name: "side chat" }));

    await waitFor(() =>
      expect(screen.getByLabelText("status")).toHaveTextContent(
        "Side Chat is unavailable for that thread.",
      ),
    );
    expect(onSideChatOpened).not.toHaveBeenCalled();
  });

  it("clears chips after a successful send", async () => {
    const user = userEvent.setup();
    render(<Harness client={stubClient()} initialDraft="#[Release notes]" />);
    await user.click(screen.getByRole("button", { name: "pick" }));

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "clear" }));
    });

    expect(screen.getByLabelText("chips")).toHaveTextContent("");
  });

  it("offers no mention surface when no client is reachable", () => {
    function NoClient() {
      const mentions = useThreadMentions({ draft: "" });
      return (
        <output aria-label="composer">{mentions.composer === undefined ? "off" : "on"}</output>
      );
    }
    render(<NoClient />);

    expect(screen.getByLabelText("composer")).toHaveTextContent("off");
  });
});
