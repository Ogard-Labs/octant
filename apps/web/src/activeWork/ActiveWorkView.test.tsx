import type { ActiveWorkAnswer, ActiveWorkClient } from "@octant/client-runtime/active-work-client";
import { decodeActiveWorkRow, type ActiveWorkRow } from "@octant/contracts/active-work";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { threadBoardStatusReasonLabel } from "../threadBoard/threadBoardGrouping";
import { ActiveWorkView, type ActiveWorkViewProps } from "./ActiveWorkView";
import type { ActiveWorkHost } from "./useActiveWork";

const id = (tail: string) => `00000000-0000-4000-8000-0000000000${tail}`;

function row(overrides: Partial<Record<keyof ActiveWorkRow, unknown>>): ActiveWorkRow {
  return decodeActiveWorkRow({
    kind: "thread",
    mode: "code",
    threadId: id("21"),
    title: "Fix the parser",
    board: { status: "ready", reason: "idle-unmet-delivery" },
    pullRequests: [],
    issues: [],
    updatedAt: "2026-11-25T10:00:00.000Z",
    ...overrides,
  });
}

function client(answer: ActiveWorkAnswer | (() => Promise<ActiveWorkAnswer>)) {
  return {
    read: vi.fn(typeof answer === "function" ? answer : async () => answer),
  } satisfies ActiveWorkClient;
}

const answered = (rows: ReadonlyArray<ActiveWorkRow>, truncated = false): ActiveWorkAnswer => ({
  status: "answered",
  work: { rows, truncated },
});

function host(overrides: Partial<ActiveWorkHost> & { readonly hostId: string }): ActiveWorkHost {
  return { name: overrides.hostId, reach: "ready", revision: 0, ...overrides };
}

function view(hosts: ReadonlyArray<ActiveWorkHost>, props: Partial<ActiveWorkViewProps> = {}) {
  return <ActiveWorkView canOpen={() => true} hosts={hosts} onOpen={() => undefined} {...props} />;
}

describe("the active-work overview", () => {
  it("lists every kind from two computers with its computer, Project, repository, branch and links", async () => {
    render(
      view([
        host({
          hostId: "studio",
          client: client(
            answered([
              row({
                projectName: "Parser",
                projectId: id("10"),
                repository: "acme/parser",
                branch: "feature/parser",
                ownWorktree: true,
                pullRequests: [
                  { owner: "acme", repository: "parser", number: 7 },
                  { owner: "acme", repository: "site", number: 2 },
                ],
                issues: [
                  { forge: "linear", identifier: "PAR-9" },
                  { forge: "github", owner: "acme", repository: "parser", number: 4 },
                ],
                board: { status: "waiting", reason: "decision-pending" },
              }),
              row({ kind: "coordinator", threadId: id("22"), title: "Plan the release" }),
            ]),
          ),
        }),
        host({
          hostId: "mini",
          client: client(
            answered([
              row({
                kind: "subagent",
                runId: id("61"),
                title: "Read the notes",
                parentTitle: "Draft the notes",
                board: { status: "in-progress", reason: "executing" },
              }),
              row({
                kind: "routine-run",
                mode: "work",
                threadId: id("24"),
                title: "Morning digest",
                board: { status: "in-progress", reason: "executing" },
              }),
            ]),
          ),
        }),
      ]),
    );
    const waiting = await screen.findByRole("region", { name: "Waiting (1)" });
    expect(
      within(waiting).getByText(threadBoardStatusReasonLabel("decision-pending")),
    ).toBeVisible();
    expect(
      within(waiting).getByText(
        "studio · Parser · acme/parser · feature/parser (own worktree) · PR #7 · PR acme/site#2 · PAR-9 · Issue #4",
      ),
    ).toBeVisible();
    const running = screen.getByRole("region", { name: "In progress (2)" });
    expect(within(running).getByText("Subagent · For Draft the notes · mini")).toBeVisible();
    expect(within(running).getByText("Automation run · mini")).toBeVisible();
    const ready = screen.getByRole("region", { name: "Ready (1)" });
    expect(within(ready).getByText("Coordinator · studio")).toBeVisible();
  });

  it("names a computer that is not connected with when it last was, and shows none of its rows", async () => {
    const away = client(answered([row({ title: "Old row" })]));
    const { rerender } = render(view([host({ hostId: "mini", client: away })]));
    expect(await screen.findByText("Old row")).toBeVisible();
    rerender(
      view([
        host({
          hostId: "mini",
          client: away,
          reach: "unreachable",
          lastReadyAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        }),
      ]),
    );
    expect(screen.queryByText("Old row")).toBeNull();
    expect(screen.getByText("mini is unreachable. Last connected 5m ago.")).toBeVisible();
    expect(screen.getByText("No active work on the computers that answered")).toBeVisible();
  });

  it("drops a connected computer's rows when it stops answering, and keeps the others'", async () => {
    const flaky = client(answered([row({ title: "Flaky row" })]));
    const steady = client(answered([row({ title: "Steady row" })]));
    const hosts = (revision: number) => [
      host({ hostId: "flaky", client: flaky, revision }),
      host({ hostId: "steady", client: steady }),
    ];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { rerender } = render(view(hosts(0)));
      expect(await screen.findByText("Flaky row")).toBeVisible();
      flaky.read.mockResolvedValue({ status: "unreachable" });
      rerender(view(hosts(1)));
      await act(() => vi.advanceTimersByTimeAsync(1_100));
      expect(screen.queryByText("Flaky row")).toBeNull();
      expect(screen.getByText("flaky is unreachable. Never connected.")).toBeVisible();
      expect(screen.getByText("Steady row")).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows no rows from before a computer dropped out while it is read again", async () => {
    const mini = client(answered([row({ title: "Before" })]));
    const { rerender } = render(view([host({ hostId: "mini", client: mini })]));
    expect(await screen.findByText("Before")).toBeVisible();
    rerender(view([host({ hostId: "mini", client: mini, reach: "unreachable" })]));
    mini.read.mockImplementation(() => new Promise(() => undefined));
    rerender(view([host({ hostId: "mini", client: mini, revision: 1 })]));
    expect(screen.queryByText("Before")).toBeNull();
    expect(screen.getByText("Reading active work…")).toBeVisible();
  });

  it("tells an older Octant and a refusal apart from having no work", async () => {
    render(
      view([
        host({ hostId: "older", client: client({ status: "unsupported" }) }),
        host({ hostId: "held", client: client({ status: "refused" }) }),
        host({ hostId: "busy", client: client(answered([], true)) }),
      ]),
    );
    expect(
      await screen.findByText("older runs an older Octant that does not list its work."),
    ).toBeVisible();
    expect(screen.getByText("held does not let this device list its work.")).toBeVisible();
    expect(screen.getByText("busy has more work than it lists here.")).toBeVisible();
  });

  it("does not let one slow computer hold back another", async () => {
    render(
      view([
        host({ hostId: "slow", client: client(() => new Promise(() => undefined)) }),
        host({ hostId: "fast", client: client(answered([row({ title: "Fast row" })])) }),
      ]),
    );
    expect(await screen.findByText("Fast row")).toBeVisible();
  });

  it("reads again only when its computer's change signal moves, and a burst is one read", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const studio = client(answered([row({})]));
      const mini = client(answered([]));
      const hosts = (revision: number) => [
        host({ hostId: "studio", client: studio, revision }),
        host({ hostId: "mini", client: mini }),
      ];
      const { rerender } = render(view(hosts(0)));
      expect(await screen.findByText("Fix the parser")).toBeVisible();
      await act(() => vi.advanceTimersByTimeAsync(120_000));
      expect(studio.read).toHaveBeenCalledTimes(1);
      rerender(view(hosts(1)));
      for (const revision of [2, 3, 4, 5]) rerender(view(hosts(revision)));
      await act(() => vi.advanceTimersByTimeAsync(5_000));
      expect(studio.read).toHaveBeenCalledTimes(3);
      expect(mini.read).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the last answer at once when the page is opened again", async () => {
    const studio = client(answered([row({})]));
    const { unmount } = render(view([host({ hostId: "studio", client: studio })]));
    expect(await screen.findByText("Fix the parser")).toBeVisible();
    unmount();
    studio.read.mockImplementation(() => new Promise(() => undefined));
    render(view([host({ hostId: "studio", client: studio })]));
    expect(screen.getByText("Fix the parser")).toBeVisible();
  });

  it("opens a row on its own computer, and says where to open one this window cannot", async () => {
    const onOpen = vi.fn();
    const code = row({ title: "Openable" });
    const work = row({ title: "Elsewhere", mode: "work", threadId: id("25") });
    const mini = host({ hostId: "mini", client: client(answered([code, work])) });
    render(view([mini], { onOpen, canOpen: (_host, candidate) => candidate.mode === "code" }));
    await userEvent.click(await screen.findByRole("button", { name: /Openable/ }));
    expect(onOpen).toHaveBeenCalledWith(mini, code);
    expect(screen.queryByRole("button", { name: /Elsewhere/ })).toBeNull();
    expect(screen.getByText("mini · Open it on mini")).toBeVisible();
  });

  it("calls a subagent whose task the reader may not see only a subagent", async () => {
    render(
      view([
        host({
          hostId: "studio",
          client: client(
            answered([
              row({ kind: "subagent", runId: id("61"), title: undefined, parentTitle: "Draft" }),
            ]),
          ),
        }),
      ]),
    );
    expect(await screen.findByText("Subagent")).toBeVisible();
    expect(screen.getByText("Subagent · For Draft · studio")).toBeVisible();
  });

  it("says when there is no active work and offers to start a thread", async () => {
    const onStartThread = vi.fn();
    render(view([host({ hostId: "studio", client: client(answered([])) })], { onStartThread }));
    expect(await screen.findByText("No active work")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Start a thread" }));
    expect(onStartThread).toHaveBeenCalled();
  });
});
