import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  TurnDiagnosticsReport,
  TurnMetricsRecord,
  UsageDiagnosticsRequest,
} from "@octant/contracts";
import { buildTurnDiagnosticsReport } from "@octant/domain";
import { TurnDiagnosticsWorkspace } from "./TurnDiagnosticsWorkspace";
import { UsageNamesProvider } from "./UsageName";
import { UsageWorkspace } from "./UsageWorkspace";

const provider = "66000000-0000-4000-8000-000000000001";
const codeThread = "66000000-0000-4000-8000-0000000000c1";
const chatThread = "66000000-0000-4000-8000-0000000000c2";
const now = Date.parse("2026-11-07T12:00:00.000Z");

function turn(overrides: Partial<Record<keyof TurnMetricsRecord, unknown>>): TurnMetricsRecord {
  return {
    threadId: codeThread,
    mode: "code",
    providerInstanceId: provider,
    modelId: "model-fast",
    stopReason: "end-of-turn",
    usage: { inputTokens: 10_000, outputTokens: 200, cacheReadInputTokens: 8_000 },
    metrics: {
      precision: "exact",
      wallMs: 9_000,
      timeToFirstTokenMs: 1_200,
      decodeOutputTokens: 200,
      decodeMs: 4_000,
      toolMs: 0,
      modelCalls: 1,
    },
    diagnostics: {
      toolCalls: 3,
      toolFailures: 1,
      tools: [
        { toolName: "Bash", calls: 3, failed: 1, unfinished: 0, totalMs: 3_000, maxMs: 2_000 },
      ],
    },
    startedAt: "2026-11-07T10:00:00.000Z",
    endedAt: "2026-11-07T10:00:09.000Z",
    ...overrides,
  } as TurnMetricsRecord;
}

function report(records: ReadonlyArray<TurnMetricsRecord>): TurnDiagnosticsReport {
  return buildTurnDiagnosticsReport(records, {
    generatedAt: "2026-11-07T12:00:00.000Z",
    bucket: "day",
    timeZone: "UTC",
  });
}

const troubledReport = report([
  turn({}),
  turn({
    threadId: chatThread,
    mode: "chat",
    stopReason: "failed",
    metrics: { precision: "unavailable", wallMs: 2_000 },
    diagnostics: {
      toolCalls: 0,
      toolFailures: 0,
      failure: {
        category: "rate-limited",
        usageLimit: "temporary",
        message: "Too many requests, slow down.",
      },
    },
    startedAt: "2026-11-07T11:00:00.000Z",
    endedAt: "2026-11-07T11:00:02.000Z",
  }),
]);

function mount(
  diagnostics: (request: UsageDiagnosticsRequest) => Promise<TurnDiagnosticsReport>,
  onOpenSubject = vi.fn(),
) {
  const client = { diagnostics: vi.fn(diagnostics) };
  render(
    <UsageNamesProvider
      names={
        new Map([
          [`provider/${provider}`, "Claude Code"],
          [`chat-thread/${chatThread}`, "Quarterly report"],
        ])
      }
    >
      <TurnDiagnosticsWorkspace
        client={client}
        now={() => now}
        onOpenSubject={onOpenSubject}
        providers={[]}
        timeZone="UTC"
      />
    </UsageNamesProvider>,
  );
  return { client, onOpenSubject };
}

describe("the Diagnostics page", () => {
  it("shows how turns ended, why they failed, which tools broke, and each model's speed", async () => {
    mount(async () => troubledReport);

    const summary = await screen.findByRole("region", { name: "Summary" });
    expect(within(summary).getByText("Failed").nextSibling?.textContent).toBe("1 · 50%");
    expect(within(summary).getByText("Tool failures").nextSibling?.textContent).toBe(
      "1 of 3 calls · 33%",
    );

    const causes = screen.getByRole("table", { name: "Failures by cause" });
    expect(within(causes).getByText("Rate limited")).toBeInTheDocument();
    expect(within(causes).getByText("Too many requests, slow down.")).toBeInTheDocument();

    const tools = screen.getByRole("table", { name: "Tool reliability" });
    expect(within(tools).getByRole("rowheader", { name: "Bash" })).toBeInTheDocument();
    expect(within(tools).getByText("1 · 33%")).toBeInTheDocument();

    const models = screen.getByRole("table", { name: "Benchmarks by model" });
    const row = within(models).getByRole("row", { name: /model-fast/ });
    expect(within(row).getByText("Claude Code")).toBeInTheDocument();
    expect(within(row).getByText("1.2 s / 1.2 s")).toBeInTheDocument();
    expect(within(row).getByText("50 tok/s / 50 tok/s")).toBeInTheDocument();
    expect(within(row).getByText("80%")).toBeInTheDocument();
  });

  it("opens the thread of a turn to investigate", async () => {
    const { onOpenSubject } = mount(async () => troubledReport);

    const turns = await screen.findByRole("table", { name: "Turns to investigate" });
    const failed = within(turns).getByRole("row", { name: /Quarterly report/ });
    expect(within(failed).getByText("Failed")).toBeInTheDocument();
    await userEvent.click(within(failed).getByRole("button", { name: /Open the thread/ }));

    expect(onOpenSubject).toHaveBeenCalledWith("chat-thread", chatThread);
  });

  it("says a speed no turn measured is unavailable rather than zero", async () => {
    mount(async () =>
      report([turn({ metrics: { precision: "unavailable", wallMs: 1_000 }, usage: undefined })]),
    );

    const summary = await screen.findByRole("region", { name: "Summary" });
    expect(within(summary).getByText("Speed, typical").nextSibling?.textContent).toBe(
      "Unavailable",
    );
  });

  it("asks again for one mode when the mode filter changes", async () => {
    const { client } = mount(async () => troubledReport);
    await screen.findByRole("region", { name: "Summary" });

    await userEvent.click(screen.getByRole("combobox", { name: "Filter diagnostics by mode" }));
    await userEvent.click(await screen.findByRole("option", { name: "Work" }));

    await waitFor(() =>
      expect(client.diagnostics).toHaveBeenLastCalledWith(
        expect.objectContaining({
          filter: expect.objectContaining({ mode: "work" }),
          bucket: "day",
          timeZone: "UTC",
        }),
      ),
    );
    expect(client.diagnostics.mock.calls.at(-1)?.[0].filter?.from).toBe("2026-10-31T12:00:00.000Z");
  });

  it("states an empty range and a failed read, and retries on request", async () => {
    let fail = true;
    const { client } = mount(async () => {
      if (fail) throw new Error("Usage diagnostics failed with status 503.");
      return report([]);
    });

    expect(
      await screen.findByText("Usage diagnostics failed with status 503."),
    ).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("No turns in this range")).toBeInTheDocument();
    expect(client.diagnostics).toHaveBeenCalledTimes(2);
  });
});

describe("the Diagnostics report copy", () => {
  it("copies the whole report as JSON, and a newer reading replaces the note", async () => {
    const copyText = vi.fn(async (_text: string) => undefined);
    const client = { diagnostics: vi.fn(async () => troubledReport) };
    render(
      <TurnDiagnosticsWorkspace
        client={client}
        copyText={copyText}
        now={() => now}
        timeZone="UTC"
      />,
    );
    await screen.findByRole("region", { name: "Summary" });

    await userEvent.click(screen.getByRole("button", { name: "Copy diagnostics report as JSON" }));
    expect(JSON.parse(copyText.mock.calls[0]?.[0] ?? "{}")).toMatchObject({ turns: 2 });
    expect(screen.getByText("Report copied as JSON.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Refresh diagnostics" }));
    await waitFor(() => expect(screen.queryByText("Report copied as JSON.")).toBeNull());
  });

  it("says a provider that never reported its cache has no hit rate rather than 0%", async () => {
    const client = {
      diagnostics: vi.fn(async () =>
        report([turn({ usage: { inputTokens: 5_000, outputTokens: 10 } })]),
      ),
    };
    render(<TurnDiagnosticsWorkspace client={client} now={() => now} timeZone="UTC" />);

    const models = await screen.findByRole("table", { name: "Benchmarks by model" });
    expect(within(models).getAllByText("Not reported").length).toBeGreaterThan(0);
    expect(within(models).queryByText("0%")).toBeNull();
  });
});

describe("the Usage destination", () => {
  it("offers Diagnostics beside Octant records when the host can report them", async () => {
    const dashboardClient = { load: vi.fn(() => new Promise<never>(() => undefined)) };
    render(
      <UsageWorkspace
        client={dashboardClient as never}
        diagnosticsClient={{ diagnostics: vi.fn(async () => troubledReport) }}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Diagnostics" }));

    expect(await screen.findByRole("heading", { name: "Diagnostics" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Summary" })).toBeInTheDocument();
  });
});
