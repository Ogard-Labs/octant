import type { ThreadMentionClient } from "@octant/client-runtime";
import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import type { WorkTurnClient } from "@octant/client-runtime/work-turn-client";
import { decodeWorkThreadId } from "@octant/contracts";
import type { ProjectId } from "@octant/contracts/projects";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeComposerAdapter } from "../code/composer/CodeComposerAdapter";
import { WorkComposerAdapter } from "../work/composer/WorkComposerAdapter";
import { WorkThreadWorkspace } from "../work/WorkThreadWorkspace";

const projectId = "00000000-0000-0000-0000-000000000001" as ProjectId;
const server = { serverUrl: "http://127.0.0.1:9", windowCapability: "cap" };
const items = [
  {
    kind: "pull-request",
    source: "github",
    id: "7",
    url: "https://github.com/acme/app/pull/7",
    title: "Fix login",
    state: "open",
    container: "acme/app",
  },
  {
    kind: "linear-issue",
    source: "linear",
    id: "OCT-9",
    url: "https://linear.app/acme/issue/OCT-9/login",
    title: "Login copy",
    state: "Todo",
    container: "OCT",
  },
];
const mentionClient = {
  search: vi.fn(async () => []),
  searchThread: vi.fn(async () => []),
  resolve: vi.fn(async () => ({ mentions: [], unavailable: [] })),
  openSideChat: vi.fn(),
  execute: vi.fn(),
} as ThreadMentionClient;

const turnClient = {
  transcript: vi.fn(async () => ({ threadId: "10000000-0000-4000-8000-000000000101", turns: [] })),
  transcriptWindow: vi.fn(async () => ({
    version: 1,
    threadId: "10000000-0000-4000-8000-000000000101",
    turns: [],
    liveCursor: 0,
    hasEarlier: false,
    hasLater: false,
  })),
  subscribe: vi.fn(async function* () {}),
} as unknown as WorkTurnClient;

const threadClient: WorkThreadClient = {
  searchTranscript: vi.fn(),
  bootstrap: vi.fn(),
  navigation: vi.fn(),
  execute: vi.fn(),
  queryBoard: vi.fn(),
};

const composers: ReadonlyArray<readonly [string, string, () => ReactElement]> = [
  [
    "a new Work thread",
    "First message",
    () => (
      <WorkComposerAdapter
        {...server}
        onCancel={() => {}}
        onCreateThread={() => {}}
        onSelectProvider={() => {}}
        projectId={projectId}
        providerGroups={[]}
      />
    ),
  ],
  [
    "a new Code thread",
    "First message",
    () => (
      <CodeComposerAdapter
        {...server}
        defaultPermissionMode="ask-first"
        defaultPermissionPersistence="current-session"
        onCancel={() => {}}
        onCreateThread={() => {}}
        onSelectProvider={() => {}}
        projectId={projectId}
        projectName="app"
        projectRoot="/tmp/app"
        providerGroups={[]}
      />
    ),
  ],
  [
    "a Work thread",
    "Work prompt",
    () => (
      <WorkThreadWorkspace
        {...server}
        // A thread that can start a turn, so its prompt takes typing.
        turnClient={turnClient}
        threadClient={threadClient}
        threadId={decodeWorkThreadId("10000000-0000-4000-8000-000000000101")}
        threadMentionClient={mentionClient}
        title="Draft brief"
      />
    ),
  ],
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(composers)("the # list of %s", (_name, label, composer) => {
  it("tells assistive technology which list is open and which row is highlighted", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      String(input).endsWith("/api/thread-mentions/trackers")
        ? Response.json({ candidates: items })
        : Response.json({ message: "unavailable" }, { status: 503 }),
    );
    const user = userEvent.setup();
    render(composer());
    const input = await screen.findByLabelText(label);
    await waitFor(() => expect(input).toBeEnabled());

    await user.type(input, "#login");
    const first = await screen.findByRole("option", { name: /#7 Fix login/ });
    const list = screen.getByRole("listbox", {
      name: "Threads, pull requests and issues you can mention",
    });

    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-controls", list.id);
    expect(input).toHaveAttribute("aria-activedescendant", first.id);
    await user.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: /OCT-9 Login copy/ }).id,
    );
  });
});
