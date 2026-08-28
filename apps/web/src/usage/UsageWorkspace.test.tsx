import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  UsageDashboardRequest,
  UsageDashboardResponse,
  UsageQueryFilter,
} from "@octant/contracts";
import { UsageDashboardClientFailure, type UsageDashboardClient } from "@octant/client-runtime";
import { UsageWorkspace } from "./UsageWorkspace";

const provider = "66000000-0000-4000-8000-000000000001";
const queryAt = "2026-07-24T12:00:00.000Z";

function dashboard(overrides: Partial<UsageDashboardResponse> = {}): UsageDashboardResponse {
  return {
    summary: {
      totals: {
        totalInputTokens: 1_000,
        totalOutputTokens: 500,
        totalReasoningTokens: 40,
        totalRequests: 3,
        exactCount: 2,
        estimatedCount: 0,
        reconciledCount: 0,
        staleCount: 0,
        unavailableCount: 1,
      },
      requestsWithUnavailableUsage: 1,
      coverage: [
        { quality: "exact", requestCount: 2 },
        { quality: "estimated", requestCount: 0 },
        { quality: "reconciled", requestCount: 0 },
        { quality: "stale", requestCount: 0 },
        { quality: "unavailable", requestCount: 1 },
      ],
      peakDay: { date: "2026-07-24", totalTokens: 1_500, requestCount: 3 },
      peakModel: {
        providerInstanceId: provider,
        modelId: "gpt-4o",
        totalTokens: 1_500,
        requestCount: 3,
      },
      excludedRecordCount: 2,
    },
    activity: [
      {
        date: "2026-07-24",
        inputTokens: 1_000,
        outputTokens: 500,
        requestCount: 3,
        unavailableRequestCount: 1,
        state: "partially-unavailable",
      },
    ],
    activityTruncated: false,
    breakdown: [
      {
        dimension: "provider",
        rows: [
          {
            key: provider,
            label: provider,
            availability: "recorded",
            inputTokens: 1_000,
            outputTokens: 500,
            requestCount: 3,
            unavailableRequestCount: 1,
          },
        ],
        truncated: false,
      },
      {
        dimension: "project",
        rows: [
          {
            key: "",
            label: "Unavailable",
            availability: "unavailable",
            inputTokens: 1_000,
            outputTokens: 500,
            requestCount: 3,
            unavailableRequestCount: 1,
          },
        ],
        truncated: false,
      },
    ],
    detail: [
      {
        reconciliationId: "66000000-0000-4000-8000-000000000003",
        hostId: "local",
        providerInstanceId: provider,
        modelId: "gpt-4o",
        requestShape: "chat-turn",
        subjectType: "chat-thread",
        subjectId: "thread-1",
        mode: "chat",
        quality: "exact",
        inputTokens: 1_000,
        outputTokens: 500,
        plannedInputTokens: 950,
        varianceTokens: 50,
        attribution: [{ category: "conversation", plannedTokens: 950, quality: "exact" }],
        observedAt: queryAt,
      },
    ],
    detailTruncated: false,
    hosts: [
      { hostId: "local", requestCount: 3, lastObservedAt: queryAt, status: "contributing" },
      { hostId: "laptop", requestCount: 1, lastObservedAt: queryAt, status: "stale" },
    ],
    dimensionSources: [
      { dimension: "provider", status: "recorded", detail: "Recorded per reconciliation." },
      {
        dimension: "project",
        status: "partial",
        detail: "Work threads are not projected into the usage store.",
      },
      {
        dimension: "cost",
        status: "unavailable",
        detail: "No reviewed or user-supplied pricing metadata exists on this host.",
      },
    ],
    timeZone: "UTC",
    queryAt,
    cacheStats: {
      caches: [
        {
          key: "pull-request-list",
          label: "Project pull requests",
          hitCount: 8,
          missCount: 2,
          hitRatio: 0.8,
          lastRefreshAt: queryAt,
          stalenessMs: 60_000,
          failureStreak: 0,
        },
      ],
      providerTokenCaches: [
        {
          providerInstanceId: provider,
          requestCount: 3,
          cacheReadInputTokens: 300,
          cacheWriteInputTokens: 100,
          hitRatio: 0.75,
        },
      ],
      tokenCacheHitRatio: 0.75,
    },
    latencyStats: { measurements: [] },
    ...overrides,
  } as unknown as UsageDashboardResponse;
}

function clientReturning(response: UsageDashboardResponse) {
  const load = vi.fn().mockResolvedValue(response);
  return { client: { load } as UsageDashboardClient, load };
}

function emptyDashboard(): UsageDashboardResponse {
  return dashboard({
    summary: {
      totals: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalRequests: 0,
        exactCount: 0,
        estimatedCount: 0,
        reconciledCount: 0,
        staleCount: 0,
        unavailableCount: 0,
      },
      requestsWithUnavailableUsage: 0,
      coverage: [],
      excludedRecordCount: 0,
    },
    activity: [],
    breakdown: [],
    detail: [],
    hosts: [],
  } as unknown as Partial<UsageDashboardResponse>);
}

describe("UsageWorkspace", () => {
  it("offers a labeled way back to the app when mounted as the standalone surface", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const { client } = clientReturning(dashboard());
    render(<UsageWorkspace client={client} onBack={onBack} />);

    await user.click(screen.getByRole("button", { name: "Back to app" }));

    expect(onBack).toHaveBeenCalledOnce();
  });

  it("shows no back control when a host embeds it without a way back", () => {
    const { client } = clientReturning(dashboard());
    render(<UsageWorkspace client={client} />);

    expect(screen.queryByRole("button", { name: "Back to app" })).toBeNull();
  });

  it("renders host latency measurements and the renderer round trip", async () => {
    const { client } = clientReturning(
      dashboard({
        latencyStats: {
          measurements: [
            {
              key: "rpc",
              label: "Request handling",
              observationCount: 3,
              p50Ms: 12,
              p95Ms: 18,
              maxMs: 22,
              slowThresholdMs: 15_000,
              slowCount: 1,
            },
          ],
        },
      }),
    );
    render(<UsageWorkspace client={client} />);

    const latency = await screen.findByRole("region", { name: "Latency" });
    expect(within(latency).getByText("Request handling")).toBeInTheDocument();
    expect(
      within(latency).getByText(/3 observations · p50 12 ms · p95 18 ms · max 22 ms/),
    ).toBeInTheDocument();
    expect(within(latency).getByText(/1 past 15s/)).toBeInTheDocument();
    expect(within(latency).getByText(/Connection round trip \(this window\):/)).toBeInTheDocument();
  });

  it("reports an honest empty state when the host has no latency observations", async () => {
    const { client } = clientReturning(dashboard({ latencyStats: { measurements: [] } }));
    render(<UsageWorkspace client={client} />);

    const latency = await screen.findByRole("region", { name: "Latency" });
    expect(
      within(latency).getByText("No host latency observations have been recorded."),
    ).toBeInTheDocument();
  });

  it("says the totals are a floor when the ledger scan was capped", async () => {
    const { client } = clientReturning(dashboard({ scanTruncated: true } as never));
    render(<UsageWorkspace client={client} />);

    expect(
      await screen.findByText(/Every total below is a floor, not a complete figure/),
    ).toBeVisible();
  });

  it("does not claim an empty range when a capped scan surfaced nothing readable", async () => {
    const capped = { ...emptyDashboard(), scanTruncated: true } as UsageDashboardResponse;
    const { client } = clientReturning(capped);
    render(<UsageWorkspace client={client} />);

    expect(await screen.findByText(/this is not a report that the range is empty/)).toBeVisible();
    expect(screen.queryByText(/No usage has been recorded for this range/)).toBeNull();
  });

  it("renders host totals without recomputing them", async () => {
    const { client } = clientReturning(dashboard());
    render(<UsageWorkspace client={client} />);

    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Summary" })).toBeInTheDocument(),
    );
    const summary = screen.getByRole("region", { name: "Summary" });
    expect(within(summary).getByText("1,000")).toBeInTheDocument();
    expect(within(summary).getByText("500")).toBeInTheDocument();
    expect(within(summary).getByText("40")).toBeInTheDocument();
  });

  it("shows a dimension the provider never reported as unavailable, not zero", async () => {
    const { client } = clientReturning(dashboard());
    render(<UsageWorkspace client={client} />);

    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Summary" })).toBeInTheDocument(),
    );
    const summary = screen.getByRole("region", { name: "Summary" });
    const cacheRead = within(summary).getByText("Cache read tokens").closest("div");
    expect(cacheRead?.textContent).toContain("Unavailable");
  });

  it("breaks measurement coverage out so a mixed total is never read as exact", async () => {
    const { client } = clientReturning(dashboard());
    render(<UsageWorkspace client={client} />);

    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Summary" })).toBeInTheDocument(),
    );
    const summary = screen.getByRole("region", { name: "Summary" });
    const coverage = within(summary).getByText("Exact").closest("ul");
    expect(coverage?.textContent).toContain("Exact2 requests");
    expect(coverage?.textContent).toContain("Unavailable1 request");
    expect(within(summary).getByText(/never counted as zero/)).toBeInTheDocument();
  });

  it("names the highest-usage day and model and states that cost is unavailable", async () => {
    const { client } = clientReturning(dashboard());
    render(<UsageWorkspace client={client} />);

    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Summary" })).toBeInTheDocument(),
    );
    expect(screen.getByText(/Highest-usage day: 2026-07-24/)).toBeInTheDocument();
    expect(screen.getByText(/Highest-usage model: gpt-4o/)).toBeInTheDocument();
    expect(screen.getByText(/Monetary cost: Unavailable/)).toBeInTheDocument();
  });

  it("reports records the host refused to aggregate", async () => {
    const { client } = clientReturning(dashboard());
    render(<UsageWorkspace client={client} />);

    await waitFor(() =>
      expect(screen.getByText(/2 durable records were excluded/)).toBeInTheDocument(),
    );
  });

  it("attributes usage by provider and labels an unattributable Project", async () => {
    const { client } = clientReturning(dashboard());
    render(<UsageWorkspace client={client} />);

    await waitFor(() =>
      expect(screen.getByRole("table", { name: "Usage by provider instance" })).toBeInTheDocument(),
    );
    const projectTable = screen.getByRole("table", { name: "Usage by project" });
    expect(
      within(projectTable).getByRole("rowheader", { name: "Unavailable" }),
    ).toBeInTheDocument();
  });

  it("shows a detail row with its attribution and measurement", async () => {
    const { client } = clientReturning(dashboard());
    render(<UsageWorkspace client={client} />);

    await waitFor(() =>
      expect(screen.getByRole("table", { name: "Usage request detail" })).toBeInTheDocument(),
    );
    const detail = screen.getByRole("table", { name: "Usage request detail" });
    expect(within(detail).getByText("chat")).toBeInTheDocument();
    expect(within(detail).getByText("conversation")).toBeInTheDocument();
    expect(within(detail).getByText("Exact")).toBeInTheDocument();
  });

  it("opens the attributed subject without embedding its text", async () => {
    const { client } = clientReturning(dashboard());
    const onOpenSubject = vi.fn();
    render(<UsageWorkspace client={client} onOpenSubject={onOpenSubject} />);

    await waitFor(() =>
      expect(screen.getByRole("table", { name: "Usage request detail" })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole("button", { name: "chat-thread/thread-1" }));
    expect(onOpenSubject).toHaveBeenCalledWith("chat-thread", "thread-1");
  });

  it("lists contributing and stale hosts and says other hosts are excluded", async () => {
    const { client } = clientReturning(dashboard());
    render(<UsageWorkspace client={client} />);

    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Contributing hosts" })).toBeInTheDocument(),
    );
    const hosts = screen.getByRole("region", { name: "Contributing hosts" });
    expect(within(hosts).getByText("local")).toBeInTheDocument();
    expect(within(hosts).getByText(/Stale · last synchronized/)).toBeInTheDocument();
    expect(within(hosts).getByText(/not a host with zero usage/)).toBeInTheDocument();
  });

  it("states which attribution dimensions the host cannot source", async () => {
    const { client } = clientReturning(dashboard());
    render(<UsageWorkspace client={client} />);

    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Attribution sources" })).toBeInTheDocument(),
    );
    const sources = screen.getByRole("region", { name: "Attribution sources" });
    expect(within(sources).getByText("Not recorded")).toBeInTheDocument();
    expect(within(sources).getByText("Partly recorded")).toBeInTheDocument();
    expect(
      within(sources).getByText(/No reviewed or user-supplied pricing metadata/),
    ).toBeInTheDocument();
  });

  it("re-queries the host when the range changes", async () => {
    const { client, load } = clientReturning(dashboard());
    render(<UsageWorkspace client={client} />);

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Usage range" }),
      "All recorded usage",
    );
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    const lastRequest = load.mock.calls[load.mock.calls.length - 1]![0] as UsageDashboardRequest;
    expect(lastRequest.filter).toEqual({});
  });

  it("applies an initial filter so a thread can open pre-filtered", async () => {
    const { client, load } = clientReturning(dashboard());
    render(
      <UsageWorkspace
        client={client}
        initialFilter={
          {
            subjectAggregateType: "chat-thread",
            subjectAggregateId: "thread-1",
          } as UsageQueryFilter
        }
      />,
    );

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    const request = load.mock.calls[0]![0] as UsageDashboardRequest;
    expect(request.filter?.subjectAggregateId).toBe("thread-1");
  });

  it("explains the empty state instead of showing zeroes as a measurement", async () => {
    const { client } = clientReturning(emptyDashboard());
    render(<UsageWorkspace client={client} />);

    await waitFor(() =>
      expect(screen.getByRole("region", { name: "No usage" })).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/appears here as request activity with usage marked unavailable/),
    ).toBeInTheDocument();
  });

  it("surfaces an unauthorized host without rendering stale numbers", async () => {
    const client: UsageDashboardClient = {
      load: vi
        .fn()
        .mockRejectedValue(new UsageDashboardClientFailure("Usage is not authorized.", 401)),
    };
    render(<UsageWorkspace client={client} />);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("not authorized"));
    expect(screen.queryByRole("region", { name: "Summary" })).not.toBeInTheDocument();
  });

  it("clears the previous rows when the newly filtered request is refused", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(dashboard())
      .mockRejectedValue(new UsageDashboardClientFailure("Project is out of scope.", 403));
    render(<UsageWorkspace client={{ load } as UsageDashboardClient} />);
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Summary" })).toBeInTheDocument(),
    );

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Filter usage by mode" }), [
      "work",
    ]);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("out of scope"));
    // The refused filter must not be sitting above the previous filter's rows.
    expect(screen.queryByRole("region", { name: "Summary" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("table", { name: "Usage by provider instance" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "No usage" })).not.toBeInTheDocument();
  });

  it("marks the shown figures stale when the same query fails to refresh", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(dashboard())
      .mockRejectedValue(new UsageDashboardClientFailure("Host is down.", 0));
    render(<UsageWorkspace client={{ load } as UsageDashboardClient} />);
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Summary" })).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole("button", { name: "Refresh usage" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Host is down."));
    expect(screen.getByRole("region", { name: "Summary" })).toBeInTheDocument();
    expect(screen.getByRole("note", { name: "Stale usage" })).toHaveTextContent(
      /last successful read/i,
    );
  });

  it("retries on request", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new UsageDashboardClientFailure("Host is down.", 0))
      .mockResolvedValue(dashboard());
    render(<UsageWorkspace client={{ load } as UsageDashboardClient} />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Summary" })).toBeInTheDocument(),
    );
  });

  it("uses the same surface at narrow width", async () => {
    const { client } = clientReturning(dashboard());
    render(<UsageWorkspace client={client} isNarrow />);

    await waitFor(() =>
      expect(screen.getByRole("table", { name: "Usage by provider instance" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("table", { name: "Usage by provider instance" })).toHaveClass(
      "usage-table--narrow",
    );
  });

  it("shows cache hit and miss rates for the host's own caches", async () => {
    const { client } = clientReturning(dashboard());
    render(<UsageWorkspace client={client} />);

    const section = await screen.findByRole("region", { name: "Cache efficiency" });
    expect(
      within(section).getByRole("meter", { name: "Project pull requests hit rate" }),
    ).toHaveValue(0.8);
    expect(
      within(section).getByRole("meter", { name: "Project pull requests miss rate" }),
    ).toHaveValue(1 - 0.8);
    expect(within(section).getByText("20%")).toBeVisible();
    expect(within(section).getByRole("meter", { name: "Token cache hit ratio" })).toHaveValue(0.75);
  });

  it("does not promise an automatic retry for a cache that never holds unattended refreshes", async () => {
    const paced = dashboard({
      cacheStats: {
        caches: [
          {
            key: "pull-request-list",
            label: "Project pull requests",
            hitCount: 8,
            missCount: 2,
            hitRatio: 0.8,
            lastRefreshAt: queryAt,
            stalenessMs: 60_000,
            failureStreak: 2,
          },
        ],
        providerTokenCaches: [],
      },
    } as unknown as Partial<UsageDashboardResponse>);
    const { client } = clientReturning(paced);
    render(<UsageWorkspace client={client} />);

    const section = await screen.findByRole("region", { name: "Cache efficiency" });
    expect(within(section).getByText(/2 failures in a row/)).toBeVisible();
    expect(within(section).getByText(/next read may retry/)).toBeVisible();
    expect(within(section).queryByText(/automatic retry/)).toBeNull();
  });

  it("says a cache being paced after failures can still be refreshed by hand", async () => {
    const paced = dashboard({
      cacheStats: {
        caches: [
          {
            key: "github-catalogue",
            label: "GitHub catalogue",
            hitCount: 1,
            missCount: 4,
            hitRatio: 0.2,
            failureStreak: 3,
            retryAt: new Date(Date.now() + 900_000).toISOString(),
          },
        ],
        providerTokenCaches: [],
      },
    } as unknown as Partial<UsageDashboardResponse>);
    const { client } = clientReturning(paced);
    render(<UsageWorkspace client={client} />);

    const section = await screen.findByRole("region", { name: "Cache efficiency" });
    expect(within(section).getByText(/3 failures in a row/)).toBeVisible();
    expect(within(section).getByText(/refresh still works/)).toBeVisible();
    expect(within(section).getByText("Never refreshed")).toBeVisible();
  });

  it("does not claim prompt-cache reuse is zero when no provider reported it", async () => {
    const noReuse = dashboard({
      cacheStats: { caches: [], providerTokenCaches: [] },
    } as unknown as Partial<UsageDashboardResponse>);
    const { client } = clientReturning(noReuse);
    render(<UsageWorkspace client={client} />);

    await screen.findByRole("region", { name: "Summary" });
    expect(screen.queryByRole("region", { name: "Cache efficiency" })).toBeNull();
  });
});
