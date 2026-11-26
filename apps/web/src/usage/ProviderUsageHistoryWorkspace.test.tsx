import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { decodeLocalUsageHistoryResponse, type LocalUsageHistoryResponse } from "@octant/contracts";
import { ProviderUsageHistoryWorkspace } from "./ProviderUsageHistoryWorkspace";

/** The view opens on cost, so a token assertion asks for tokens first. */
async function showTokens(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Tokens" }));
}

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
  it("reports cached input as a share of total input rather than all processed tokens", async () => {
    render(
      <ProviderUsageHistoryWorkspace client={{ load: vi.fn().mockResolvedValue(history()) }} />,
    );
    expect(await screen.findByText("Input cache hit rate")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByText("Input cache hit rate").parentElement).toHaveTextContent("60%"),
    );
  });

  it("keeps the cache savings label on one line and marks its value as an estimate", async () => {
    render(
      <ProviderUsageHistoryWorkspace client={{ load: vi.fn().mockResolvedValue(history()) }} />,
    );
    await waitFor(() =>
      expect(screen.getByText("Cache savings").parentElement).toHaveTextContent("Estimate"),
    );
  });

  it("weights the cache hit rate by input tokens rather than averaging model percentages", async () => {
    const data = history();
    const model = data.models[0];
    if (model === undefined) throw new Error("Expected a fixture model");
    const models = [
      {
        ...model,
        key: "small",
        label: "Small",
        totals: {
          ...model.totals,
          inputTokens: 100,
          outputTokens: 0,
          totalTokens: 100,
          cacheReadInputTokens: 90,
          uncachedInputTokens: 10,
        },
      },
      {
        ...model,
        key: "large",
        label: "Large",
        totals: {
          ...model.totals,
          inputTokens: 900,
          outputTokens: 200,
          totalTokens: 1100,
          cacheReadInputTokens: 510,
          uncachedInputTokens: 390,
        },
      },
    ];
    render(
      <ProviderUsageHistoryWorkspace
        client={{ load: vi.fn().mockResolvedValue({ ...data, models }) }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("Input cache hit rate").parentElement).toHaveTextContent("60%"),
    );
  });

  it("shows a measured zero cache hit rate when all input was uncached", async () => {
    const data = history();
    render(
      <ProviderUsageHistoryWorkspace
        client={{
          load: vi
            .fn()
            .mockResolvedValue({ ...data, totals: { ...data.totals, cacheReadInputTokens: 0 } }),
        }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("Input cache hit rate").parentElement).toHaveTextContent("0%"),
    );
  });

  it.each([
    { cacheReadInputTokens: undefined },
    {
      componentCoverage: {
        ...history().totals.componentCoverage,
        cacheRead: { measured: 1, total: 2 },
      },
    },
    { inputTokens: 0, cacheReadInputTokens: 0 },
    { inputTokens: 100, cacheReadInputTokens: 200 },
  ])(
    "leaves the cache hit rate unavailable without a complete valid denominator: %j",
    async (totals) => {
      const data = history();
      render(
        <ProviderUsageHistoryWorkspace
          client={{
            load: vi.fn().mockResolvedValue({ ...data, totals: { ...data.totals, ...totals } }),
          }}
        />,
      );
      await waitFor(() =>
        expect(screen.getByText("Input cache hit rate").parentElement).toHaveTextContent(
          "Unavailable",
        ),
      );
    },
  );

  it("inside Settings puts each reading in a kit section and adds no title of its own", async () => {
    render(
      <ProviderUsageHistoryWorkspace
        client={{ load: vi.fn().mockResolvedValue(history()) }}
        embedded
      />,
    );
    await screen.findByRole("heading", { name: /\$|K|—/ });

    for (const name of ["Usage overview", "Token totals", "Usage breakdown"]) {
      expect(screen.getByRole("region", { name })).toHaveClass("settings-card-section--open");
    }
    expect(screen.queryByRole("heading", { name: "Usage" })).toBeNull();
    // The breakdown is labelled once, by its section, with the switch on that line.
    expect(screen.getAllByRole("heading", { name: "Breakdown" })).toHaveLength(1);
    expect(screen.getByRole("group", { name: "Breakdown by" })).toBeVisible();
  });

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
    await showTokens();
    expect(await screen.findByRole("heading", { name: "2.4K" })).toBeVisible();
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("counts the sessions read so far while the import is still adding them", async () => {
    const partial = history();
    const continuation = new Promise<LocalUsageHistoryResponse>(() => undefined);
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
      .mockImplementationOnce(() => continuation);
    render(<ProviderUsageHistoryWorkspace client={{ load }} />);

    expect(await screen.findByText(/sessions so far/)).toBeVisible();
  });

  it("draws a smooth filled area for each provider over round tick values", async () => {
    const base = history();
    const days = base.days.flatMap((row) => [
      { ...row, day: "2026-09-07" },
      { ...row, day: "2026-09-09" },
    ]);
    const { container } = render(
      <ProviderUsageHistoryWorkspace client={{ load: async () => ({ ...base, days }) }} />,
    );

    await waitFor(() =>
      expect(container.querySelector(".provider-history__area")).toHaveAttribute(
        "d",
        expect.stringContaining("C"),
      ),
    );
    const ticks = [...container.querySelectorAll(".provider-history__tick")].map(
      (tick) => tick.textContent,
    );
    expect(ticks).toEqual(["$0", "$0.50", "$1", "$1.50"]);
  });

  it("leaves a gap rather than a zero where a day's cost is unknown", async () => {
    const base = history();
    const row = base.days[0];
    if (row === undefined) throw new Error("Expected a fixture day");
    const days = [
      { ...row, day: "2026-09-08", cost: { pricedRecordCount: 0, unpricedRecordCount: 1 } },
      { ...row, day: "2026-09-09" },
    ];
    render(<ProviderUsageHistoryWorkspace client={{ load: async () => ({ ...base, days }) }} />);

    expect(await screen.findByRole("img", { name: /Sep 8.*Codex Unavailable/ })).toBeVisible();
    expect(screen.getByRole("img", { name: /Sep 9.*Codex \$1\.25/ })).toBeVisible();
  });

  it("the chart's per-day readout is reachable by keyboard", async () => {
    const base = history();
    const days = base.days.flatMap((row) => [
      { ...row, day: "2026-09-08" },
      { ...row, day: "2026-09-09" },
    ]);
    const { container } = render(
      <ProviderUsageHistoryWorkspace client={{ load: async () => ({ ...base, days }) }} />,
    );
    const latest = await screen.findByRole("img", { name: /Sep 9.*Codex \$1\.25/ });
    const earlier = screen.getByRole("img", { name: /Sep 8.*Codex \$1\.25/ });
    // One tab stop for the whole plot; the arrow keys walk the days.
    expect(latest).toHaveAttribute("tabindex", "0");
    expect(earlier).toHaveAttribute("tabindex", "-1");

    act(() => latest.focus());
    const readout = () => container.querySelector(".provider-history__readout");
    expect(readout()).toHaveTextContent("Sep 9");
    await userEvent.keyboard("{ArrowLeft}");
    expect(earlier).toHaveFocus();
    expect(readout()).toHaveTextContent("Sep 8");
    expect(readout()).toHaveTextContent("Codex $1.25");
    await userEvent.keyboard("{End}");
    expect(latest).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(readout()).not.toHaveTextContent("Sep 9");
  });

  it("a provider row reads its share of cost and its tokens", async () => {
    const base = history();
    const provider = base.providers[0];
    if (provider === undefined) throw new Error("Expected a fixture provider");
    const providers = [
      { ...provider, cost: { ...provider.cost, apiEstimateUsd: 0.7875 } },
      {
        ...provider,
        key: "claude-code",
        label: "claude-code",
        providerKey: "claude-code",
        cost: { pricedRecordCount: 0, unpricedRecordCount: 2 },
      },
    ];
    render(
      <ProviderUsageHistoryWorkspace client={{ load: async () => ({ ...base, providers }) }} />,
    );
    const list = await screen.findByRole("list", { name: "Usage by provider" });
    const rows = within(list).getAllByRole("listitem");
    await waitFor(() => expect(rows[0]).toHaveTextContent("63% of cost · 1.2K tokens"));
    expect(rows[1]).toHaveTextContent("Share unavailable · 1.2K tokens");
    await userEvent.click(screen.getByRole("button", { name: "Tokens" }));
    expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("100% of tokens · $0.79");
  });

  it("splits tokens into one bar and names what no source broke down", async () => {
    render(<ProviderUsageHistoryWorkspace client={{ load: async () => history() }} />);
    const bar = await screen.findByRole("img", {
      name: "Tokens by type: Input 400, Cache read 600, Output 200",
    });
    expect(bar.children).toHaveLength(3);
    // The fixture measures no cache write, which is unknown and never zero.
    expect(screen.getByRole("list", { name: "Token types" })).toHaveTextContent(
      "Cache writeUnavailable",
    );
  });

  it("counts input a source did not break down as its own part of the bar", async () => {
    const base = history();
    const totals = {
      ...base.totals,
      componentCoverage: {
        ...base.totals.componentCoverage,
        cacheRead: { measured: 1, total: 2 },
      },
      cacheReadInputTokens: 200,
    };
    render(<ProviderUsageHistoryWorkspace client={{ load: async () => ({ ...base, totals }) }} />);
    expect(
      await screen.findByRole("img", {
        name: "Tokens by type: Input 400, Cache read 200, Input not broken down 400, Output 200",
      }),
    ).toBeVisible();
    expect(screen.getByRole("list", { name: "Token types" })).toHaveTextContent(
      "1 of 2 requests measured",
    );
  });

  it("ranks each model with a bar for its share", async () => {
    const base = history();
    const model = base.models[0];
    if (model === undefined) throw new Error("Expected a fixture model");
    const models = [
      { ...model, key: "small", label: "small", cost: { ...model.cost, apiEstimateUsd: 0.25 } },
      { ...model, key: "large", label: "large", cost: { ...model.cost, apiEstimateUsd: 1 } },
    ];
    const { container } = render(
      <ProviderUsageHistoryWorkspace client={{ load: async () => ({ ...base, models }) }} />,
    );
    const table = await screen.findByRole("table", { name: "Usage by model" });
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(3));
    const rows = within(table).getAllByRole("row");
    expect(rows[1]).toHaveTextContent(/^1.*large.*80\.0%/);
    expect(rows[2]).toHaveTextContent(/^2.*small.*20\.0%/);
    const bars = container.querySelectorAll<HTMLElement>(".provider-history__share-fill");
    expect(bars[0]?.style.width).toBe("80%");
  });

  it("keeps the explanatory sentences behind an info mark", async () => {
    render(<ProviderUsageHistoryWorkspace client={{ load: async () => history() }} />);
    await screen.findByRole("heading", { name: "$1.25" });
    expect(screen.queryByText(/not a subscription invoice/)).toBeNull();
    expect(screen.queryByText(/Local provider history · this computer/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "About these costs" }));
    expect(await screen.findByText(/not a subscription invoice/)).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "About this history" }));
    expect(await screen.findByText(/Local provider history · this computer/)).toBeVisible();
  });

  it("opens at the host's last reading and keeps it until the fresh read completes", async () => {
    const lastRead = { ...history(), fromLastRead: true };
    const scanning = {
      ...history(),
      totals: { ...history().totals, totalTokens: 300 },
      coverage: history().coverage.map((source) => ({
        ...source,
        status: "partial" as const,
        hasMore: true,
      })),
    };
    const complete = { ...history(), totals: { ...history().totals, totalTokens: 2400 } };
    let finishScan: (value: LocalUsageHistoryResponse) => void = () => undefined;
    const scanningRead = new Promise<LocalUsageHistoryResponse>((resolve) => {
      finishScan = resolve;
    });
    let finishComplete: (value: LocalUsageHistoryResponse) => void = () => undefined;
    const completeRead = new Promise<LocalUsageHistoryResponse>((resolve) => {
      finishComplete = resolve;
    });
    const load = vi
      .fn()
      .mockResolvedValueOnce(lastRead)
      .mockImplementationOnce(() => scanningRead)
      .mockImplementationOnce(() => completeRead);
    render(<ProviderUsageHistoryWorkspace client={{ load }} />);
    await showTokens();
    expect(load.mock.calls[0]?.[0]).toMatchObject({ preferLastRead: true });
    expect(await screen.findByRole("heading", { name: "1.2K" })).toBeVisible();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(load.mock.calls[1]?.[0]).not.toHaveProperty("preferLastRead");
    await act(async () => {
      finishScan(scanning);
    });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    // The unfinished scan's subtotal never replaces the last completed reading.
    expect(screen.getByRole("heading", { name: "1.2K" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "300" })).toBeNull();
    await act(async () => {
      finishComplete(complete);
    });
    expect(await screen.findByRole("heading", { name: "2.4K" })).toBeVisible();
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
    await showTokens();
    expect(screen.getByRole("heading", { name: "1.2K" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh provider history" })).toBeEnabled();
  });
  it("retains the selected range and tokens through a failed refresh and recovers on retry", async () => {
    const load = vi.fn().mockResolvedValue(history());
    render(<ProviderUsageHistoryWorkspace client={{ load }} />);
    await showTokens();
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    expect(await screen.findByRole("heading", { name: "1.2K" })).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh provider history" })).toBeEnabled(),
    );
    load.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh provider history" }));
    expect(
      await screen.findByText("Refresh failed. Last successful readings are shown."),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "1.2K" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Tokens" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Refresh provider history" }));
    await waitFor(() =>
      expect(
        screen.queryByText("Refresh failed. Last successful readings are shown."),
      ).not.toBeInTheDocument(),
    );
    expect(await screen.findByRole("heading", { name: "1.2K" })).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh provider history" })).toBeEnabled(),
    );
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
    await showTokens();
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
    await showTokens();
    expect(await screen.findByRole("heading", { name: "1.2K" })).toBeVisible();
    const obsolete = history();
    resolveFirst?.({ ...obsolete, totals: { ...obsolete.totals, totalTokens: 999999 } });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("heading", { name: "1M" })).not.toBeInTheDocument();
  });

  it("clears the previous host reading when the newly selected host fails", async () => {
    const original = { load: vi.fn().mockResolvedValue(history()) };
    const { rerender } = render(<ProviderUsageHistoryWorkspace client={original} />);
    await showTokens();
    expect(await screen.findByRole("heading", { name: "1.2K" })).toBeVisible();
    let rejectNext: ((reason: Error) => void) | undefined;
    const next = new Promise<LocalUsageHistoryResponse>((_resolve, reject) => {
      rejectNext = reject;
    });
    const replacement = { load: vi.fn().mockReturnValue(next) };
    rerender(<ProviderUsageHistoryWorkspace client={replacement} />);
    expect(screen.queryByRole("heading", { name: "1.2K" })).not.toBeInTheDocument();
    await act(async () => {
      rejectNext?.(new Error("Host unavailable"));
    });
    expect(screen.queryByRole("heading", { name: "1.2K" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Refresh/ })).toBeEnabled();
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
    await showTokens();
    await screen.findByRole("heading", { name: "1.2K" });
    await userEvent.click(screen.getByRole("button", { name: "Cost" }));
    expect(screen.getByRole("heading", { name: "Unavailable" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "$0.00" })).not.toBeInTheDocument();
  });
});

describe("Provider usage history chart layout", () => {
  it("sizes only the plot svg, so the chart-data chevron keeps its own icon size", () => {
    const css = readFileSync(resolve(import.meta.dirname, "providerUsageHistory.css"), "utf8");
    // A bare `.provider-history__chart svg` also matched the disclosure's
    // chevron, stretching it to 100% by 240px and pushing the Overview card open.
    expect(css).not.toMatch(/\.provider-history__chart svg\b/);
    expect(css).toMatch(/\.provider-history__chart > svg \{\s*width: 100%;\s*height: 240px;/);
  });
});
