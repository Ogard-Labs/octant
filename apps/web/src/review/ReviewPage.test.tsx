import { resolveSnoozePresets } from "@octant/domain";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { parseUnifiedDiff } from "../code/unifiedDiff";
import { ReviewPage, type ReviewPageProps } from "./ReviewPage";
import type { ReviewEntry } from "./reviewModel";
import type { ReviewFacts, ReviewSource } from "./reviewSource";

const NOW = Date.parse("2026-10-06T12:00:00Z");

const entry = (threadId: string, title: string, updatedAt: string): ReviewEntry => ({
  mode: "code",
  threadId,
  title,
  projectName: "Octant",
  updatedAt,
});

const first = entry("t1", "Fix the sidebar clip", "2026-10-06T08:00:00Z");
const second = entry("t2", "Add the export route", "2026-10-06T09:00:00Z");
const third = entry("t3", "Tidy the settings copy", "2026-10-06T10:00:00Z");

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  " keep",
  "-old line",
  "+new line",
  "+extra line",
  "diff --git a/src/b.ts b/src/b.ts",
  "index 333..444 100644",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1 +1 @@",
  "-before",
  "+after",
  "",
].join("\n");

function facts(overrides: Partial<ReviewFacts> = {}): ReviewFacts {
  return {
    check: "passed",
    branch: "feature/sidebar",
    base: "main",
    commits: 2,
    changes: { files: 2, insertions: 3, deletions: 2 },
    ...overrides,
  };
}

function makeSource(overrides: Partial<ReviewSource> = {}): ReviewSource {
  return {
    loadFacts: vi.fn(async (entries: ReadonlyArray<ReviewEntry>) => {
      const byKey = new Map<string, ReviewFacts>();
      for (const item of entries) byKey.set(`${item.mode}:${item.threadId}`, facts());
      return byKey;
    }),
    loadReply: vi.fn(async (item: ReviewEntry) => ({
      text: `Reply for ${item.title}`,
      outcome: "completed" as const,
    })),
    loadOctantCheck: vi.fn(async () => ({ verdict: "passed" as const })),
    loadDiff: vi.fn(async () => ({
      status: "ready" as const,
      files: parseUnifiedDiff(DIFF),
      truncated: false,
    })),
    ...overrides,
  };
}

function props(overrides: Partial<ReviewPageProps> = {}): ReviewPageProps {
  return {
    entries: [second, third, first],
    source: makeSource(),
    changeRevision: 0,
    now: NOW,
    onClose: vi.fn(),
    onOpen: vi.fn(),
    onComplete: vi.fn(async () => ({ status: "ok" as const })),
    onSnooze: vi.fn(async () => ({ status: "ok" as const })),
    onSendBack: vi.fn(async () => ({ status: "ok" as const })),
    onMarkSeen: vi.fn(),
    ...overrides,
  };
}

function current() {
  return screen.getByRole("region", { name: /^Review (?!finished)/ });
}

describe("ReviewPage", () => {
  it("asks to open a Code thread's Project instead of reading what the window may not read", async () => {
    const elsewhere: ReviewEntry = { ...first, projectId: "p2", projectName: "Billing" };
    const source = makeSource();
    const onOpenProject = vi.fn();
    const view = render(
      <ReviewPage
        {...props({
          entries: [elsewhere],
          source,
          codeProjectAccess: { boundProjectId: "p1", onOpenProject },
        })}
      />,
    );

    expect(
      await within(current()).findByText(
        "This thread is in Billing. Open that Project to see its reply, checks and changes.",
      ),
    ).toBeInTheDocument();
    expect(source.loadReply).not.toHaveBeenCalled();
    expect(source.loadDiff).not.toHaveBeenCalled();
    expect(within(current()).queryByText("Code thread is unauthorized.")).toBeNull();

    await userEvent.click(within(current()).getByRole("button", { name: "Open Billing" }));
    expect(onOpenProject).toHaveBeenCalledWith(elsewhere);

    view.rerender(
      <ReviewPage
        {...props({
          entries: [elsewhere],
          source,
          codeProjectAccess: { boundProjectId: "p2", onOpenProject },
        })}
      />,
    );
    expect(
      await within(current()).findByText("Reply for Fix the sidebar clip"),
    ).toBeInTheDocument();
  });

  it("lists the finished threads oldest first with what changed and whether it worked", async () => {
    render(<ReviewPage {...props()} />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "To review · 3 finished threads",
    );
    const rows = within(screen.getByRole("navigation", { name: "Finished threads" })).getAllByRole(
      "button",
    );
    expect(rows.map((row) => row.querySelector(".review-row__title")?.textContent)).toEqual([
      "Fix the sidebar clip",
      "Add the export route",
      "Tidy the settings copy",
    ]);
    await waitFor(() => expect(rows[0]).toHaveTextContent("Octant · 2 files · +3 −2"));
    expect(rows[0]).toHaveTextContent("passed");
    expect(rows[0]).toHaveTextContent("4h ago");
    expect(rows[0]).toHaveAttribute("aria-current", "true");
  });

  it("shows the selected thread's last reply, checks, and the diff of one changed file", async () => {
    const user = userEvent.setup();
    render(<ReviewPage {...props()} />);

    const detail = current();
    expect(within(detail).getByRole("heading", { name: "Fix the sidebar clip" })).toBeVisible();
    await waitFor(() =>
      expect(within(detail).getByText("Reply for Fix the sidebar clip")).toBeVisible(),
    );
    expect(detail).toHaveTextContent("Octant · feature/sidebar → main · 2 commits");
    await waitFor(() => expect(detail).toHaveTextContent("Octant check passed"));
    expect(detail).toHaveTextContent("CI passed");
    const files = await within(detail).findByRole("list", { name: "Files" });
    expect(
      within(files)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["src/a.ts+2 −1", "src/b.ts+1 −1"]);
    expect(within(detail).getByRole("table", { name: "Diff for src/a.ts" })).toBeVisible();
    expect(within(detail).queryByRole("table", { name: "Diff for src/b.ts" })).toBeNull();

    await user.click(within(files).getByRole("button", { name: /src\/b\.ts/ }));
    expect(within(detail).getByRole("table", { name: "Diff for src/b.ts" })).toBeVisible();
    expect(within(detail).queryByRole("table", { name: "Diff for src/a.ts" })).toBeNull();
  });

  it("moves with J and K, opens with Enter, and marks seen with E", async () => {
    const user = userEvent.setup();
    const page = props();
    render(<ReviewPage {...page} />);
    await waitFor(() => expect(screen.getByText("Reply for Fix the sidebar clip")).toBeVisible());

    await user.keyboard("j");
    expect(within(current()).getByRole("heading", { name: "Add the export route" })).toBeVisible();
    await waitFor(() => expect(screen.getByText("Reply for Add the export route")).toBeVisible());
    await user.keyboard("jj");
    // The last row is the end of the list, not a wrap-around.
    expect(
      within(current()).getByRole("heading", { name: "Tidy the settings copy" }),
    ).toBeVisible();
    await user.keyboard("k");
    expect(within(current()).getByRole("heading", { name: "Add the export route" })).toBeVisible();

    await user.keyboard("{Enter}");
    expect(page.onOpen).toHaveBeenCalledWith(second);
    await user.keyboard("e");
    expect(page.onMarkSeen).toHaveBeenCalledWith(second);
  });

  it("completes the selected thread with C and shows a host refusal in the host's words", async () => {
    const user = userEvent.setup();
    const onComplete = vi
      .fn()
      .mockResolvedValueOnce({
        status: "refused",
        message: "This thread is waiting on you, so it cannot be completed.",
      })
      .mockResolvedValue({ status: "ok" });
    render(<ReviewPage {...props({ onComplete })} />);

    await user.keyboard("c");
    expect(onComplete).toHaveBeenCalledWith(first);
    expect(await within(current()).findByRole("alert")).toHaveTextContent(
      "This thread is waiting on you, so it cannot be completed.",
    );

    // The refusal belongs to the thread it concerned.
    await user.keyboard("j");
    expect(within(current()).queryByRole("alert")).toBeNull();
  });

  it("sends a thread back from a one-line field, and its keys do not act while typing", async () => {
    const user = userEvent.setup();
    const page = props();
    render(<ReviewPage {...page} />);

    await user.keyboard("s");
    const field = await screen.findByRole("textbox", {
      name: "Follow-up for Fix the sidebar clip",
    });
    await waitFor(() => expect(field).toHaveFocus());
    await user.keyboard("cjz keep the width{Enter}");

    expect(page.onComplete).not.toHaveBeenCalled();
    expect(page.onSendBack).toHaveBeenCalledWith(first, "cjz keep the width");
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: /Follow-up for/ })).toBeNull(),
    );
    expect(within(current()).getByRole("heading", { name: "Fix the sidebar clip" })).toBeVisible();
  });

  it("cancels a follow-up with Escape and keeps it when the host refuses it", async () => {
    const user = userEvent.setup();
    const onSendBack = vi.fn(async () => ({
      status: "refused" as const,
      message: "A turn is already running on this thread.",
    }));
    render(<ReviewPage {...props({ onSendBack })} />);

    await user.keyboard("s");
    const field = await screen.findByRole("textbox", { name: /Follow-up for/ });
    await user.keyboard("try again{Enter}");
    expect(await within(current()).findByRole("alert")).toHaveTextContent(
      "A turn is already running on this thread.",
    );
    expect(field).toHaveValue("try again");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: /Follow-up for/ })).toBeNull();
  });

  it("snoozes with Z through the existing wake-time choices", async () => {
    const user = userEvent.setup();
    const page = props();
    render(<ReviewPage {...page} />);

    await user.keyboard("z");
    const tomorrow = resolveSnoozePresets(new Date(NOW)).find((preset) => preset.id === "tomorrow");
    await user.click(await screen.findByRole("button", { name: /Tomorrow/ }));

    expect(page.onSnooze).toHaveBeenCalledWith(first, tomorrow?.until);
  });

  it("moves to the next thread when the selected one is completed elsewhere", async () => {
    const user = userEvent.setup();
    const page = props();
    const view = render(<ReviewPage {...page} />);
    await user.keyboard("j");
    expect(within(current()).getByRole("heading", { name: "Add the export route" })).toBeVisible();

    view.rerender(<ReviewPage {...page} entries={[third, first]} />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "To review · 2 finished threads",
    );
    expect(
      within(current()).getByRole("heading", { name: "Tidy the settings copy" }),
    ).toBeVisible();
    view.rerender(<ReviewPage {...page} entries={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("Nothing waiting for review");
  });

  it("keeps the selected thread when board facts re-sort the list after the first paint", async () => {
    const source = makeSource({
      loadFacts: vi.fn(async (entries: ReadonlyArray<ReviewEntry>) => {
        // The first thread's turn ended after the second's, which the thread
        // records alone could not say.
        const byKey = new Map<string, ReviewFacts>();
        for (const item of entries) {
          byKey.set(
            `${item.mode}:${item.threadId}`,
            facts({
              finishedAt: item.threadId === "t1" ? "2026-10-06T11:30:00Z" : "2026-10-06T10:00:00Z",
            }),
          );
        }
        return byKey;
      }),
    });
    render(<ReviewPage {...props({ entries: [first, second], source })} />);

    await waitFor(() => {
      const titles = within(screen.getByRole("navigation", { name: "Finished threads" }))
        .getAllByRole("button")
        .map((row) => row.querySelector(".review-row__title")?.textContent);
      expect(titles).toEqual(["Add the export route", "Fix the sidebar clip"]);
    });
    expect(within(current()).getByRole("heading", { name: "Fix the sidebar clip" })).toBeVisible();
    await waitFor(() => expect(screen.getByText("Reply for Fix the sidebar clip")).toBeVisible());
    // Moving the list under the selection must not read the thread again.
    expect(source.loadReply).toHaveBeenCalledTimes(1);
  });

  it("lists a thread with no board facts by its title and Project alone", async () => {
    const source = makeSource({
      loadFacts: vi.fn(async () => {
        throw new Error("board unavailable");
      }),
      loadDiff: vi.fn(async () => undefined),
      loadOctantCheck: vi.fn(async () => undefined),
    });
    render(<ReviewPage {...props({ source })} />);

    const row = within(screen.getByRole("navigation", { name: "Finished threads" })).getAllByRole(
      "button",
    )[0];
    await waitFor(() => expect(source.loadFacts).toHaveBeenCalled());
    expect(row).toHaveTextContent("Octant");
    expect(row).not.toHaveTextContent("files");
    expect(await screen.findByText("Reply for Fix the sidebar clip")).toBeVisible();
  });

  it("says when the changes cannot be read instead of leaving the section blank", async () => {
    const source = makeSource({
      loadDiff: vi.fn(async () => ({
        status: "unavailable" as const,
        message: "The checkout is not available right now.",
      })),
    });
    render(<ReviewPage {...props({ source })} />);

    expect(await screen.findByText("The checkout is not available right now.")).toBeVisible();
  });
});
