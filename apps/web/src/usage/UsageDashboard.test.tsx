import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  UsageExportRequest,
  UsageQueryRequest,
  UsageQueryResponse,
  UsageResetRequest,
  UsageRetentionRequest,
  UsagePurgeResult,
} from "@octant/contracts/usage-rpc";
import type { UsageClient, UsageExportResult } from "@octant/client-runtime/usage-client";
import type { UtcTimestamp, AggregateType, AggregateId } from "@octant/contracts/events";
import type { UsageReconciliationId } from "@octant/contracts/context";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import { UsageDashboard } from "./UsageDashboard";

const queryAt = "2026-07-24T12:00:00.000Z" as UtcTimestamp;

function emptyResponse(): UsageQueryResponse {
  return {
    records: [],
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
    byProvider: [],
    byCategory: [],
    byDay: [],
    byWeek: [],
    cumulative: [],
    topConsumers: [],
    hasMore: false,
    queryAt,
  };
}

function seededResponse(): UsageQueryResponse {
  return {
    records: [
      {
        reconciliationId: "rec-1" as UsageReconciliationId,
        subject: {
          aggregateType: "chat-thread" as AggregateType,
          aggregateId: "thread-1" as AggregateId,
        },
        providerInstanceId: "provider-1" as ProviderInstanceId,
        modelId: "gpt-4o" as ProviderModelId,
        requestShape: "chat-turn",
        quality: "exact",
        inputTokens: 100,
        outputTokens: 50,
        plannedInputTokens: 95,
        varianceTokens: 5,
        attribution: [{ category: "conversation", plannedTokens: 95, quality: "exact" }],
        observedAt: queryAt,
      },
    ],
    totals: {
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalRequests: 1,
      exactCount: 1,
      estimatedCount: 0,
      reconciledCount: 0,
      staleCount: 0,
      unavailableCount: 0,
    },
    byProvider: [
      {
        providerInstanceId: "provider-1" as ProviderInstanceId,
        modelId: "gpt-4o" as ProviderModelId,
        totalInputTokens: 100,
        totalOutputTokens: 50,
        requestCount: 1,
      },
    ],
    byCategory: [{ category: "conversation", plannedTokens: 95, entryCount: 1 }],
    byDay: [
      {
        bucketStart: queryAt,
        inputTokens: 100,
        outputTokens: 50,
        requestCount: 1,
        exactCount: 1,
        estimatedCount: 0,
        reconciledCount: 0,
        staleCount: 0,
        unavailableCount: 0,
      },
    ],
    byWeek: [
      {
        bucketStart: queryAt,
        inputTokens: 100,
        outputTokens: 50,
        requestCount: 1,
        exactCount: 1,
        estimatedCount: 0,
        reconciledCount: 0,
        staleCount: 0,
        unavailableCount: 0,
      },
    ],
    cumulative: [
      {
        bucketStart: queryAt,
        cumulativeInputTokens: 100,
        cumulativeOutputTokens: 50,
        cumulativeRequests: 1,
      },
    ],
    topConsumers: [
      {
        subjectType: "chat-thread" as AggregateType,
        subjectId: "thread-1" as AggregateId,
        inputTokens: 100,
        outputTokens: 50,
        requestCount: 1,
      },
    ],
    hasMore: false,
    queryAt,
  };
}

function unavailableResponse(): UsageQueryResponse {
  const base = seededResponse();
  return {
    ...base,
    records: [
      {
        ...base.records[0]!,
        quality: "unavailable",
        inputTokens: 0,
        outputTokens: 0,
      },
    ],
    totals: {
      ...base.totals,
      exactCount: 0,
      unavailableCount: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    },
  };
}

function createMockClient(response: UsageQueryResponse): UsageClient {
  return {
    query: vi.fn(async (_request: UsageQueryRequest) => response),
    export: vi.fn(
      async (request: UsageExportRequest): Promise<UsageExportResult> => ({
        format: request.format,
        body: "reconciliationId\nrec-1",
      }),
    ),
    reset: vi.fn(
      async (_request: UsageResetRequest): Promise<UsagePurgeResult> => ({
        purgedCount: 1,
        occurredAt: queryAt,
      }),
    ),
    retain: vi.fn(
      async (_request: UsageRetentionRequest): Promise<UsagePurgeResult> => ({
        purgedCount: 1,
        occurredAt: queryAt,
      }),
    ),
  };
}

describe("UsageDashboard", () => {
  it("shows a loading state then renders totals and quality badges", async () => {
    const client = createMockClient(seededResponse());
    render(<UsageDashboard client={client} />);
    expect(await screen.findByText("Total requests")).toBeInTheDocument();
    expect(screen.getByText("Exact: 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Usage by provider")).toBeInTheDocument();
  });

  it("renders daily, weekly, and cumulative activity views", async () => {
    const user = userEvent.setup();
    const client = createMockClient(seededResponse());
    render(<UsageDashboard client={client} />);
    expect(await screen.findByLabelText("daily activity")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Weekly" }));
    expect(screen.getByLabelText("weekly activity")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cumulative" }));
    expect(screen.getByLabelText("cumulative activity")).toBeInTheDocument();
  });

  it("renders top consumers", async () => {
    const client = createMockClient(seededResponse());
    render(<UsageDashboard client={client} />);
    expect(await screen.findByLabelText("Top usage consumers")).toBeInTheDocument();
    expect(screen.getByText("thread-1")).toBeInTheDocument();
  });

  it("shows an empty state when no records match", async () => {
    const client = createMockClient(emptyResponse());
    render(<UsageDashboard client={client} />);
    expect(
      await screen.findByText("No usage records match the selected filters."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Unavailable: 0")).not.toBeInTheDocument();
  });

  it("shows an error state with a retry button when the query fails", async () => {
    const client: UsageClient = {
      query: vi.fn(async () => {
        throw new Error("Cannot load usage data.");
      }),
      export: vi.fn(async () => ({ format: "csv" as const, body: "" })),
      reset: vi.fn(async () => ({ purgedCount: 0, occurredAt: queryAt })),
      retain: vi.fn(async () => ({ purgedCount: 0, occurredAt: queryAt })),
    };
    render(<UsageDashboard client={client} />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });

  it("always renders the unavailable quality badge and never hides unavailable as zero", async () => {
    const client = createMockClient(unavailableResponse());
    render(<UsageDashboard client={client} />);
    expect(await screen.findByText("Unavailable: 1")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Some usage is unavailable or estimated and shown as measurement quality, never as zero cost./,
      ),
    ).toBeInTheDocument();
  });

  it("renders measured advanced dimensions and explicit unavailable values", async () => {
    const client = createMockClient({
      ...seededResponse(),
      totals: {
        ...seededResponse().totals,
        totalReasoningTokens: 12,
        totalCacheReadInputTokens: 8,
        totalCacheWriteInputTokens: 3,
        totalProviderExecutionDurationMs: 450,
      },
    });
    render(<UsageDashboard client={client} />);
    expect(await screen.findByText("Reasoning tokens")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("Cache read tokens")).toBeInTheDocument();
    expect(screen.getByText("Cache write tokens")).toBeInTheDocument();
    expect(screen.getByText("Provider execution time")).toBeInTheDocument();
  });

  it("keeps previous data visible while a filter query refreshes", async () => {
    let resolveNext: ((value: UsageQueryResponse) => void) | undefined;
    const client = createMockClient(seededResponse());
    client.query = vi
      .fn()
      .mockResolvedValueOnce(seededResponse())
      .mockImplementationOnce(
        () => new Promise<UsageQueryResponse>((resolve) => (resolveNext = resolve)),
      );
    render(<UsageDashboard client={client} />);
    expect(await screen.findByText("thread-1")).toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText("Filter by provider instance id"), {
      target: { value: "provider-2" },
    });
    expect(screen.getByText("thread-1")).toBeInTheDocument();
    expect(screen.getByText("Refreshing usage data…")).toBeInTheDocument();
    resolveNext?.(emptyResponse());
    await waitFor(() => expect(screen.getByText("No usage records match the selected filters.")));
  });

  it("does not let an older filter response overwrite the newest result", async () => {
    const resolvers: Array<(value: UsageQueryResponse) => void> = [];
    const client = createMockClient(seededResponse());
    client.query = vi.fn(
      () => new Promise<UsageQueryResponse>((resolve) => resolvers.push(resolve)),
    );
    render(<UsageDashboard client={client} />);
    resolvers.shift()?.(seededResponse());
    expect(await screen.findByText("thread-1")).toBeInTheDocument();

    const provider = screen.getByLabelText("Filter by provider instance id");
    fireEvent.change(provider, { target: { value: "provider-1" } });
    fireEvent.change(provider, { target: { value: "provider-2" } });
    expect(resolvers).toHaveLength(2);
    resolvers[1]!(emptyResponse());
    await waitFor(() => expect(screen.getByText("No usage records match the selected filters.")));
    resolvers[0]!(seededResponse());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText("No usage records match the selected filters.")).toBeInTheDocument();
  });

  it("renders keyboard-usable custom date range controls", async () => {
    const client = createMockClient(seededResponse());
    render(<UsageDashboard client={client} />);
    expect(await screen.findByLabelText("Usage from date")).toBeInTheDocument();
    expect(screen.getByLabelText("Usage to date")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Usage from date"), { target: { value: "2026-07-20" } });
    await waitFor(() =>
      expect(client.query).toHaveBeenLastCalledWith(
        expect.objectContaining({
          timeZone: expect.any(String),
        }),
      ),
    );
  });

  it("requires confirmation before exporting CSV", async () => {
    const user = userEvent.setup();
    const client = createMockClient(seededResponse());
    render(<UsageDashboard client={client} />);
    await screen.findByText("Total requests");
    await user.click(screen.getByRole("button", { name: /Export CSV/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/Export usage data as CSV/);
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(client.export).toHaveBeenCalled();
  });

  it("requires confirmation before resetting usage", async () => {
    const user = userEvent.setup();
    const client = createMockClient(seededResponse());
    render(<UsageDashboard client={client} />);
    await screen.findByText("Total requests");
    await user.click(screen.getByRole("button", { name: /Reset all usage/ }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(/Reset all usage records/);
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(client.reset).toHaveBeenCalled();
  });

  it("requires confirmation before purging old records", async () => {
    const user = userEvent.setup();
    const client = createMockClient(seededResponse());
    render(<UsageDashboard client={client} />);
    await screen.findByText("Total requests");
    await user.click(screen.getByRole("button", { name: /Purge older than 30 days/ }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(/Purge usage records older/);
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(client.retain).toHaveBeenCalled();
  });

  it("exposes filter controls for provider, model, host, mode, project, thread, request shape, category, and quality", async () => {
    const client = createMockClient(seededResponse());
    render(<UsageDashboard client={client} />);
    expect(await screen.findByLabelText("Filter by provider instance id")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter by model id")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter by host id")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter by mode")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter by project id")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter by thread id")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter by request shape")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter by context category")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter by measurement quality")).toBeInTheDocument();
  });

  it("removes a text filter when its input is cleared", async () => {
    const client = createMockClient(seededResponse());
    render(<UsageDashboard client={client} />);
    const providerInput = await screen.findByLabelText("Filter by provider instance id");

    fireEvent.change(providerInput, { target: { value: "provider-1" } });
    await waitFor(() =>
      expect(client.query).toHaveBeenLastCalledWith({
        filter: { providerInstanceId: "provider-1" },
      }),
    );

    const updatedProviderInput = await screen.findByLabelText("Filter by provider instance id");
    fireEvent.input(updatedProviderInput, { target: { value: "" } });
    await waitFor(() => expect(client.query).toHaveBeenLastCalledWith({ filter: {} }));
  });

  it("applies the narrow activity table class when isNarrow is set", async () => {
    const client = createMockClient(seededResponse());
    render(<UsageDashboard client={client} isNarrow />);
    const table = await screen.findByRole("table", { name: "daily activity" });
    expect(table.className).toContain("usage-dashboard__table--narrow");
  });
});
