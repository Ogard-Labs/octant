import type { ThreadMentionClient } from "@octant/client-runtime";
import type { ProjectSummary } from "@octant/contracts";
import type { TrackerMentionCandidate } from "@octant/contracts/tracker-mention-search";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChatComposer } from "../chat/ChatComposer";
import { useThreadMentions } from "../chat/useThreadMentions";
import { listsOf } from "../threadReferences/threadReferenceLists.test-support";
import { ThreadReferencesContext } from "../threadReferences/ThreadReferences";
import { SentMessageText } from "../transcript/SentMessageText";
import { mentionedPullRequestIdentity } from "./mentionedPullRequestIdentity";

const pull: TrackerMentionCandidate = {
  kind: "pull-request",
  source: "github",
  id: "2901",
  url: "https://github.com/acme/app/pull/2901",
  title: "Fix login",
  state: "draft",
  container: "acme/app",
  person: "dana",
};
const linear: TrackerMentionCandidate = {
  kind: "linear-issue",
  source: "linear",
  id: "OCT-1042",
  url: "https://linear.app/acme/issue/OCT-1042/mentions",
  title: "Mention things",
  state: "In Progress",
  container: "OCT",
  person: "Sam",
};

function client(found: ReadonlyArray<TrackerMentionCandidate>) {
  const searchTrackers = vi.fn(async () => found);
  return {
    searchTrackers,
    client: {
      search: vi.fn(async () => []),
      searchThread: vi.fn(async () => []),
      resolve: vi.fn(async () => ({ mentions: [], unavailable: [] })),
      openSideChat: vi.fn(),
      execute: vi.fn(),
    } as ThreadMentionClient,
  };
}

function Composer(props: {
  readonly client: ThreadMentionClient;
  readonly search: () => Promise<ReadonlyArray<TrackerMentionCandidate>>;
  readonly onDraft: (draft: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const mentions = useThreadMentions({
    client: props.client,
    draft,
    trackerThreadId: "thread-1",
    trackerSearch: props.search,
  });
  return (
    <ChatComposer
      draft={draft}
      isSending={false}
      model={{ options: [{ id: "model-a", label: "Model A" }], value: "model-a" }}
      onDraftChange={(next) => {
        setDraft(next);
        props.onDraft(next);
      }}
      onFileSelected={vi.fn()}
      onModelChange={vi.fn()}
      onProviderChange={vi.fn()}
      onResearchEnabledChange={vi.fn()}
      onResearchRoutingChange={vi.fn()}
      onSend={vi.fn(async () => true)}
      provider={{ options: [{ id: "provider-a", label: "Provider A" }], value: "provider-a" }}
      research={{ backend: { kind: "disabled" }, enabled: false, routing: "automatic" }}
      {...(mentions.composer === undefined ? {} : { threadMentions: mentions.composer })}
    />
  );
}

function renderComposer(found: ReadonlyArray<TrackerMentionCandidate>) {
  const fake = client(found);
  const openBrowserExternal = vi.fn(async () => undefined);
  const onDraft = vi.fn();
  render(
    <ThreadReferencesContext.Provider
      value={{ ...listsOf({}), externalHost: { openBrowserExternal } }}
    >
      <Composer client={fake.client} onDraft={onDraft} search={fake.searchTrackers} />
    </ThreadReferencesContext.Provider>,
  );
  return { ...fake, openBrowserExternal, onDraft, message: screen.getByLabelText("Message") };
}

describe("mentioning a pull request or issue", () => {
  it("offers what the host found for the typed token, scoped to the composer's thread", async () => {
    const user = userEvent.setup();
    const { searchTrackers, message } = renderComposer([pull, linear]);

    await user.type(message, "#2901");

    const option = await screen.findByRole("option", { name: /#2901 Fix login/ });
    await waitFor(() => expect(option).toHaveTextContent("Draft"));
    expect(option).toHaveTextContent("Pull request · acme/app");
    expect(screen.getByRole("option", { name: /OCT-1042 Mention things/ })).toHaveTextContent(
      "Linear issue · OCT",
    );
    // Typing rests before the trackers are asked, so one search carries the token.
    expect(searchTrackers).toHaveBeenCalledTimes(1);
    expect(searchTrackers).toHaveBeenCalledWith(
      { query: "2901", readerThreadId: "thread-1" },
      expect.any(AbortSignal),
    );
  });

  it("asks no tracker for a bare # and offers none when the host finds none", async () => {
    const user = userEvent.setup();
    const { searchTrackers, message } = renderComposer([]);

    await user.type(message, "#");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(searchTrackers).not.toHaveBeenCalled();
    await user.type(message, "login");
    await waitFor(() => expect(searchTrackers).toHaveBeenCalled());

    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(screen.queryByText(/connect/i)).not.toBeInTheDocument();
  });

  it("puts one chip in the prompt with a card that opens the item and removes it", async () => {
    const user = userEvent.setup();
    const { message, onDraft, openBrowserExternal } = renderComposer([pull]);

    await user.type(message, "review #2901");
    await screen.findByRole("option", { name: /#2901 Fix login/ });
    await user.keyboard("{Enter}");

    expect(onDraft).toHaveBeenLastCalledWith(
      "review [#2901 Fix login](https://github.com/acme/app/pull/2901) ",
    );
    const chips = await screen.findAllByRole("button", {
      name: "Pull request #2901: Fix login, Draft",
    });
    expect(chips).toHaveLength(1);
    expect(message).not.toHaveTextContent("github.com");

    await user.click(chips[0] as HTMLElement);
    const card = await screen.findByRole("dialog", { name: "Pull request details" });
    for (const fact of ["Pull request #2901", "Fix login", "Draft", "acme/app", "dana"]) {
      expect(card).toHaveTextContent(fact);
    }
    await user.click(within(card).getByRole("button", { name: "Open" }));
    // No Project of this window holds that repository, so it opens on the web.
    expect(openBrowserExternal).toHaveBeenCalledWith(pull.url);

    await user.click(screen.getByRole("button", { name: "Pull request #2901: Fix login, Draft" }));
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    expect(onDraft).toHaveBeenLastCalledWith("review ");
  });
});

describe("a sent message that mentioned a pull request or issue", () => {
  const text = "Compare [#7 Old fix](https://github.com/acme/app/pull/7) today";
  const recorded = [
    {
      kind: "pull-request" as const,
      source: "github" as const,
      id: "7",
      url: "https://github.com/acme/app/pull/7",
    },
  ];

  it("shows the chip from the turn's record alone, with the facts its text and URL give", async () => {
    const user = userEvent.setup();
    const { container } = render(<SentMessageText text={text} trackerMentions={recorded} />);

    const chip = await screen.findByRole("button", { name: "Pull request #7: Old fix" });
    expect(container).not.toHaveTextContent("github.com");
    expect(container.querySelector("p")).toHaveTextContent(/^Compare .*#7 Old fix today$/);
    await user.click(chip);
    const card = await screen.findByRole("dialog", { name: "Pull request details" });
    expect(card).toHaveTextContent("acme/app");
    expect(card).not.toHaveTextContent("State");
    expect(within(card).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("stays the text it was when it recorded no mention", () => {
    const { container } = render(<SentMessageText text={text} />);

    expect(container).toHaveTextContent(text);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("opening a mentioned pull request", () => {
  const projects = [
    {
      id: "00000000-0000-4000-8000-000000000931",
      type: "code",
      lifecycle: "active",
      connectedRepository: { host: "github.com", owner: "Acme", repository: "App" },
    },
  ] as unknown as ReadonlyArray<ProjectSummary>;

  it("uses Octant's pane for a pull request of a Project the window holds, else the web", () => {
    expect(mentionedPullRequestIdentity(pull.url, projects)).toEqual({
      projectId: "00000000-0000-4000-8000-000000000931",
      repositoryOwner: "acme",
      repositoryName: "app",
      number: 2901,
    });
    expect(
      mentionedPullRequestIdentity("https://github.com/other/repo/pull/1", projects),
    ).toBeUndefined();
    expect(
      mentionedPullRequestIdentity("https://github.com/acme/app/issues/1", projects),
    ).toBeUndefined();
    expect(mentionedPullRequestIdentity(linear.url, projects)).toBeUndefined();
  });
});
