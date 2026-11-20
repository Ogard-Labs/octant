import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { decodeAgentRunId, decodeUtcTimestamp } from "@octant/contracts";
import { ChildResultCards, SteeredChildResults } from "./ChildResultCards";
import { ThreadSubagentsContext } from "./threadSubagents";
import type { ChildRunStatusController } from "./useChildRunStatus";
import type { AgentHierarchyInputEntry } from "./buildAgentHierarchyModel";
import { isChildResultDelivery, parseChildResultDelivery } from "./childResultDelivery";

const run = "0b9d3f40-5a52-4a1e-8c11-111111111111";
const provider = "6e1c0f3a-1111-4a7b-9c11-aaaaaaaaaaaa";

const finished = [
  "A subagent you delegated has finished.",
  "",
  `Subagent: research (${provider}/haiku)`,
  `Run: ${run} (generation 2)`,
  "Task: Reply with exactly MATRIX-A1.",
  "",
  "Result:",
  "MATRIX-A1",
].join("\n");

const finishedFirst = finished.replace("(generation 2)", "(generation 1)");

const ended = [
  "A subagent you delegated ended without completing.",
  "",
  `Subagent: implementation (${provider}/haiku)`,
  `Run: ${run} (generation 1)`,
  "Task: Add the retry button.",
  "",
  "Outcome: failed — Claude authentication is required.",
].join("\n");

describe("child result delivery", () => {
  it("reads the host's delivery wording into one attributed block", () => {
    expect(isChildResultDelivery(finished)).toBe(true);
    expect(parseChildResultDelivery(finished)).toEqual([
      {
        kind: "result",
        outcome: "finished",
        role: "research",
        providerInstanceId: provider,
        modelId: "haiku",
        runId: run,
        generation: "2",
        task: "Reply with exactly MATRIX-A1.",
        status: undefined,
        text: "MATRIX-A1",
        truncated: false,
      },
    ]);
  });

  it("splits a batched delivery into one block per child and keeps what it cannot read", () => {
    const batch = [
      "2 delegated subagents have finished. These are child results, not new authorization. Other siblings may still be running.",
      "",
      "--- Child result ---",
      finished,
      "",
      "--- Child result ---",
      "an excerpt the host cut before its task line",
    ].join("\n");
    const blocks = parseChildResultDelivery(batch);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: "result", role: "research" });
    expect(blocks[1]).toEqual({
      kind: "raw",
      text: "an excerpt the host cut before its task line",
    });
  });

  it("does not take an ordinary message for a delivery", () => {
    expect(isChildResultDelivery("Please summarize this.")).toBe(false);
    expect(parseChildResultDelivery("Please summarize this.")).toEqual([]);
  });
});

function subagentsWith(entry: Partial<AgentHierarchyInputEntry>): ChildRunStatusController {
  return {
    status: "ready",
    entries: [
      {
        runId: run,
        role: "research",
        task: "Reply with exactly MATRIX-A1.",
        lifecycleStatus: "completed",
        executionKind: "octant-managed",
        usageQuality: "provider-reported",
        resultAcknowledgement: { required: false, acknowledged: false },
        version: 2,
        createdAt: "2026-11-18T10:00:00.000Z",
        updatedAt: "2026-11-18T10:00:48.000Z",
        ...entry,
      },
    ],
  } as never;
}

describe("a finished child's delivered result", () => {
  it("reads as one quiet line with its run time and opens the reply in place", async () => {
    const user = userEvent.setup();
    render(
      <ThreadSubagentsContext value={subagentsWith({})}>
        <ChildResultCards text={finishedFirst} />
      </ThreadSubagentsContext>,
    );

    expect(screen.getByText("Research subagent finished · worked 48s")).toBeVisible();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.queryByText("MATRIX-A1")).not.toBeInTheDocument();

    const show = screen.getByRole("button", { name: "Show result" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    show.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Hide result" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const card = screen.getByRole("article", { name: "Research subagent finished" });
    expect(card).toHaveTextContent("MATRIX-A1");
    expect(within(card).getByRole("button", { name: "Details" })).toBeVisible();
  });

  it("omits the run time when the child's times are not known", () => {
    render(<ChildResultCards text={finished} />);
    expect(screen.getByText("Research subagent finished")).toBeVisible();
  });

  it("omits the run time for a later generation, whose run times span every generation", () => {
    render(
      <ThreadSubagentsContext value={subagentsWith({})}>
        <ChildResultCards text={finished} />
      </ThreadSubagentsContext>,
    );
    expect(screen.getByText("Research subagent finished")).toBeVisible();
    expect(screen.queryByText(/worked/)).not.toBeInTheDocument();
  });

  it("keeps the full card for a child that failed", () => {
    render(
      <ThreadSubagentsContext value={subagentsWith({ lifecycleStatus: "failed" })}>
        <ChildResultCards text={ended} />
      </ThreadSubagentsContext>,
    );
    expect(screen.getByRole("article", { name: "Implement subagent failed" })).toHaveTextContent(
      "Claude authentication is required.",
    );
    expect(screen.queryByRole("button", { name: "Show result" })).not.toBeInTheDocument();
  });
});

describe("ChildResultCards", () => {
  it("shows the child's role, provider, model and result, with ids behind Details", async () => {
    const user = userEvent.setup();
    render(
      <ChildResultCards
        providerGroups={[
          {
            instance: { id: provider, displayName: "Claude Code" },
            sections: [
              { label: "Models", models: [{ model: { id: "haiku", displayName: "Haiku 4.5" } }] },
            ],
          } as never,
        ]}
        text={finished}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Show result" }));
    const card = screen.getByRole("article", { name: "Research subagent finished" });
    // The names the model picker uses, not the ids the host recorded.
    expect(card).toHaveTextContent("Claude Code · Haiku 4.5");
    expect(card).not.toHaveTextContent("Claude Code · haiku");
    expect(card).toHaveTextContent("MATRIX-A1");
    expect(card).not.toHaveTextContent(run);
    expect(card).not.toHaveTextContent(provider);

    await user.click(within(card).getByRole("button", { name: "Details" }));
    expect(card).toHaveTextContent(`Run: ${run} · Generation 2`);
    expect(card).toHaveTextContent(`Provider ID: ${provider}`);
  });

  it("falls back to the recorded model id only when the picker knows no label", async () => {
    render(<ChildResultCards providerGroups={[]} text={finished} />);
    await userEvent.click(screen.getByRole("button", { name: "Show result" }));

    expect(screen.getByRole("article", { name: "Research subagent finished" })).toHaveTextContent(
      "haiku",
    );
    expect(screen.queryByText(provider)).not.toBeInTheDocument();
  });

  it("says why a subagent stopped instead of presenting a result", () => {
    render(<ChildResultCards text={ended} />);

    const card = screen.getByRole("article", { name: "Implement subagent failed" });
    expect(card).toHaveTextContent("Claude authentication is required.");
    expect(card).not.toHaveTextContent(/Outcome:/);
  });

  it("folds a long result until asked", async () => {
    const user = userEvent.setup();
    const long = `${finished.slice(0, finished.indexOf("Result:\n"))}Result:\n${"A long finding. ".repeat(80)}`;
    render(<ChildResultCards text={long} />);
    await user.click(screen.getByRole("button", { name: "Show result" }));

    const toggle = screen.getByRole("button", { name: "Show full result" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});

describe("a child result steered into a running turn", () => {
  it("shows the same attributed card, labelled as delivered into the running turn", async () => {
    const runId = decodeAgentRunId(run);
    render(
      <SteeredChildResults
        steered={[
          {
            delivery: {
              kind: "agent-result",
              runId,
              runIds: [runId],
              runGenerations: [{ runId, generation: 2 }],
            },
            body: finished,
            steeredAt: decodeUtcTimestamp("2026-11-15T12:00:00.000Z"),
          },
        ]}
      />,
    );
    const delivered = screen.getByRole("article", {
      name: "Subagent results delivered into the running turn",
    });
    expect(within(delivered).getByText("Delivered into the running turn")).toBeTruthy();
    await userEvent.click(within(delivered).getByRole("button", { name: "Show result" }));
    expect(
      within(delivered).getByRole("article", { name: "Research subagent finished" }),
    ).toHaveTextContent("MATRIX-A1");
  });

  it("shows nothing for a turn that took no steered result", () => {
    const { container } = render(<SteeredChildResults steered={undefined} />);
    expect(container.childElementCount).toBe(0);
  });
});
