import {
  decodeActivityView,
  type ActivityQuery,
  type ActivityView,
} from "@octant/contracts/code-home-activity";
import type { HomeCardCustomization } from "@octant/contracts/shell";
import { resolveActivityRange } from "@octant/domain/activity-range-policy";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CodeHomeActivity, type CodeHomeActivityProps } from "./CodeHomeActivity";

const SNAPSHOT = "20000000-0000-4000-8000-000000000001";
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function view(overrides: Record<string, unknown> = {}): ActivityView {
  const merged: Record<string, unknown> = {
    status: "ready",
    source: "github",
    count: 2,
    comparisonCount: 1,
    checkedAt: "2026-11-04T09:00:00.000Z",
    snapshotId: SNAPSHOT,
    records: [
      {
        kind: "prs-merged",
        occurredAt: "2026-11-04T08:00:00.000Z",
        id: "octant/octant#41",
        label: "Ship the panel",
        repositoryOwner: "octant",
        repositoryName: "octant",
        number: 41,
        mergedBy: "henrik",
      },
    ],
    nextOffset: 25,
    ...overrides,
  };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }
  return decodeActivityView(merged);
}

function reads(viewFor: (query: ActivityQuery) => ActivityView): {
  readonly read: CodeHomeActivityProps["read"];
  readonly calls: () => ReadonlyArray<ActivityQuery>;
} {
  const calls: ActivityQuery[] = [];
  return {
    read: (query) => {
      calls.push(query);
      return Promise.resolve(viewFor(query));
    },
    calls: () => calls,
  };
}

function Harness(props: {
  readonly initial?: HomeCardCustomization;
  readonly read: CodeHomeActivityProps["read"];
  readonly onOpenThread?: CodeHomeActivityProps["onOpenThread"];
  readonly onOpenExternal?: CodeHomeActivityProps["onOpenExternal"];
}) {
  const [customization, setCustomization] = useState<HomeCardCustomization>(
    props.initial ?? { order: [], visibility: [] },
  );
  return (
    <>
      <textarea aria-label="Message" />
      <CodeHomeActivity
        customization={customization}
        onCustomizationChange={setCustomization}
        onOpenThread={props.onOpenThread ?? (() => undefined)}
        {...(props.onOpenExternal === undefined ? {} : { onOpenExternal: props.onOpenExternal })}
        read={props.read}
        weekStartsOn={1}
      />
    </>
  );
}

function windowStart(kind: "this-week" | "last-month"): string {
  const resolved = resolveActivityRange({
    range: { kind },
    nowMs: Date.now(),
    timeZone,
    weekStartsOn: 1,
  });
  if (resolved.status !== "ready" || resolved.current.startMs === null) {
    throw new Error("fixture range refused");
  }
  return new Date(resolved.current.startMs).toISOString();
}

describe("the Code Home activity panel", () => {
  it("leaves the composer usable while the cards load, then shows each card's count", async () => {
    const source = reads(() => view());
    render(<Harness read={source.read} />);
    const composer = screen.getByRole("textbox", { name: "Message" });
    await userEvent.type(composer, "draft survives the reads");
    expect(composer).toHaveValue("draft survives the reads");

    const merged = await screen.findByRole("region", { name: "Pull requests merged" });
    expect(within(merged).getByText("2")).toBeInTheDocument();
    await waitFor(() => expect(source.calls()).toHaveLength(4));
    for (const query of source.calls()) {
      expect(query.kind).toBe("read");
    }
  });

  it("reads every unpinned card on the shared timeframe and a pinned card on its own", async () => {
    const source = reads(() => view());
    render(
      <Harness
        initial={{
          order: [],
          visibility: [],
          activity: {
            sharedRange: { kind: "this-week" },
            source: "github",
            pins: [{ card: "prs-merged", range: { kind: "last-month" } }],
          },
        }}
        read={source.read}
      />,
    );
    await screen.findByRole("region", { name: "Pull requests merged" });
    await waitFor(() => expect(source.calls()).toHaveLength(4));
    const byCard = new Map(
      source.calls().flatMap((query) => (query.kind === "read" ? [[query.card, query]] : [])),
    );
    const pinned = byCard.get("prs-merged");
    const shared = byCard.get("issues-closed");
    expect(pinned?.kind === "read" ? pinned.current.from : "").toBe(windowStart("last-month"));
    expect(shared?.kind === "read" ? shared.current.from : "").toBe(windowStart("this-week"));
    const card = screen.getByRole("region", { name: "Pull requests merged" });
    expect(within(card).getByText("Last month")).toBeInTheDocument();
  });

  it("always reads runs from Octant while deliveries follow the chosen source", async () => {
    const source = reads(() => view());
    render(
      <Harness
        initial={{
          order: [],
          visibility: [],
          activity: {
            sharedRange: { kind: "today" },
            source: "github",
            pins: [],
          },
        }}
        read={source.read}
      />,
    );
    await waitFor(() => expect(source.calls()).toHaveLength(4));
    const byCard = new Map(
      source.calls().flatMap((query) => (query.kind === "read" ? [[query.card, query]] : [])),
    );
    const runs = byCard.get("runs");
    const merged = byCard.get("prs-merged");
    expect(runs?.kind === "read" ? runs.source : "").toBe("octant");
    expect(merged?.kind === "read" ? merged.source : "").toBe("github");
  });

  it("labels the source honestly when GitHub is not connected", async () => {
    const source = reads(() => view({ fallback: "no-github-connection", source: "octant" }));
    render(<Harness read={source.read} />);
    const card = await screen.findByRole("region", { name: "Pull requests merged" });
    expect(within(card).getByText("Recorded by Octant")).toBeInTheDocument();
    expect(
      within(card).getByText("GitHub is not connected — showing what Octant recorded."),
    ).toBeInTheDocument();
  });

  it("says a read is partial instead of calling it complete", async () => {
    const source = reads(() => view({ status: "partial", reason: "incomplete" }));
    render(<Harness read={source.read} />);
    const card = await screen.findByRole("region", { name: "Pull requests merged" });
    expect(within(card).getByText(/Only part of this history could be read\./)).toBeInTheDocument();
    // A partial read never claims the previous window's honest count.
    expect(within(card).queryByText(/vs last week/)).toBeNull();
    expect(within(card).getByText("This week")).toBeInTheDocument();
  });

  it("names the card's source even when the count is zero", async () => {
    const source = reads(() => view({ count: 0, records: [], nextOffset: undefined }));
    render(<Harness read={source.read} />);
    const card = await screen.findByRole("region", { name: "Pull requests merged" });
    expect(within(card).getByText("0")).toBeInTheDocument();
    expect(within(card).getByText("None this week.")).toBeInTheDocument();
    expect(within(card).getByText("Your GitHub account")).toBeInTheDocument();
  });

  it("shows a dash, the reason and the source when a card cannot be read", async () => {
    const source = reads(() =>
      view({ status: "unavailable", reason: "rate-limited", records: [] }),
    );
    render(<Harness read={source.read} />);
    const card = await screen.findByRole("region", { name: "Pull requests merged" });
    expect(within(card).getByText("—")).toBeInTheDocument();
    expect(within(card).getByText("The source's rate limit was reached.")).toBeInTheDocument();
    expect(within(card).getByText("Your GitHub account")).toBeInTheDocument();
  });

  it("reads the same count as the last window without a delta", async () => {
    const source = reads(() => view({ count: 3, comparisonCount: 3 }));
    render(<Harness read={source.read} />);
    const card = await screen.findByRole("region", { name: "Pull requests merged" });
    expect(within(card).getByText("Same as last week")).toBeInTheDocument();
  });

  it("shows the comparison only when the read returns one", async () => {
    const source = reads((query) =>
      query.kind === "read" && query.card === "runs"
        ? view({ source: "octant", comparisonCount: undefined })
        : view(),
    );
    render(<Harness read={source.read} />);
    const merged = await screen.findByRole("region", { name: "Pull requests merged" });
    expect(within(merged).getByText("+1 vs last week")).toBeInTheDocument();
    const runs = screen.getByRole("region", { name: "Successful runs" });
    expect(within(runs).queryByText(/vs last week/)).toBeNull();
  });
});

describe("Customize activity", () => {
  it("opens the dialog from the keyboard and turns a card off and on", async () => {
    const user = userEvent.setup();
    const source = reads(() => view());
    render(<Harness read={source.read} />);
    const customize = await screen.findByRole("button", { name: "Customize activity" });
    customize.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Customize activity" });

    await user.click(within(dialog).getByRole("switch", { name: "Show Pull requests merged" }));
    await waitFor(() =>
      expect(document.querySelector('[data-card="activity-prs-merged"]')).toBeNull(),
    );

    await user.click(within(dialog).getByRole("switch", { name: "Show Pull requests merged" }));
    await user.click(within(dialog).getByRole("button", { name: "Close activity customization" }));
    expect(await screen.findByRole("region", { name: "Pull requests merged" })).toBeInTheDocument();
  });

  it("moves a card with the up and down buttons", async () => {
    const user = userEvent.setup();
    const source = reads(() => view());
    render(<Harness read={source.read} />);
    await screen.findByRole("region", { name: "Pull requests merged" });
    await user.click(await screen.findByRole("button", { name: "Customize activity" }));
    const dialog = await screen.findByRole("dialog", { name: "Customize activity" });
    await user.click(within(dialog).getByRole("button", { name: "Move Successful runs up" }));
    await waitFor(() => {
      const titles = Array.from(
        document.querySelectorAll(".code-home-activity__grid .home-card__title"),
      ).map((node) => node.textContent);
      expect(titles).toEqual([
        "Pull requests merged",
        "Issues closed",
        "Successful runs",
        "Releases published",
      ]);
    });
  });

  it("pins a card to its own timeframe and hands it back to the shared one", async () => {
    const user = userEvent.setup();
    const source = reads(() => view());
    let latest: HomeCardCustomization = { order: [], visibility: [] };
    function Watching() {
      const [customization, setCustomization] = useState<HomeCardCustomization>({
        order: [],
        visibility: [],
      });
      latest = customization;
      return (
        <CodeHomeActivity
          customization={customization}
          onCustomizationChange={setCustomization}
          onOpenThread={() => undefined}
          read={source.read}
          weekStartsOn={1}
        />
      );
    }
    render(<Watching />);
    await screen.findByRole("region", { name: "Pull requests merged" });
    await user.click(await screen.findByRole("button", { name: "Customize activity" }));
    const dialog = await screen.findByRole("dialog", { name: "Customize activity" });

    await user.click(
      within(dialog).getByRole("button", { name: "Pin a timeframe for Issues closed" }),
    );
    await waitFor(() =>
      expect(latest.activity?.pins).toEqual([
        { card: "issues-closed", range: { kind: "this-week" } },
      ]),
    );

    await user.click(
      within(dialog).getByRole("button", {
        name: "Use the shared timeframe for Issues closed",
      }),
    );
    await waitFor(() => expect(latest.activity?.pins).toEqual([]));
  });

  it("changes which history the cards read", async () => {
    const user = userEvent.setup();
    const source = reads(() => view());
    render(<Harness read={source.read} />);
    await waitFor(() => expect(source.calls()).toHaveLength(4));
    await user.click(await screen.findByRole("button", { name: "Customize activity" }));
    const dialog = await screen.findByRole("dialog", { name: "Customize activity" });
    await user.click(within(dialog).getByRole("combobox", { name: "History source" }));
    await user.click(await screen.findByRole("option", { name: "Recorded by Octant" }));
    await waitFor(() => expect(source.calls().length).toBeGreaterThanOrEqual(8));
    const laterReads = source
      .calls()
      .slice(4)
      .flatMap((query) => (query.kind === "read" ? [query] : []));
    expect(laterReads.some((query) => query.source === "octant")).toBe(true);
  });
});

describe("the records drill-down", () => {
  const pagesView = () =>
    view({
      count: 27,
      nextOffset: 25,
    });

  it("opens on the frozen view and pages the same snapshot for more", async () => {
    const user = userEvent.setup();
    const source = reads((query) =>
      query.kind === "page"
        ? view({
            records: [
              {
                kind: "prs-merged",
                occurredAt: "2026-11-03T08:00:00.000Z",
                id: "octant/octant#40",
                label: "Earlier merge",
                repositoryOwner: "octant",
                repositoryName: "octant",
                number: 40,
                mergedBy: "henrik",
              },
            ],
            snapshotId: query.snapshotId,
            nextOffset: undefined,
          })
        : pagesView(),
    );
    render(<Harness read={source.read} />);
    const card = await screen.findByRole("region", { name: "Pull requests merged" });
    await user.click(
      within(card).getByRole("button", { name: "Pull requests merged: 27. Show records" }),
    );
    const dialog = await screen.findByRole("dialog", { name: /Pull requests merged/ });
    expect(within(dialog).getByText("Ship the panel")).toBeInTheDocument();
    expect(within(dialog).getByText(/Your GitHub account/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Load more" }));
    await waitFor(() =>
      expect(
        source
          .calls()
          .some(
            (query) =>
              query.kind === "page" && query.snapshotId === SNAPSHOT && query.offset === 25,
          ),
      ).toBe(true),
    );
    expect(await within(dialog).findByText("Earlier merge")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("switches runs to every finished outcome inside the same snapshot", async () => {
    const user = userEvent.setup();
    const runsView = decodeActivityView({
      status: "ready",
      source: "octant",
      count: 1,
      finished: { successful: 1, failed: 2, canceled: 1 },
      snapshotId: SNAPSHOT,
      records: [
        {
          kind: "runs",
          occurredAt: "2026-11-04T08:00:00.000Z",
          id: "code:run-1",
          label: "Fix the flaky test",
          source: "code",
          finish: "successful",
          mode: "code",
          threadId: "10000000-0000-4000-8000-0000000000aa",
          runId: "run-1",
        },
      ],
      nextOffset: 25,
    });
    const allView = decodeActivityView({
      status: "ready",
      source: "octant",
      count: 4,
      finished: { successful: 1, failed: 2, canceled: 1 },
      snapshotId: SNAPSHOT,
      records: [
        {
          kind: "runs",
          occurredAt: "2026-11-04T09:00:00.000Z",
          id: "code:run-9",
          label: "Broke the build",
          source: "code",
          finish: "failed",
          mode: "code",
          threadId: "10000000-0000-4000-8000-0000000000aa",
          runId: "run-9",
        },
      ],
    });
    const source = reads((query) =>
      query.kind === "page" && query.allFinished === true ? allView : runsView,
    );
    render(<Harness read={source.read} />);
    const card = await screen.findByRole("region", { name: "Successful runs" });
    await user.click(
      within(card).getByRole("button", { name: "Successful runs: 1. Show records" }),
    );
    const dialog = await screen.findByRole("dialog", { name: /Successful runs/ });
    expect(within(dialog).getByText("1 successful · 2 failed · 1 canceled")).toBeInTheDocument();
    expect(within(dialog).getByText("Fix the flaky test")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("switch", { name: "All finished" }));
    await waitFor(() =>
      expect(
        source
          .calls()
          .some(
            (query) => query.kind === "page" && query.allFinished === true && query.offset === 0,
          ),
      ).toBe(true),
    );
    expect(await within(dialog).findByText("Broke the build")).toBeInTheDocument();
  });

  it("keeps the records button on a runs card whose only finishes failed or canceled", async () => {
    const user = userEvent.setup();
    const runsView = decodeActivityView({
      status: "ready",
      source: "octant",
      count: 0,
      finished: { successful: 0, failed: 1, canceled: 1 },
      snapshotId: SNAPSHOT,
      records: [],
      nextOffset: 25,
    });
    render(<Harness read={() => Promise.resolve(runsView)} />);
    const card = await screen.findByRole("region", { name: "Successful runs" });
    await user.click(
      within(card).getByRole("button", { name: "Successful runs: 0. Show records" }),
    );
    const dialog = await screen.findByRole("dialog", { name: /Successful runs/ });
    expect(within(dialog).getByRole("switch", { name: "All finished" })).toBeInTheDocument();
  });

  it("drops a stale page that lands after the mode it was read for changed", async () => {
    const user = userEvent.setup();
    const runsView = decodeActivityView({
      status: "ready",
      source: "octant",
      count: 1,
      finished: { successful: 1, failed: 0, canceled: 0 },
      snapshotId: SNAPSHOT,
      records: [
        {
          kind: "runs",
          occurredAt: "2026-11-04T08:00:00.000Z",
          id: "code:run-1",
          label: "Successful run",
          source: "code",
          finish: "successful",
          mode: "code",
          threadId: "10000000-0000-4000-8000-0000000000aa",
          runId: "run-1",
        },
      ],
      nextOffset: 25,
    });
    const allView = decodeActivityView({
      status: "ready",
      source: "octant",
      count: 2,
      finished: { successful: 1, failed: 1, canceled: 0 },
      snapshotId: SNAPSHOT,
      records: [
        {
          kind: "runs",
          occurredAt: "2026-11-04T09:00:00.000Z",
          id: "code:run-9",
          label: "Failed run",
          source: "code",
          finish: "failed",
          mode: "code",
          threadId: "10000000-0000-4000-8000-0000000000aa",
          runId: "run-9",
        },
      ],
    });
    const stalePage = decodeActivityView({
      status: "ready",
      source: "octant",
      count: 1,
      snapshotId: SNAPSHOT,
      records: [
        {
          kind: "runs",
          occurredAt: "2026-11-03T08:00:00.000Z",
          id: "code:run-old",
          label: "Older successful run",
          source: "code",
          finish: "successful",
          mode: "code",
          threadId: "10000000-0000-4000-8000-0000000000aa",
          runId: "run-old",
        },
      ],
    });
    let resolveStale: ((value: ActivityView) => void) | undefined;
    const read: CodeHomeActivityProps["read"] = (query) => {
      if (query.kind === "page" && query.allFinished === true) return Promise.resolve(allView);
      if (query.kind === "page") {
        return new Promise<ActivityView>((resolve) => {
          resolveStale = resolve;
        });
      }
      return Promise.resolve(runsView);
    };
    render(<Harness read={read} />);
    const card = await screen.findByRole("region", { name: "Successful runs" });
    await user.click(
      within(card).getByRole("button", { name: "Successful runs: 1. Show records" }),
    );
    const dialog = await screen.findByRole("dialog", { name: /Successful runs/ });
    await user.click(within(dialog).getByRole("button", { name: "Load more" }));
    await user.click(within(dialog).getByRole("switch", { name: "All finished" }));
    expect(await within(dialog).findByText("Failed run")).toBeInTheDocument();
    expect(within(dialog).queryByText("Successful run")).toBeNull();

    act(() => resolveStale?.(stalePage));
    await waitFor(() => expect(within(dialog).queryByText("Older successful run")).toBeNull());
    expect(within(dialog).getByText("Failed run")).toBeInTheDocument();
  });

  it("clears the frozen rows when the snapshot's access is gone", async () => {
    const user = userEvent.setup();
    const deadPage = decodeActivityView({
      status: "unavailable",
      source: "octant",
      reason: "authorization-changed",
      records: [],
    });
    const source = reads((query) =>
      query.kind === "page" ? deadPage : view({ source: "octant" }),
    );
    render(<Harness read={source.read} />);
    const card = await screen.findByRole("region", { name: "Pull requests merged" });
    await user.click(
      within(card).getByRole("button", { name: "Pull requests merged: 2. Show records" }),
    );
    const dialog = await screen.findByRole("dialog", { name: /Pull requests merged/ });
    expect(within(dialog).getByText("Ship the panel")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Load more" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Access changed — open it again to retry.",
    );
    expect(within(dialog).queryByText("Ship the panel")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("retires the open records when a refresh says the read is gone", async () => {
    const user = userEvent.setup();
    const pending: Array<(value: ActivityView) => void> = [];
    const read: CodeHomeActivityProps["read"] = (query) =>
      query.kind === "read" && query.refresh === true
        ? new Promise<ActivityView>((resolve) => pending.push(resolve))
        : Promise.resolve(view());
    render(<Harness read={read} />);
    const card = await screen.findByRole("region", { name: "Pull requests merged" });
    await user.click(screen.getByRole("button", { name: "Refresh activity" }));
    await user.click(
      within(card).getByRole("button", { name: "Pull requests merged: 2. Show records" }),
    );
    await screen.findByRole("dialog", { name: /Pull requests merged/ });

    act(() => {
      const gone = decodeActivityView({
        status: "unavailable",
        source: "octant",
        records: [],
      });
      for (const resolve of pending) resolve(gone);
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Pull requests merged/ })).toBeNull(),
    );
  });

  it("re-reads once when a records page finds the snapshot expired, and reopening uses the new one", async () => {
    const user = userEvent.setup();
    const oldView = view();
    const newView = view({
      count: 1,
      nextOffset: undefined,
      records: [
        {
          kind: "prs-merged",
          occurredAt: "2026-11-04T08:00:00.000Z",
          id: "octant/octant#77",
          label: "Fresh merge",
          repositoryOwner: "octant",
          repositoryName: "octant",
          number: 77,
          mergedBy: "henrik",
        },
      ],
      snapshotId: "20000000-0000-4000-8000-000000000002",
    });
    let first = true;
    const source = reads((query) => {
      if (query.kind === "page") {
        return decodeActivityView({
          status: "unavailable",
          source: "github",
          reason: "expired",
          records: [],
        });
      }
      const answer = first ? oldView : newView;
      first = false;
      return answer;
    });
    render(<Harness read={source.read} />);
    const card = await screen.findByRole("region", { name: "Pull requests merged" });
    await user.click(
      within(card).getByRole("button", { name: "Pull requests merged: 2. Show records" }),
    );
    const dialog = await screen.findByRole("dialog", { name: /Pull requests merged/ });
    await user.click(within(dialog).getByRole("button", { name: "Load more" }));
    expect(
      await within(dialog).findByText(
        "This read expired. Open the records again to see the latest.",
      ),
    ).toBeInTheDocument();
    const cardReads = () =>
      source.calls().filter((query) => query.kind === "read" && query.card === "prs-merged");
    await waitFor(() => expect(cardReads()).toHaveLength(2));
    const reread = cardReads()[1];
    expect(reread?.kind === "read" && "refresh" in reread && reread.refresh === true).toBe(false);

    // Reopening reads from the renewed snapshot, not the dead one.
    await user.click(within(dialog).getByRole("button", { name: "Close records" }));
    await user.click(
      within(card).getByRole("button", { name: "Pull requests merged: 1. Show records" }),
    );
    const reopened = await screen.findByRole("dialog", { name: /Pull requests merged/ });
    expect(await within(reopened).findByText("Fresh merge")).toBeInTheDocument();
  });

  it("re-reads once when a page finds access changed, and reopening shows the new view", async () => {
    const user = userEvent.setup();
    const oldView = view();
    const newView = view({
      count: 1,
      nextOffset: undefined,
      records: [
        {
          kind: "prs-merged",
          occurredAt: "2026-11-04T08:00:00.000Z",
          id: "octant/octant#78",
          label: "Reauthorized merge",
          repositoryOwner: "octant",
          repositoryName: "octant",
          number: 78,
          mergedBy: "henrik",
        },
      ],
      snapshotId: "20000000-0000-4000-8000-000000000003",
    });
    let first = true;
    const source = reads((query) => {
      if (query.kind === "page") {
        return decodeActivityView({
          status: "unavailable",
          source: "octant",
          reason: "authorization-changed",
          records: [],
        });
      }
      const answer = first ? oldView : newView;
      first = false;
      return answer;
    });
    render(<Harness read={source.read} />);
    const card = await screen.findByRole("region", { name: "Pull requests merged" });
    await user.click(
      within(card).getByRole("button", { name: "Pull requests merged: 2. Show records" }),
    );
    const dialog = await screen.findByRole("dialog", { name: /Pull requests merged/ });
    await user.click(within(dialog).getByRole("button", { name: "Load more" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Access changed — open it again to retry.",
    );
    const cardReads = () =>
      source.calls().filter((query) => query.kind === "read" && query.card === "prs-merged");
    await waitFor(() => expect(cardReads()).toHaveLength(2));

    await user.click(within(dialog).getByRole("button", { name: "Close records" }));
    await user.click(
      within(card).getByRole("button", { name: "Pull requests merged: 1. Show records" }),
    );
    const reopened = await screen.findByRole("dialog", { name: /Pull requests merged/ });
    expect(await within(reopened).findByText("Reauthorized merge")).toBeInTheDocument();
    expect(within(reopened).queryByText("Ship the panel")).toBeNull();
  });

  it("opens the thread a run belongs to", async () => {
    const user = userEvent.setup();
    const onOpenThread = vi.fn();
    const runsView = decodeActivityView({
      status: "ready",
      source: "octant",
      count: 1,
      snapshotId: SNAPSHOT,
      records: [
        {
          kind: "runs",
          occurredAt: "2026-11-04T08:00:00.000Z",
          id: "work:run-2",
          label: "Draft the note",
          source: "work",
          finish: "successful",
          mode: "work",
          threadId: "10000000-0000-4000-8000-0000000000bb",
          runId: "run-2",
        },
      ],
    });
    const source = reads(() => runsView);
    render(<Harness onOpenThread={onOpenThread} read={source.read} />);
    const card = await screen.findByRole("region", { name: "Successful runs" });
    await user.click(
      within(card).getByRole("button", { name: "Successful runs: 1. Show records" }),
    );
    const dialog = await screen.findByRole("dialog", { name: /Successful runs/ });
    await user.click(within(dialog).getByRole("button", { name: "Open thread" }));
    expect(onOpenThread).toHaveBeenCalledWith({
      mode: "work",
      threadId: "10000000-0000-4000-8000-0000000000bb",
      title: "Draft the note",
    });
    expect(within(dialog).getByText(/run-2/)).toBeInTheDocument();
  });
});

describe("a changed scope", () => {
  it("keeps the last answer on screen while an explicit refresh reads again", async () => {
    const user = userEvent.setup();
    const pending: Array<(value: ActivityView) => void> = [];
    const calls: ActivityQuery[] = [];
    const read: CodeHomeActivityProps["read"] = (query) => {
      calls.push(query);
      if (calls.length <= 4) return Promise.resolve(view());
      return new Promise((resolve) => {
        pending.push(resolve);
      });
    };
    render(<Harness read={read} />);
    const card = await screen.findByRole("region", { name: "Pull requests merged" });
    expect(within(card).getByText("2")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Refresh activity" }));
    expect(within(card).getByText("2")).toBeInTheDocument();
    await waitFor(() => expect(pending).toHaveLength(4));
    expect(calls.some((query) => query.kind === "read" && query.refresh === true)).toBe(true);
    act(() => pending.forEach((resolve) => resolve(view({ count: 5 }))));
    expect(await within(card).findByText("5")).toBeInTheDocument();
  });
});
