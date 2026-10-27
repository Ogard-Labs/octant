import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ThreadFollowUpSuggestions } from "@octant/contracts";
import {
  EnvironmentSuggestedTasks,
  FollowUpSuggestionChips,
  FollowUpSuggestionContext,
  useComposerSuggestion,
} from "./FollowUpSuggestionChips";
import { ThreadActivityRevisionsContext } from "../polling/ThreadActivityRevisions";

function ComposerProbe() {
  useComposerSuggestion();
  return null;
}

function revisions(threadFollowUps: number) {
  return {
    browserCaptures: 0,
    toolApprovals: 0,
    threadFollowUps,
    threadMessageQueue: 0,
  };
}

function setVisible(visible: boolean) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: visible ? "visible" : "hidden",
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

const threadId = "00000000-0000-4000-8000-000000000020";
const suggestionId = "00000000-0000-4000-8000-000000000041";
const turnId = "00000000-0000-4000-8000-000000000031";

function suggestions(activated: ReadonlyArray<string> = []): ThreadFollowUpSuggestions {
  return {
    threadId,
    mode: "code",
    suggestedBy: {
      providerInstanceId: "00000000-0000-4000-8000-000000000001",
      modelId: "claude-sonnet",
    },
    followUps: {
      turnId,
      suggestions: [
        {
          id: suggestionId,
          title: "Add tests",
          prompt: "Write tests for nested lists in the parser.",
          target: "new-worktree",
        },
      ],
    },
    activatedFollowUpIds: activated,
  } as never;
}

const created = {
  kind: "new-worktree",
  mode: "code",
  projectId: "00000000-0000-4000-8000-0000000000bb",
  title: "Add tests",
  threadId: "00000000-0000-4000-8000-000000000099",
} as const;

describe("FollowUpSuggestionChips", () => {
  it("previews a suggestion and creates nothing until the person starts it", async () => {
    let activated: ReadonlyArray<string> = [];
    const client = {
      suggestions: vi.fn(async () => suggestions(activated)),
      preview: vi.fn(async () => ({
        suggestion: suggestions().followUps.suggestions[0]!,
        wouldCreate: {
          kind: "new-worktree",
          mode: "code",
          projectId: created.projectId,
          title: "Add tests",
        },
      })),
      activate: vi.fn(async () => {
        activated = [suggestionId];
        return { kind: "follow-up-activated", suggestionId, created };
      }),
    };
    const onCreated = vi.fn();
    render(
      <FollowUpSuggestionChips
        client={client as never}
        mode="code"
        onCreated={onCreated}
        threadId={threadId}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Start Add tests" }));
    expect(await screen.findByText(/starts a new Code thread on its own worktree/)).toBeVisible();
    expect(client.activate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(client.activate.mock.calls[0]).toEqual([
      threadId,
      { turnId, suggestionId, confirmed: true },
    ]);
    expect(onCreated).toHaveBeenCalledWith({
      mode: "code",
      created,
      prompt: "Write tests for nested lists in the parser.",
    });
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Suggested follow-ups" })).toBeNull(),
    );
  });

  it("says why the host refused a suggestion and keeps its card", async () => {
    const client = {
      suggestions: vi.fn(async () => suggestions()),
      preview: vi.fn(async () => ({
        kind: "follow-up-refused",
        suggestionId,
        reason: "target-unavailable",
        message: "The follow-up was refused: target-unavailable.",
      })),
      activate: vi.fn(),
    };
    render(
      <FollowUpSuggestionChips
        client={client as never}
        mode="work"
        onCreated={vi.fn()}
        threadId={threadId}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Start Add tests" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("target-unavailable");
    expect(screen.getByRole("button", { name: "Start Add tests" })).toBeVisible();
  });

  it("keeps open suggestions in Environment's Suggested tasks card, and shows no card without them", async () => {
    const offered = {
      suggestions: vi.fn(async () => suggestions()),
      preview: vi.fn(),
      activate: vi.fn(),
    };
    const { unmount } = render(
      <FollowUpSuggestionContext
        value={{ client: offered as never, mode: "code", onCreated: vi.fn(), threadId }}
      >
        <EnvironmentSuggestedTasks />
      </FollowUpSuggestionContext>,
    );
    const card = await screen.findByRole("group", { name: "Suggested tasks" });
    expect(card).toHaveTextContent("Add tests");
    unmount();

    const none = { suggestions: vi.fn(async () => null), preview: vi.fn(), activate: vi.fn() };
    render(
      <FollowUpSuggestionContext
        value={{ client: none as never, mode: "code", onCreated: vi.fn(), threadId }}
      >
        <EnvironmentSuggestedTasks />
      </FollowUpSuggestionContext>,
    );
    await waitFor(() => expect(none.suggestions).toHaveBeenCalled());
    expect(screen.queryByRole("group", { name: "Suggested tasks" })).toBeNull();
  });

  it("hides the Environment copy too when the person dismisses the cards in the thread", async () => {
    const otherThread = "00000000-0000-4000-8000-000000000021";
    const client = {
      suggestions: vi.fn(async () => ({ ...suggestions(), threadId: otherThread })),
      preview: vi.fn(),
      activate: vi.fn(),
    };
    const value = {
      client: client as never,
      mode: "code" as const,
      onCreated: vi.fn(),
      threadId: otherThread,
    };
    render(
      <FollowUpSuggestionContext value={value}>
        <FollowUpSuggestionChips {...value} />
        <EnvironmentSuggestedTasks />
      </FollowUpSuggestionContext>,
    );
    expect(await screen.findByRole("group", { name: "Suggested tasks" })).toBeVisible();
    const [dismiss] = await screen.findAllByRole("button", { name: "Dismiss Add tests" });
    await userEvent.click(dismiss!);
    expect(screen.queryByRole("group", { name: "Suggested tasks" })).toBeNull();
    expect(screen.queryAllByRole("region", { name: "Suggested follow-ups" })).toHaveLength(0);
  });

  it("stays out of the composer when the latest reply suggested nothing", async () => {
    const client = {
      suggestions: vi.fn(async () => null),
      preview: vi.fn(),
      activate: vi.fn(),
    };
    const { container } = render(
      <FollowUpSuggestionChips
        client={client as never}
        mode="chat"
        onCreated={vi.fn()}
        threadId={threadId}
      />,
    );
    await waitFor(() => expect(client.suggestions).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("reads once per follow-up notice, shared by the cards and the composer", async () => {
    const client = { suggestions: vi.fn(async () => null), preview: vi.fn(), activate: vi.fn() };
    const offers = {
      client: client as never,
      mode: "chat" as const,
      threadId,
      onCreated: vi.fn(),
    };
    const view = render(
      <ThreadActivityRevisionsContext.Provider value={revisions(1)}>
        <FollowUpSuggestionContext value={offers}>
          <FollowUpSuggestionChips {...offers} />
          <ComposerProbe />
        </FollowUpSuggestionContext>
      </ThreadActivityRevisionsContext.Provider>,
    );
    await waitFor(() => expect(client.suggestions).toHaveBeenCalledTimes(1));

    view.rerender(
      <ThreadActivityRevisionsContext.Provider value={revisions(2)}>
        <FollowUpSuggestionContext value={offers}>
          <FollowUpSuggestionChips {...offers} />
          <ComposerProbe />
        </FollowUpSuggestionContext>
      </ThreadActivityRevisionsContext.Provider>,
    );
    await waitFor(() => expect(client.suggestions).toHaveBeenCalledTimes(2));
  });

  it("earns exactly one trailing read when a notice lands during a read", async () => {
    let release!: (value: null) => void;
    const blocked = new Promise<null>((resolve) => {
      release = resolve;
    });
    const client = {
      suggestions: vi
        .fn()
        .mockImplementationOnce(() => blocked)
        .mockResolvedValue(null),
      preview: vi.fn(),
      activate: vi.fn(),
    };
    const offers = {
      client: client as never,
      mode: "chat" as const,
      threadId: "00000000-0000-4000-8000-000000000021",
      onCreated: vi.fn(),
    };
    const view = render(
      <ThreadActivityRevisionsContext.Provider value={revisions(1)}>
        <FollowUpSuggestionContext value={offers}>
          <FollowUpSuggestionChips {...offers} />
          <ComposerProbe />
        </FollowUpSuggestionContext>
      </ThreadActivityRevisionsContext.Provider>,
    );
    await waitFor(() => expect(client.suggestions).toHaveBeenCalledTimes(1));

    view.rerender(
      <ThreadActivityRevisionsContext.Provider value={revisions(2)}>
        <FollowUpSuggestionContext value={offers}>
          <FollowUpSuggestionChips {...offers} />
          <ComposerProbe />
        </FollowUpSuggestionContext>
      </ThreadActivityRevisionsContext.Provider>,
    );
    await waitFor(() => expect(client.suggestions).toHaveBeenCalledTimes(1));
    release(null);
    await waitFor(() => expect(client.suggestions).toHaveBeenCalledTimes(2));
  });

  it("makes no reads for notices or reconnects while hidden, then one when visible", async () => {
    const client = { suggestions: vi.fn(async () => null), preview: vi.fn(), activate: vi.fn() };
    const offers = {
      client: client as never,
      mode: "chat" as const,
      threadId: "00000000-0000-4000-8000-000000000022",
      onCreated: vi.fn(),
    };
    const view = render(
      <ThreadActivityRevisionsContext.Provider value={revisions(1)}>
        <FollowUpSuggestionContext value={offers}>
          <FollowUpSuggestionChips {...offers} />
          <ComposerProbe />
        </FollowUpSuggestionContext>
      </ThreadActivityRevisionsContext.Provider>,
    );
    await waitFor(() => expect(client.suggestions).toHaveBeenCalledTimes(1));

    setVisible(false);
    try {
      view.rerender(
        <ThreadActivityRevisionsContext.Provider value={revisions(2)}>
          <FollowUpSuggestionContext value={offers}>
            <FollowUpSuggestionChips {...offers} />
            <ComposerProbe />
          </FollowUpSuggestionContext>
        </ThreadActivityRevisionsContext.Provider>,
      );
      window.dispatchEvent(new Event("online"));
      await new Promise((settle) => setTimeout(settle, 50));
      expect(client.suggestions).toHaveBeenCalledTimes(1);

      setVisible(true);
      await waitFor(() => expect(client.suggestions).toHaveBeenCalledTimes(2));
    } finally {
      setVisible(true);
    }
  });

  it("drops a queued trailing read when its last surface goes away mid-read", async () => {
    let release!: (value: null) => void;
    const blocked = new Promise<null>((resolve) => {
      release = resolve;
    });
    const client = {
      suggestions: vi
        .fn()
        .mockImplementationOnce(() => blocked)
        .mockResolvedValue(null),
      preview: vi.fn(),
      activate: vi.fn(),
    };
    const offers = {
      client: client as never,
      mode: "chat" as const,
      threadId: "00000000-0000-4000-8000-000000000023",
      onCreated: vi.fn(),
    };
    const view = render(
      <ThreadActivityRevisionsContext.Provider value={revisions(1)}>
        <FollowUpSuggestionContext value={offers}>
          <FollowUpSuggestionChips {...offers} />
        </FollowUpSuggestionContext>
      </ThreadActivityRevisionsContext.Provider>,
    );
    await waitFor(() => expect(client.suggestions).toHaveBeenCalledTimes(1));

    view.rerender(
      <ThreadActivityRevisionsContext.Provider value={revisions(2)}>
        <FollowUpSuggestionContext value={offers}>
          <FollowUpSuggestionChips {...offers} />
        </FollowUpSuggestionContext>
      </ThreadActivityRevisionsContext.Provider>,
    );
    view.unmount();
    release(null);
    await new Promise((settle) => setTimeout(settle, 50));
    expect(client.suggestions).toHaveBeenCalledTimes(1);
  });
});
