import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ChildResultCards } from "./ChildResultCards";
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

describe("ChildResultCards", () => {
  it("shows the child's role, provider, model and result, with ids behind Details", async () => {
    const user = userEvent.setup();
    render(
      <ChildResultCards
        providerGroups={[
          {
            instance: { id: provider, displayName: "Claude Code" },
            sections: [],
          } as never,
        ]}
        text={finished}
      />,
    );

    const card = screen.getByRole("article", { name: "Research subagent finished" });
    expect(card).toHaveTextContent("Claude Code · haiku");
    expect(card).toHaveTextContent("MATRIX-A1");
    expect(card).not.toHaveTextContent(run);
    expect(card).not.toHaveTextContent(provider);

    await user.click(within(card).getByRole("button", { name: "Details" }));
    expect(card).toHaveTextContent(`Run: ${run} · Generation 2`);
    expect(card).toHaveTextContent(`Provider ID: ${provider}`);
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

    const toggle = screen.getByRole("button", { name: "Show full result" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});
