import type { WorkBoardCard, WorkBoardStatus, WorkBoardView } from "@octant/contracts";
import type { ProjectId } from "@octant/contracts/projects";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerClients,
  boardPendingSource,
  codeRequest,
  pendingReader,
  workRequest,
} from "../threadBoard/boardPendingRequests.test-fixtures";
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
    ).toEqual(["Ready (1)", "In progress (0)", "Waiting (0)", "Done (1)"]);
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
          blockingReason: "Waiting for a decision or answer.",
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
    expect(screen.getByText("Waiting for a decision or answer.")).toBeVisible();
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

  it("shows the latest child-run line live under an executing task's title, or Working… before one reports", async () => {
    const reporting = card({ id: "01", status: "in-progress", title: "Reporting task" });
    const loadBoard = vi.fn(async () =>
      view([
        {
          ...reporting,
          childRuns: { ...reporting.childRuns, latestSummary: "Reading the sources" },
        },
        card({ id: "02", status: "in-progress", title: "Silent task" }),
        card({ id: "03", status: "ready", title: "Idle task" }),
      ]),
    );
    render(<WorkThreadBoard loadBoard={loadBoard} projects={projects} storage={memoryStorage()} />);

    await screen.findByRole("button", { name: "Reporting task" });
    expect(cardFor("Reporting task").querySelector(".board-card-live")).toHaveTextContent(
      "Reading the sources",
    );
    expect(cardFor("Silent task").querySelector(".board-card-live")).toHaveTextContent("Working…");
    expect(cardFor("Idle task").querySelector(".board-card-live")).toBeNull();
    expect(
      screen.getByRole("region", { name: "In progress (2)" }).querySelector(".board-status-mark"),
    ).toHaveAttribute("data-executing", "true");
  });

  it("keeps the card face to what needs the person, who runs it, and when it moved; the rest waits for the list view", async () => {
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
    // The Project is the card's eyebrow, the latest child-run line its
    // activity; both stay off the facts line.
    expect(article).toHaveTextContent("Project A");
    expect(article).toHaveTextContent("Drafting the export outline");
    const facts = article.querySelector(".board-card-facts");
    if (facts === null) throw new Error("Expected card facts");
    expect(facts).toHaveTextContent(/Project projection missing/);
    expect(facts).toHaveTextContent("Approval: Write the export");
    expect(facts).toHaveTextContent("Follow-up");
    expect(facts).toHaveTextContent("Recovering");
    expect(facts).toHaveTextContent("Goal · active");
    // Who runs the task and when it moved sit in the footer, not the facts.
    const meta = article.querySelector(".board-card-meta");
    if (meta === null) throw new Error("Expected the card footer");
    expect(meta).toHaveTextContent("Studio");
    expect(meta.querySelector(".board-card-meta__age")).toHaveTextContent(/\d+d ago/);
    expect(meta.querySelector(".board-card-meta__branch")).toBeNull();
    expect(meta.querySelector(".board-card-meta__diff")).toBeNull();
    // Folder, model, artifacts, citations, and delivery wait for the list view.
    expect(facts).not.toHaveTextContent("research/brief");
    expect(facts).not.toHaveTextContent("model-a");
    expect(facts).not.toHaveTextContent("Brief.md");
    expect(facts).not.toHaveTextContent("3 citations");
    expect(facts).not.toHaveTextContent("Full card · pending");
    expect(article.querySelector(".code-board__card-details")).toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(await screen.findByRole("button", { name: "Project" }));
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

  it("keeps every column on an empty board with a quiet line instead of a raised card", async () => {
    const loadBoard = vi.fn(async () => view([]));
    render(<WorkThreadBoard loadBoard={loadBoard} projects={projects} storage={memoryStorage()} />);

    const message = await screen.findByText("No tasks yet");
    const empty = message.closest("[role='status']");
    expect(empty).not.toBeNull();
    expect(empty).not.toHaveAttribute("data-slot");
    expect(empty).toHaveTextContent("Create a task to see it here.");
    expect(empty).not.toHaveTextContent("adjust the filters");
    for (const column of ["Ready (0)", "In progress (0)", "Waiting (0)", "Done (0)"]) {
      const region = screen.getByRole("region", { name: column });
      expect(region).toBeVisible();
      expect(within(region).getByRole("status")).toHaveClass("surface-empty");
    }
  });

  it("renders a recoverable error state when the first board query fails", async () => {
    const loadBoard = vi.fn(async () => {
      throw new Error("The task board is unavailable.");
    });
    render(<WorkThreadBoard loadBoard={loadBoard} projects={projects} storage={memoryStorage()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("The task board is unavailable.");
  });

  it("lays the four status columns out as an equal-width grid that fits the board", async () => {
    expect(octantCss).toMatch(
      /\.board\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)[^}]*\}/s,
    );
    expect(octantCss).not.toMatch(/\.board-col\s*\{[^}]*max-width:\s*\d+px/s);

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
    expect(stylesCss).not.toMatch(/\.code-board__body\s*\{[^}]*overflow-y:\s*hidden[^}]*\}/s);
    expect(octantCss).toMatch(/\.board\s*\{[^}]*overflow:\s*visible[^}]*\}/s);
    // Under ~1100px the columns keep a readable width and the body scrolls.
    expect(octantCss).toMatch(
      /@media \(max-width: 1100px\)\s*\{\s*\.board\s*\{[^}]*minmax\(240px, 1fr\)/s,
    );

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
    expect(octantCss).toMatch(/\.board-card\s*\{[^}]*border:\s*1px solid var\(--oct-border\)/s);
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

  it("keeps an empty status column in the grid with a quiet empty line inside it", async () => {
    const loadBoard = vi.fn(async () =>
      view([card({ id: "01", status: "ready", title: "Ready thread" })]),
    );
    render(<WorkThreadBoard loadBoard={loadBoard} projects={projects} storage={memoryStorage()} />);

    const ready = await screen.findByRole("region", { name: "Ready (1)" });
    const waiting = screen.getByRole("region", { name: "Waiting (0)" });
    expect(ready.className).toContain("board-col");
    expect(waiting.className).toContain("board-col");
    expect(waiting.getAttribute("data-empty")).toBe("true");
    expect(within(waiting).getByRole("status")).toHaveClass("surface-empty");
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

describe("WorkThreadBoard waiting cards", () => {
  const threadOne = "00000000-0000-4000-8000-000000006101";
  const threadTwo = "00000000-0000-4000-8000-000000006102";
  const threadThree = "00000000-0000-4000-8000-000000006103";

  const approval = workRequest({
    threadId: threadOne,
    threadTitle: "Quarterly notes",
    kind: "approval",
    text: "Delete: old-draft.md",
    minutesAgo: 4,
  });
  const question = workRequest({
    threadId: threadTwo,
    threadTitle: "Pick a format",
    kind: "question",
    text: "Which format should the report use?",
    minutesAgo: 9,
    options: [{ label: "PDF" }, { label: "Markdown" }],
  });

  function renderBoard(
    cards: readonly WorkBoardCard[],
    pendingRequests: ReturnType<typeof boardPendingSource> | undefined,
    options: {
      readonly isNarrow?: boolean;
      readonly loadBoard?: () => Promise<WorkBoardView>;
    } = {},
  ) {
    const loadBoard = vi.fn(options.loadBoard ?? (async () => view(cards)));
    const onOpenThread = vi.fn();
    render(
      <WorkThreadBoard
        {...(options.isNarrow === true ? { isNarrow: true } : {})}
        loadBoard={loadBoard}
        onOpenThread={onOpenThread}
        {...(pendingRequests === undefined ? {} : { pendingRequests })}
        projects={projects}
        storage={memoryStorage()}
      />,
    );
    return { loadBoard, onOpenThread };
  }

  it("answers a waiting task's approval from its card with the listed handle", async () => {
    const clients = answerClients();
    renderBoard(
      [card({ id: "01", status: "waiting", title: "Quarterly notes" })],
      boardPendingSource(pendingReader([approval]), clients),
    );

    const waiting = await screen.findByRole("region", { name: "Waiting (1)" });
    expect(await within(waiting).findByText("Delete: old-draft.md")).toBeVisible();
    expect(within(waiting).getByText("Waiting 4m")).toBeVisible();
    fireEvent.click(within(waiting).getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(clients.workRequestClient.execute).toHaveBeenCalledWith({
        kind: "resolve-work-request",
        requestId: `request-${threadOne}`,
        expectedVersion: 7,
        resolution: { kind: "approval", approved: true },
      }),
    );
  });

  it("denies an approval and picks a numbered choice on the card that asked", async () => {
    const clients = answerClients();
    renderBoard(
      [
        card({ id: "01", status: "waiting", title: "Quarterly notes" }),
        card({ id: "02", status: "waiting", title: "Pick a format" }),
      ],
      boardPendingSource(pendingReader([approval, question]), clients),
    );

    const notes = await screen.findByRole("group", { name: "Quarterly notes is waiting for you" });
    fireEvent.click(within(notes).getByRole("button", { name: "Deny" }));
    await waitFor(() =>
      expect(clients.workRequestClient.execute).toHaveBeenCalledWith(
        expect.objectContaining({ resolution: { kind: "approval", approved: false } }),
      ),
    );

    const format = screen.getByRole("group", { name: "Pick a format is waiting for you" });
    fireEvent.click(within(format).getByRole("button", { name: /Markdown/ }));
    await waitFor(() =>
      expect(clients.workRequestClient.execute).toHaveBeenCalledWith({
        kind: "resolve-work-request",
        requestId: `request-${threadTwo}`,
        expectedVersion: 7,
        resolution: { kind: "user-input", answer: "Markdown" },
      }),
    );
  });

  it("opens the thread from Reply… and from +N more waiting, showing only the oldest request", async () => {
    const newer = workRequest({
      threadId: threadTwo,
      threadTitle: "Pick a format",
      kind: "question",
      text: "And which paper size?",
      minutesAgo: 1,
      requestId: "request-newer",
    });
    const { onOpenThread } = renderBoard(
      [card({ id: "02", status: "waiting", title: "Pick a format" })],
      boardPendingSource(pendingReader([newer, question])),
    );

    const format = await screen.findByRole("group", { name: "Pick a format is waiting for you" });
    expect(within(format).getByText("Which format should the report use?")).toBeVisible();
    expect(within(format).queryByText("And which paper size?")).toBeNull();

    fireEvent.click(within(format).getByRole("button", { name: "Reply…" }));
    expect(onOpenThread).toHaveBeenLastCalledWith({
      threadId: threadTwo,
      projectId: projectA,
    });
    fireEvent.click(screen.getByRole("button", { name: "+1 more waiting" }));
    expect(onOpenThread).toHaveBeenCalledTimes(2);
  });

  it("says once on the card that a refused answer was not delivered, and leaves the card in its column", async () => {
    const clients = answerClients();
    clients.workRequestClient.execute.mockRejectedValue(new Error("stale"));
    const { loadBoard } = renderBoard(
      [card({ id: "01", status: "waiting", title: "Quarterly notes" })],
      boardPendingSource(pendingReader([approval]), clients),
    );

    const waiting = await screen.findByRole("region", { name: "Waiting (1)" });
    fireEvent.click(await within(waiting).findByRole("button", { name: "Approve" }));

    expect(await within(waiting).findByRole("status")).toHaveTextContent(
      "The answer was not delivered.",
    );
    expect(screen.getByRole("region", { name: "Waiting (1)" })).toBe(waiting);
    expect(loadBoard).toHaveBeenCalledTimes(1);
  });

  it("moves the card when the host's next board read says so, not when it is answered", async () => {
    const clients = answerClients();
    let boardReads = 0;
    renderBoard([], boardPendingSource(pendingReader([approval], []), clients), {
      loadBoard: async () => {
        boardReads += 1;
        return view([
          card({
            id: "01",
            status: boardReads === 1 ? "waiting" : "in-progress",
            title: "Quarterly notes",
          }),
        ]);
      },
    });

    const waiting = await screen.findByRole("region", { name: "Waiting (1)" });
    fireEvent.click(await within(waiting).findByRole("button", { name: "Approve" }));

    expect(await screen.findByRole("region", { name: "In progress (1)" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Waiting (0)" })).toBeVisible();
    expect(boardReads).toBe(2);
  });

  it("lists the waiting column oldest request first, and a card with no request after them", async () => {
    renderBoard(
      [
        card({
          id: "03",
          status: "waiting",
          title: "Recent but no request",
          lastMeaningfulActivityAt: "2026-10-06T09:59:00.000Z" as never,
        }),
        card({
          id: "01",
          status: "waiting",
          title: "Quarterly notes",
          lastMeaningfulActivityAt: "2026-10-06T09:58:00.000Z" as never,
        }),
        card({
          id: "02",
          status: "waiting",
          title: "Pick a format",
          lastMeaningfulActivityAt: "2026-10-06T09:57:00.000Z" as never,
        }),
      ],
      boardPendingSource(pendingReader([approval, question])),
    );

    const waiting = await screen.findByRole("region", { name: "Waiting (3)" });
    await within(waiting).findByText("Delete: old-draft.md");
    const titles = within(waiting)
      .getAllByRole("button", { name: /^(Recent but no request|Quarterly notes|Pick a format)$/ })
      .map((button) => button.textContent);
    expect(titles).toEqual(["Pick a format", "Quarterly notes", "Recent but no request"]);
  });

  it("gives the narrow list the same answer buttons", async () => {
    renderBoard(
      [card({ id: "01", status: "waiting", title: "Quarterly notes" })],
      boardPendingSource(pendingReader([approval])),
      { isNarrow: true },
    );

    const waiting = await screen.findByRole("region", { name: "Waiting (1)" });
    expect(waiting.className).toContain("code-board__list-group");
    expect(await within(waiting).findByRole("button", { name: "Approve" })).toBeVisible();
    expect(within(waiting).getByRole("button", { name: "Deny" })).toBeVisible();
  });

  it("shows the question on a card the board files elsewhere when the host lists one for its thread", async () => {
    renderBoard(
      [
        card({ id: "01", status: "in-progress", title: "Quarterly notes" }),
        card({ id: "02", status: "ready", title: "Pick a format" }),
      ],
      boardPendingSource(pendingReader([approval])),
    );

    const running = await screen.findByRole("region", { name: "In progress (1)" });
    expect(await within(running).findByRole("button", { name: "Approve" })).toBeVisible();
    const ready = screen.getByRole("region", { name: "Ready (1)" });
    expect(within(ready).queryByRole("group")).toBeNull();
  });

  it("leaves a Chat or Code request off a Work card", async () => {
    const codeApproval = codeRequest({
      threadId: threadThree,
      threadTitle: "Fix the build",
      kind: "approval",
      text: "Run: bun run test",
      minutesAgo: 3,
    });
    const reader = pendingReader([codeApproval]);
    renderBoard(
      [card({ id: "03", status: "waiting", title: "Fix the build" })],
      boardPendingSource(reader),
    );

    await screen.findByRole("button", { name: "Fix the build" });
    await waitFor(() => expect(reader.list).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("looks exactly as it did when the window has no pending-request reader", async () => {
    const waitingCard = {
      ...card({ id: "01", status: "waiting", title: "Quarterly notes" }),
      activeRequest: { kind: "pending", requestKind: "approval", summary: "Delete old-draft.md" },
    } as unknown as WorkBoardCard;
    renderBoard([waitingCard], boardPendingSource(undefined));

    const waiting = await screen.findByRole("region", { name: "Waiting (1)" });
    expect(await within(waiting).findByText("Approval: Delete old-draft.md")).toBeVisible();
    expect(within(waiting).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(waiting).queryByRole("group")).toBeNull();
  });

  it("drops a waiting card's summary line once its question is drawn in full", async () => {
    const waitingCard = {
      ...card({ id: "01", status: "waiting", title: "Quarterly notes" }),
      activeRequest: { kind: "pending", requestKind: "approval", summary: "Delete old-draft.md" },
    } as unknown as WorkBoardCard;
    renderBoard([waitingCard], boardPendingSource(pendingReader([approval])));

    const waiting = await screen.findByRole("region", { name: "Waiting (1)" });
    expect(await within(waiting).findByRole("button", { name: "Approve" })).toBeVisible();
    expect(within(waiting).queryByText("Approval: Delete old-draft.md")).toBeNull();
  });
});
