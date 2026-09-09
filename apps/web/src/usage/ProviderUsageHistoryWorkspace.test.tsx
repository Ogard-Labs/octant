import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { decodeLocalUsageHistoryResponse, type LocalUsageHistoryResponse } from "@octant/contracts";
import { ProviderUsageHistoryWorkspace } from "./ProviderUsageHistoryWorkspace";

function history(): LocalUsageHistoryResponse {
  const totals = {
    inputTokens: 1000,
    outputTokens: 200,
    totalTokens: 1200,
    requestCount: 2,
    sessionCount: 1,
    cacheReadInputTokens: 600,
    uncachedInputTokens: 400,
    componentCoverage: {
      uncachedInput: { measured: 2, total: 2 },
      cacheRead: { measured: 2, total: 2 },
      cacheWrite: { measured: 0, total: 2 },
      reasoning: { measured: 0, total: 2 },
    },
  };
  const cost = { apiEstimateUsd: 1.25, pricedRecordCount: 1, unpricedRecordCount: 1 };
  return decodeLocalUsageHistoryResponse({
    source: "local-provider-history",
    from: "2026-08-10T12:00:00.000Z",
    to: "2026-09-09T12:00:00.000Z",
    timeZone: "UTC",
    queryAt: "2026-09-09T12:00:00.000Z",
    totals,
    cost,
    providers: [{ key: "codex", label: "Codex", providerKey: "codex", totals, cost }],
    models: [
      { key: "codex/gpt-5.6-luna", label: "gpt-5.6-luna", providerKey: "codex", totals, cost },
    ],
    days: [{ day: "2026-09-09", providerKey: "codex", totals, cost }],
    dailyTotals: [{ day: "2026-09-09", providerKey: "all", totals, cost }],
    coverage: [
      {
        sourceKind: "codex",
        sourceInstallationId: "local-1",
        status: "ready",
        scannedFileCount: 1,
        acceptedRecordCount: 2,
        omittedRecordCount: 0,
        truncated: false,
        hasMore: false,
        detail: "Local Codex sessions on this Mac.",
      },
    ],
  });
}

describe("Local provider usage history", () => {
  it("continues a partial import and replaces its subtotal with the completed reading", async () => {
    const partial = history();
    const complete = { ...history(), totals: { ...history().totals, totalTokens: 2400 } };
    const load = vi
      .fn()
      .mockResolvedValueOnce({
        ...partial,
        coverage: partial.coverage.map((source) => ({
          ...source,
          status: "partial",
          hasMore: true,
        })),
      })
      .mockResolvedValue(complete);
    render(<ProviderUsageHistoryWorkspace client={{ load }} />);
    expect(await screen.findByRole("heading", { name: "2.4K" })).toBeVisible();
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("labels a failed continuation as incomplete rather than a successful reading", async () => {
    const partial = history();
    const load = vi
      .fn()
      .mockResolvedValueOnce({
        ...partial,
        coverage: partial.coverage.map((source) => ({
          ...source,
          status: "partial",
          hasMore: true,
        })),
      })
      .mockRejectedValue(new Error("offline"));
    render(<ProviderUsageHistoryWorkspace client={{ load }} />);
    expect(
      await screen.findByText("Import failed. Partial readings are shown; see source coverage."),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "1.2K" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh provider history" })).toBeEnabled();
  });
  it("explains when no supported history reader is enabled", async () => {
    const empty = history();
    render(
      <ProviderUsageHistoryWorkspace
        client={{
          load: async () => ({
            ...empty,
            coverage: [],
            providers: [],
            models: [],
            days: [],
            dailyTotals: [],
            totals: { ...empty.totals, requestCount: 0, sessionCount: 0, totalTokens: 0 },
          }),
        }}
      />,
    );
    expect(
      await screen.findByText(
        "No supported local history source is enabled. Check Providers & Models.",
      ),
    ).toBeVisible();
  });
  it("shows a recoverable failure instead of pretending the chart is still loading", async () => {
    render(
      <ProviderUsageHistoryWorkspace
        client={{
          load: async () => {
            throw new Error("offline");
          },
        }}
      />,
    );
    expect(
      await screen.findByText("History could not be read. Refresh to try again."),
    ).toBeVisible();
    expect(screen.queryByText("Loading activity…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh provider history" })).toBeEnabled();
  });
  it("shows processed tokens and separates API estimates from unpriced activity", async () => {
    render(<ProviderUsageHistoryWorkspace client={{ load: async () => history() }} />);
    expect(await screen.findByRole("heading", { name: "1.2K" })).toBeVisible();
    expect(screen.getByRole("table", { name: "Usage by model" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Cost" }));
    expect(screen.getByRole("heading", { name: "$1.25" })).toBeVisible();
    expect(screen.getByText(/1 request without pricing/)).toBeVisible();
    expect(screen.getByText(/API-equivalent estimate/)).toBeVisible();
    await userEvent.click(screen.getByText("View chart data"));
    expect(screen.getByRole("table", { name: "Daily provider usage" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Day" }));
    expect(screen.getByRole("table", { name: "Usage by day" })).toBeVisible();
  });

  it("does not replace a new range with a late result from the previous range", async () => {
    let resolveFirst: ((value: LocalUsageHistoryResponse) => void) | undefined;
    const first = new Promise<LocalUsageHistoryResponse>((resolve) => {
      resolveFirst = resolve;
    });
    const load = vi.fn().mockReturnValueOnce(first).mockResolvedValue(history());
    render(<ProviderUsageHistoryWorkspace client={{ load }} />);
    await userEvent.click(screen.getByRole("button", { name: "7 days" }));
    expect(await screen.findByRole("heading", { name: "1.2K" })).toBeVisible();
    const obsolete = history();
    resolveFirst?.({ ...obsolete, totals: { ...obsolete.totals, totalTokens: 999999 } });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("heading", { name: "1M" })).not.toBeInTheDocument();
  });

  it("keeps unknown cost unavailable instead of presenting free usage", async () => {
    const data = history();
    render(
      <ProviderUsageHistoryWorkspace
        client={{
          load: async () => ({ ...data, cost: { pricedRecordCount: 0, unpricedRecordCount: 2 } }),
        }}
      />,
    );
    await screen.findByRole("heading", { name: "1.2K" });
    await userEvent.click(screen.getByRole("button", { name: "Cost" }));
    expect(screen.getByRole("heading", { name: "Unavailable" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "$0.00" })).not.toBeInTheDocument();
  });
});
