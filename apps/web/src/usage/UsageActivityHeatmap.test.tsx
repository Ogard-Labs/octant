import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { UsageActivityCell } from "@octant/contracts";
import { UsageActivityHeatmap } from "./UsageActivityHeatmap";

function cell(overrides: Partial<UsageActivityCell> = {}): UsageActivityCell {
  return {
    date: "2026-07-24",
    inputTokens: 100,
    outputTokens: 50,
    requestCount: 1,
    unavailableRequestCount: 0,
    state: "measured",
    ...overrides,
  } as UsageActivityCell;
}

describe("UsageActivityHeatmap", () => {
  it("explains an empty range instead of drawing an empty grid", () => {
    render(<UsageActivityHeatmap cells={[]} timeZone="UTC" truncated={false} />);
    expect(screen.getByRole("note")).toHaveTextContent("No activity has been recorded");
  });

  it("gives every day an accessible text equivalent", () => {
    render(<UsageActivityHeatmap cells={[cell()]} timeZone="UTC" truncated={false} />);
    expect(
      screen.getByRole("img", { name: "2026-07-24: 150 tokens across 1 request" }),
    ).toBeInTheDocument();
  });

  it("names an unavailable day as unavailable rather than as zero", () => {
    render(
      <UsageActivityHeatmap
        cells={[
          cell({
            state: "unavailable",
            inputTokens: 0,
            outputTokens: 0,
            requestCount: 2,
            unavailableRequestCount: 2,
          }),
        ]}
        timeZone="UTC"
        truncated={false}
      />,
    );
    expect(
      screen.getByRole("img", { name: "2026-07-24: 2 requests, usage unavailable" }),
    ).toBeInTheDocument();
  });

  it("distinguishes a day with no activity from one with unavailable usage", () => {
    render(
      <UsageActivityHeatmap
        cells={[
          cell({
            date: "2026-07-22",
            state: "no-activity",
            inputTokens: 0,
            outputTokens: 0,
            requestCount: 0,
          }),
          cell({
            date: "2026-07-23",
            state: "unavailable",
            inputTokens: 0,
            outputTokens: 0,
            requestCount: 1,
            unavailableRequestCount: 1,
          }),
        ]}
        timeZone="UTC"
        truncated={false}
      />,
    );
    expect(screen.getByRole("img", { name: "2026-07-22: no activity" })).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "2026-07-23: 1 request, usage unavailable" }),
    ).toBeInTheDocument();
  });

  it("keeps each cell keyboard focusable", () => {
    render(<UsageActivityHeatmap cells={[cell()]} timeZone="UTC" truncated={false} />);
    expect(screen.getByRole("img", { name: /2026-07-24/ })).toHaveAttribute("tabindex", "0");
  });

  it("carries state in a glyph as well as in colour", () => {
    render(
      <UsageActivityHeatmap
        cells={[
          cell({ state: "partially-unavailable", unavailableRequestCount: 1, requestCount: 3 }),
        ]}
        timeZone="UTC"
        truncated={false}
      />,
    );
    const cellElement = screen.getByRole("img", { name: /partly|without reported usage/ });
    expect(cellElement.textContent).not.toBe("");
    expect(cellElement).toHaveAttribute("data-state", "partially-unavailable");
  });

  it("always offers the same series as a table", () => {
    render(
      <UsageActivityHeatmap
        cells={[
          cell(),
          cell({
            date: "2026-07-25",
            state: "no-activity",
            inputTokens: 0,
            outputTokens: 0,
            requestCount: 0,
          }),
        ]}
        timeZone="UTC"
        truncated={false}
      />,
    );
    const table = screen.getByRole("table", { name: "Daily usage activity" });
    expect(within(table).getByRole("rowheader", { name: "2026-07-24" })).toBeInTheDocument();
    const emptyRow = within(table).getByRole("rowheader", { name: "2026-07-25" }).closest("tr");
    expect(emptyRow?.textContent).toContain("no activity");
  });

  it("says when the range was truncated", () => {
    render(<UsageActivityHeatmap cells={[cell()]} timeZone="Europe/Oslo" truncated />);
    expect(screen.getByText(/most recent 371 days/)).toBeInTheDocument();
    expect(screen.getByText(/Europe\/Oslo/)).toBeInTheDocument();
  });
});
