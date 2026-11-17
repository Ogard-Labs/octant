import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

  describe("a running turn", () => {
    const startedAt = "2026-01-02T03:04:05.000Z";
    afterEach(() => vi.useRealTimers());

    function runningAt(offsetSeconds: number) {
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse(startedAt) + offsetSeconds * 1000);
    }

    it("counts from the turn's own start, once a second, and stops when it unmounts", () => {
      runningAt(12);
      const { unmount } = render(<TurnHeader outcome="running" startedAt={startedAt} />);
      expect(screen.getByText("Working")).toBeVisible();
      expect(screen.getByText("12s")).toBeVisible();

      act(() => void vi.advanceTimersByTime(1000));
      expect(screen.getByText("13s")).toBeVisible();
      act(() => void vi.advanceTimersByTime(52_000));
      expect(screen.getByText("1m 5s")).toBeVisible();

      unmount();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("names the current step in the live region and keeps the clock out of it", () => {
      runningAt(3);
      const { rerender } = render(
        <TurnHeader outcome="running" startedAt={startedAt} step="Read" />,
      );
      const live = screen.getByRole("status");
      expect(live).toHaveTextContent("Read");
      expect(live).not.toHaveTextContent(/\d+s/);
      expect(live).toHaveAttribute("aria-live", "polite");

      act(() => void vi.advanceTimersByTime(1000));
      expect(live).not.toHaveTextContent(/\d+s/);

      rerender(<TurnHeader outcome="running" startedAt={startedAt} />);
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
      expect(screen.getByText("4s")).toBeVisible();
    });

    it("keeps the plain line for a turn with no start time", () => {
      render(<TurnHeader outcome="running" />);
      expect(screen.getByText("Working…")).toBeVisible();
    });
  });
});
