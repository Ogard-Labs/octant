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
});
