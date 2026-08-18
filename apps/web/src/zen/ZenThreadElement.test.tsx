import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ZenThreadElement } from "./ZenThreadElement";
import { entry, catalogRef } from "./ZenThreadPicker.test-fixture";

describe("ZenThreadElement", () => {
  it("keeps exact source identity visible and continues by catalog reference", () => {
    const onContinue = vi.fn();
    render(
      <ZenThreadElement
        entry={entry}
        onContinue={onContinue}
        sourceContext={entry.sourceContext}
      />,
    );

    expect(screen.getByText("Release blocker")).toBeInTheDocument();
    expect(screen.getByText(/This Mac.*Chat.*AuroraDocs/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue Release blocker" }));
    expect(onContinue).toHaveBeenCalledWith(catalogRef);
  });

  it("shows immutable raw identity when the source becomes unavailable", () => {
    render(<ZenThreadElement onContinue={vi.fn()} sourceContext={entry.sourceContext} />);

    expect(screen.getByText("Source unavailable")).toBeInTheDocument();
    expect(screen.getByText(new RegExp(String(entry.threadId)))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Continue/ })).not.toBeInTheDocument();
  });

  it("hosts the thread's own conversation in the card without leaving the space", () => {
    render(
      <ZenThreadElement
        entry={entry}
        live={{ status: "streaming", surface: <p>Live transcript for Release blocker</p> }}
        onContinue={vi.fn()}
        sourceContext={entry.sourceContext}
      />,
    );

    expect(screen.getByText("Live transcript for Release blocker")).toBeInTheDocument();
    expect(screen.getByText(/This Mac.*Chat.*AuroraDocs/i)).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue Release blocker" })).toBeInTheDocument();
  });

  it("says a card stopped streaming rather than presenting stale text as live", () => {
    render(
      <ZenThreadElement
        entry={entry}
        live={{ status: "paused", reason: "budget" }}
        onContinue={vi.fn()}
        sourceContext={entry.sourceContext}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(/paused/i);
    expect(screen.getByRole("status")).toHaveTextContent(/other cards/i);
    expect(screen.getByRole("button", { name: "Continue Release blocker" })).toBeInTheDocument();
  });

  it("explains a card paused by being panned out of sight", () => {
    render(
      <ZenThreadElement
        entry={entry}
        live={{ status: "paused", reason: "off-screen" }}
        onContinue={vi.fn()}
        sourceContext={entry.sourceContext}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(/out of view/i);
  });
});
