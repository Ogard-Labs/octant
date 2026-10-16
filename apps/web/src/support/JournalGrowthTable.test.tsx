import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DiagnosticsExportClient } from "@octant/client-runtime/diagnostics-export-client";
import { decodeJournalGrowth } from "@octant/contracts/diagnostics";
import { JournalGrowthTable } from "./JournalGrowthTable";

const days = Array.from(
  { length: 14 },
  (_, index) => `2026-10-${String(3 + index).padStart(2, "0")}`,
);

function clientReading(
  readJournalGrowth: DiagnosticsExportClient["readJournalGrowth"],
): DiagnosticsExportClient {
  return { exportEvidence: vi.fn(), readJournalGrowth };
}

describe("JournalGrowthTable", () => {
  it("shows a row per kind with its 14-day total, plus the journal rows and database size", async () => {
    const readJournalGrowth = vi.fn(async () =>
      decodeJournalGrowth({
        generatedAt: "2026-10-16T09:30:00.000Z",
        days,
        kinds: [
          { kind: "chat-thread", counts: [4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3], total: 9 },
          {
            kind: "automation",
            counts: Array.from({ length: 14 }, (_, index) => (index === 13 ? 1 : 0)),
            total: 1,
          },
        ],
        totalRows: 123_456,
        databaseBytes: 5 * 1_024 * 1_024,
      }),
    );
    render(<JournalGrowthTable client={clientReading(readJournalGrowth)} />);

    expect(await screen.findByText(/123,456 journal rows · 5\.0 MB database/)).toBeInTheDocument();
    const rows = screen.getAllByRole("row");
    expect(within(rows[1] as HTMLElement).getByText("chat-thread")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("9")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("automation")).toBeInTheDocument();
    expect(screen.getByText(/2026-10-03 to 2026-10-16/)).toBeInTheDocument();
    expect(readJournalGrowth).toHaveBeenCalledOnce();
  });

  it("says so when the host cannot read the journal", async () => {
    render(
      <JournalGrowthTable
        client={clientReading(async () => {
          throw new Error("unavailable");
        })}
      />,
    );
    expect(await screen.findByText("Journal growth could not be read.")).toBeInTheDocument();
  });
});
