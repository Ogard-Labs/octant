import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TurnHeader, turnTimeTitle } from "./TurnHeader";

describe("TurnHeader", () => {
  it("branches from the response through its inline action", () => {
    const onFork = vi.fn();
    render(<TurnHeader at="2026-01-02T03:04:05.000Z" outcome="completed" onFork={onFork} />);
    fireEvent.click(screen.getByRole("button", { name: "Fork from here" }));
    expect(onFork).toHaveBeenCalledOnce();
  });
  it("keeps successful reply metadata and actions without a Completed status", () => {
    const at = "2026-01-02T03:04:05.000Z";
    render(
      <TurnHeader
        at={at}
        outcome="completed"
        workedFor="Worked for 4s"
        copyValue="Answer"
        onRegenerate={vi.fn()}
      />,
    );
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
    expect(screen.getByText("Worked for 4s")).toBeInTheDocument();
    expect(
      screen.getAllByTitle(turnTimeTitle(at) ?? "").some((element) => element.tagName === "TIME"),
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Copy message" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate response" })).toBeInTheDocument();
  });

  it.each(["failed", "interrupted", "waiting", "cancelled"] as const)(
    "keeps the %s outcome visible",
    (outcome) => {
      render(<TurnHeader outcome={outcome} />);
      expect(
        screen.getByText(
          outcome === "waiting"
            ? "Waiting for approval"
            : outcome[0]?.toUpperCase() + outcome.slice(1),
        ),
      ).toBeVisible();
    },
  );

  it("keeps provider details out of the transcript row while exposing them with the timestamp on hover", () => {
    const provider = "Pi RPC — GPT-5.3 Codex Spark";
    const at = "2026-01-02T03:04:05.000Z";

    render(<TurnHeader at={at} outcome="completed" provider={provider} />);

    expect(screen.queryByText(provider)).not.toBeInTheDocument();
    expect(screen.getByTitle(`${provider} · ${turnTimeTitle(at)}`)).toBeInTheDocument();
  });
});
