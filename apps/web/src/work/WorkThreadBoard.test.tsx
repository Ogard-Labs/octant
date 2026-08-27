import type { WorkBoardCard, WorkBoardStatus, WorkBoardView } from "@octant/contracts";
import type { ProjectId } from "@octant/contracts/projects";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkThreadBoard } from "./WorkThreadBoard";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stylesCss = readFileSync(resolve(srcDir, "styles.css"), "utf-8");
const octantCss = readFileSync(resolve(srcDir, "styles/octant.css"), "utf-8");

const projectA = "00000000-0000-4000-8000-0000000060a1" as ProjectId;
const projectB = "00000000-0000-4000-8000-0000000060a2" as ProjectId;

function card(overrides: {
  readonly id: string;
  readonly status: WorkBoardStatus;
  readonly title?: string;
  readonly projectId?: ProjectId;
  readonly recovering?: boolean;
  readonly followUp?: boolean;
  readonly activeRuns?: number;
  readonly blockingReason?: string;
  readonly lastMeaningfulActivityAt?: WorkBoardCard["lastMeaningfulActivityAt"];
}): WorkBoardCard {
  return {
    threadId: `00000000-0000-4000-8000-0000000061${overrides.id}`,
    projectId: overrides.projectId ?? projectA,
    title: overrides.title ?? `Thread ${overrides.id}`,
    status: overrides.status,
    statusReason:
      overrides.status === "done"
        ? "delivery-satisfied"
        : overrides.status === "in-progress"
          ? "executing"
          : overrides.status === "waiting"
            ? overrides.recovering
              ? "recovering"
              : "awaiting-input"
            : "idle-unmet-delivery",
    deliveryTarget: overrides.title ?? `Thread ${overrides.id}`,
    deliverySatisfaction: overrides.status === "done" ? "done" : "pending",
    providerInstanceId: "00000000-0000-4000-8000-0000000060fe",
    modelId: "model-a",
    executing: overrides.status === "in-progress",
    binding: { kind: "bound", workingDirectory: "." },
    activeRequest: { kind: "none" },
    artifacts: { count: 0 },
    citations: { count: 0, staleCount: 0 },
    goal: { kind: "none" },
    childRuns: {
      active: overrides.activeRuns ?? 0,
      completed: 0,
      failed: 0,
      unacknowledgedResults: 0,
    },
    pullRequestSummaries: { items: [], hiddenCount: 0 },
    recovery: overrides.recovering
      ? { kind: "recovering", reasons: ["project-projection-missing"] }
      : { kind: "ok" },
    staleEvidence: false,
    ...(overrides.blockingReason === undefined ? {} : { blockingReason: overrides.blockingReason }),
    followUp: overrides.followUp ?? false,
    lastMeaningfulActivityAt: overrides.lastMeaningfulActivityAt ?? null,
  } as unknown as WorkBoardCard;
}

function view(
  cards: readonly WorkBoardCard[],
  statuses?: readonly WorkBoardStatus[],
): WorkBoardView {
  return {
    version: 1,
    query: statuses === undefined ? { version: 1 } : { version: 1, statuses: [...statuses] },
    cards: [...cards],
    generatedAt: "2026-07-22T10:00:00.000Z",
  } as unknown as WorkBoardView;
}

const projects = [
  { id: projectA, name: "Project A" },
  { id: projectB, name: "Project B" },
];

function cardFor(title: string): HTMLElement {
  const article = screen.getByRole("button", { name: title }).closest("article");
  if (article === null) throw new Error(`Expected a board card for ${title}`);
  return article;
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe("WorkThreadBoard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("overlays client unread without reading unread from the server card", async () => {
    const loadBoard = vi.fn(async () =>
      view([
        card({ id: "01", status: "ready", title: "Unread thread" }),
        card({ id: "02", status: "ready", title: "Read thread" }),
      ]),
    );
    render(
      <WorkThreadBoard
        loadBoard={loadBoard}
        onOpenThread={() => undefined}
        projects={projects}
        storage={memoryStorage()}
        unreadThreadIds={new Set(["00000000-0000-4000-8000-000000006101"])}
      />,
    );

    await screen.findByRole("button", { name: "Unread thread" });
    expect(within(cardFor("Unread thread")).getByText("Unread")).toHaveClass("sr-only");
    expect(cardFor("Unread thread").querySelector(".unread")).toBeNull();
    expect(within(cardFor("Read thread")).queryByText("Unread")).toBeNull();
  });

  it("renders every Status column by default, including empty ones, and opens a thread", async () => {
    const loadBoard = vi.fn(async () =>
      view([
        card({ id: "01", status: "ready", title: "Ready thread" }),
        card({ id: "02", status: "done", title: "Done thread" }),
      ]),
    );
    const onOpenThread = vi.fn();
    render(
      <WorkThreadBoard
        loadBoard={loadBoard}
        onOpenThread={onOpenThread}
        projects={projects}
        storage={memoryStorage()}
      />,
    );

    await screen.findByRole("button", { name: "Ready thread" });
    expect(
      screen
        .getAllByRole("region", { name: /\(\d+\)$/ })
        .map((column) => column.getAttribute("aria-label")),
    ).toEqual(["Ready (1)", "In Progress (0)", "Waiting (0)", "Done (1)"]);
    expect(cardFor("Ready thread").getAttribute("draggable")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ready thread" }));
    expect(onOpenThread).toHaveBeenCalledWith({
      threadId: "00000000-0000-4000-8000-000000006101",
      projectId: projectA,
    });
  });

  it("keeps a recovering thread in Waiting with its specific reason visible", async () => {
    const loadBoard = vi.fn(async () =>
      view([card({ id: "01", status: "waiting", title: "Recovering thread", recovering: true })]),
    );
    render(<WorkThreadBoard loadBoard={loadBoard} projects={projects} storage={memoryStorage()} />);

    const waiting = await screen.findByRole("region", { name: "Waiting (1)" });
    expect(within(waiting).getByText("Recovering thread")).toBeVisible();
    expect(within(waiting).getByText(/Project projection missing/)).toBeVisible();
  });

  it("keeps a specific Waiting reason visible in the narrow grouped list", async () => {
    const loadBoard = vi.fn(async () =>
      view([
        card({
          id: "01",
          status: "waiting",
          title: "Blocked thread",
          blockingReason: "Runtime work is waiting for a decision or input.",
        }),
      ]),
    );
    render(
      <WorkThreadBoard
        isNarrow
        loadBoard={loadBoard}
        projects={projects}
        storage={memoryStorage()}
      />,
    );

    expect(await screen.findByText("Blocked thread")).toBeVisible();
    expect(screen.getByText("Runtime work is waiting for a decision or input.")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Ready (0)" })?.className).toContain(
      "code-board__list-group",
    );
  });

  it("preserves the last useful view while refreshing and after a later failure", async () => {
    let resolveBoard: ((value: WorkBoardView) => void) | undefined;
    const loadBoard = vi
      .fn()
      .mockImplementationOnce(async () =>
        view([card({ id: "01", status: "ready", title: "Kept" })]),
      )
      .mockImplementationOnce(
        () =>
          new Promise<WorkBoardView>((resolve) => {
            resolveBoard = resolve;
          }),
      )
      .mockImplementationOnce(async () => {
        throw new Error("The host could not refresh the board.");
      });
    render(<WorkThreadBoard loadBoard={loadBoard} projects={projects} storage={memoryStorage()} />);

    expect(await screen.findByText("Kept")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Refresh board" }));
    expect(await screen.findByText("Refreshing local board state.")).toBeVisible();
    expect(screen.getByText("Kept")).toBeVisible();
    resolveBoard?.(view([card({ id: "01", status: "ready", title: "Kept" })]));
    await waitFor(() => expect(screen.queryByText("Refreshing local board state.")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Refresh board" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The host could not refresh the board. Showing the last useful view.",
    );
    expect(screen.getByText("Kept")).toBeVisible();
  });

  it("shows Project, confined root binding, request, artifacts, citations, goal, delivery, child runs, follow-up, recovery, and activity", async () => {
    const loadBoard = vi.fn(async () =>
      view([
        {
          ...card({
            id: "01",
            status: "waiting",
            title: "Full card",
            recovering: true,
            followUp: true,
            activeRuns: 1,
            lastMeaningfulActivityAt:
              "2026-07-22T10:00:00.000Z" as WorkBoardCard["lastMeaningfulActivityAt"],
          }),
          binding: {
            kind: "bound",
            workingDirectory: "research/brief",
          },
          activeRequest: {
            kind: "pending",
            requestKind: "approval",
            summary: "Write the export",
          },
          artifacts: { count: 2, latestDisplayName: "Brief.md" },
          citations: { count: 3, staleCount: 1 },
          goal: { kind: "present", status: "active", objective: "Finish the brief" },
          staleEvidence: true,
          childRuns: {
            active: 1,
            completed: 0,
            failed: 0,
            unacknowledgedResults: 0,
            latestSummary: "Drafting the export outline",
          },
        } as WorkBoardCard,
      ]),
    );
    render(
      <WorkThreadBoard
        loadBoard={loadBoard}
        projects={projects}
        providerLabels={new Map([["00000000-0000-4000-8000-0000000060fe", "Studio"]])}
        storage={memoryStorage()}
      />,
    );

    await screen.findByRole("button", { name: "Full card" });
    const article = cardFor("Full card");
    expect(article).toHaveTextContent("Drafting the export outline");
    const facts = article.querySelector(".board-card-facts");
    if (facts === null) throw new Error("Expected card facts");
    expect(facts).toHaveTextContent("Project A");
    expect(facts).toHaveTextContent("research/brief");
    expect(facts).toHaveTextContent("Studio · model-a");
    expect(facts).toHaveTextContent("Approval: Write the export");
    expect(facts).toHaveTextContent("Brief.md");
    expect(facts).toHaveTextContent("3 citations · stale");
    expect(facts).toHaveTextContent("Goal · active");
    expect(facts).toHaveTextContent("Full card · pending");
    expect(facts).toHaveTextContent("1 active run");
    expect(facts).toHaveTextContent("Follow-up");
    expect(facts).toHaveTextContent("Stale evidence");
    expect(within(article).getByText(/Project projection missing/)).toBeVisible();
  });

  it("switches to Project grouping without issuing another board query", async () => {
    const loadBoard = vi.fn(async () =>
      view([
        card({ id: "01", status: "ready", projectId: projectA, title: "A thread" }),
        card({ id: "02", status: "waiting", projectId: projectB, title: "B thread" }),
      ]),
    );
    render(<WorkThreadBoard loadBoard={loadBoard} projects={projects} storage={memoryStorage()} />);

    await screen.findByRole("region", { name: "Ready (1)" });
    expect(loadBoard).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    expect(await screen.findByRole("region", { name: "Project A (1)" })).toBeVisible();
    expect(loadBoard).toHaveBeenCalledTimes(1);
  });

  it("hides empty groups from the View popover and remembers the preference", async () => {
    const loadBoard = vi.fn(async () => view([card({ id: "01", status: "ready" })]));
    const storage = memoryStorage();
    const first = render(
      <WorkThreadBoard loadBoard={loadBoard} projects={projects} storage={storage} />,
    );

    await screen.findByText("Thread 01");
    expect(screen.getByRole("region", { name: "Done (0)" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Show empty groups" }));
    expect(screen.queryByRole("region", { name: "Done (0)" })).not.toBeInTheDocument();
    first.unmount();

    render(<WorkThreadBoard loadBoard={loadBoard} projects={projects} storage={storage} />);
    await screen.findByText("Thread 01");
    expect(screen.queryByRole("region", { name: "Done (0)" })).not.toBeInTheDocument();
  });

  it("explains active filters on an empty result without implying deletion", async () => {
    const loadBoard = vi.fn(async () => view([]));
    render(<WorkThreadBoard loadBoard={loadBoard} projects={projects} storage={memoryStorage()} />);

    const message = await screen.findByText("No Work threads match the current filters.");
    const empty = message.closest("[role='status']");
    expect(empty).not.toBeNull();
    expect(empty).toHaveTextContent("No threads were deleted or completed");
    for (const column of ["Ready (0)", "In Progress (0)", "Waiting (0)", "Done (0)"]) {
      expect(screen.getByRole("region", { name: column })).toBeVisible();
    }
  });

  it("renders a recoverable error state when the first board query fails", async () => {
    const loadBoard = vi.fn(async () => {
      throw new Error("Work Thread Board is unavailable.");
    });
    render(<WorkThreadBoard loadBoard={loadBoard} projects={projects} storage={memoryStorage()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Work Thread Board is unavailable.");
  });

  it("renders status columns at a fixed width so they do not stretch to fill the workspace", async () => {
    expect(stylesCss).toMatch(/\.code-board\s+\.board-col\s*\{[^}]*max-width:\s*320px[^}]*\}/s);
    expect(stylesCss).toMatch(/\.code-board\s+\.board-col\s*\{[^}]*min-width:\s*220px[^}]*\}/s);
    expect(octantCss).toMatch(/\.board-col\s*\{[^}]*max-width:\s*320px[^}]*\}/s);
    expect(octantCss).toMatch(/\.board-col\s*\{[^}]*min-width:\s*220px[^}]*\}/s);

    const loadBoard = vi.fn(async () =>
      view([
        card({ id: "01", status: "ready", title: "Ready thread" }),
        card({ id: "02", status: "done", title: "Done thread" }),
      ]),
    );
    render(<WorkThreadBoard loadBoard={loadBoard} projects={projects} storage={memoryStorage()} />);

    await screen.findByRole("button", { name: "Ready thread" });
    const columns = screen.getAllByRole("region", { name: /\(\d+\)$/ });
    expect(columns).toHaveLength(4);
    for (const column of columns) {
      expect(column.className).toContain("board-col");
    }
  });

  it("keeps the board body horizontally scrollable instead of overflowing the page", async () => {
    expect(stylesCss).toMatch(/\.code-board__body\s*\{[^}]*overflow-x:\s*auto[^}]*\}/s);
    expect(stylesCss).toMatch(/\.code-board__body\s*\{[^}]*overflow-y:\s*hidden[^}]*\}/s);

    const loadBoard = vi.fn(async () =>
      view([card({ id: "01", status: "ready", title: "Ready thread" })]),
    );
    render(<WorkThreadBoard loadBoard={loadBoard} projects={projects} storage={memoryStorage()} />);

    const column = await screen.findByRole("region", { name: "Ready (1)" });
    const body = column.closest(".code-board__body");
    expect(body).not.toBeNull();
    if (body === null) throw new Error("Expected board body");
    expect(body.className).toContain("code-board__body");
  });

  it("truncates long card titles and wraps facts instead of letting metadata overlap", async () => {
    expect(octantCss).toMatch(/\.board-card-title\s*\{[^}]*overflow:\s*hidden[^}]*\}/s);
    expect(octantCss).toMatch(/\.board-card-title\s*\{[^}]*-webkit-line-clamp:\s*2[^}]*\}/s);
    expect(octantCss).toMatch(/\.board-card-facts\s*\{[^}]*flex-wrap:\s*wrap[^}]*\}/s);
    expect(stylesCss).toMatch(
      /\.code-board__card-open\s*\{[^}]*justify-content:\s*flex-start[^}]*text-align:\s*left[^}]*\}/s,
    );

    const longTitle = "A very long thread title that would otherwise push metadata out of the card";
    const loadBoard = vi.fn(async () =>
      view([
        {
          ...card({ id: "01", status: "waiting", title: longTitle }),
          deliveryTarget: "delivery-target",
        },
      ]),
    );
    render(<WorkThreadBoard loadBoard={loadBoard} projects={projects} storage={memoryStorage()} />);

    await screen.findByRole("button", { name: longTitle });
    const article = cardFor(longTitle);
    expect(article.querySelector(".board-card-title")).not.toBeNull();
    expect(article.querySelector(".board-card-facts")).not.toBeNull();
  });

  it("renders empty status columns at the same width as populated columns", async () => {
    expect(octantCss).toMatch(
      /\.board-col\[data-empty="true"\]\s*\{[^}]*max-width:\s*320px[^}]*\}/s,
    );
    expect(octantCss).toMatch(
      /\.board-col\[data-empty="true"\]\s*\{[^}]*min-width:\s*220px[^}]*\}/s,
    );

    const loadBoard = vi.fn(async () =>
      view([card({ id: "01", status: "ready", title: "Ready thread" })]),
    );
    render(<WorkThreadBoard loadBoard={loadBoard} projects={projects} storage={memoryStorage()} />);

    const ready = await screen.findByRole("region", { name: "Ready (1)" });
    const waiting = screen.getByRole("region", { name: "Waiting (0)" });
    expect(ready.className).toContain("board-col");
    expect(waiting.className).toContain("board-col");
    expect(waiting.getAttribute("data-empty")).toBe("true");
  });

  it("renders the narrow view as a vertically stacked list without kanban columns", async () => {
    const loadBoard = vi.fn(async () =>
      view([card({ id: "01", status: "ready", title: "Narrow thread" })]),
    );
    render(
      <WorkThreadBoard
        isNarrow
        loadBoard={loadBoard}
        projects={projects}
        storage={memoryStorage()}
      />,
    );

    await screen.findByText("Narrow thread");
    const listGroup = screen.getByRole("region", { name: "Ready (1)" });
    expect(listGroup.className).toContain("code-board__list-group");
    expect(document.querySelector(".board-col")).toBeNull();
  });
});
