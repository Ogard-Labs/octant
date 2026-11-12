import {
  decodeUtcTimestamp,
  type TurnMetricsRecord,
  type TurnMetricsSummary,
} from "@octant/contracts";
import type { CodeProviderLimit } from "@octant/contracts/code-operations";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ComposerContextMeter } from "../context/ComposerContextMeter";
import {
  ComposerContextMeterGate,
  ComposerContextMeterProvider,
} from "../context/composerContextMeterScope";
import { ThreadInfo } from "../composer/ThreadInfo";
import { ThreadComposer } from "../composer/ThreadComposer";
import { ThreadStatsBlock } from "./ThreadStats";
import { ThreadStatsDetailDialog } from "./ThreadStatsDetail";
import { ThreadStatsProvider } from "./threadStatsScope";

function turn(overrides: Partial<TurnMetricsRecord> = {}): TurnMetricsRecord {
  return {
    threadId: "0b6f7ac4-4d7e-4d07-8f35-2f64d7a2e3a1",
    mode: "code",
    providerInstanceId: "codex" as never,
    modelId: "gpt-5.6-luna" as never,
    stopReason: "end-of-turn",
    usage: { inputTokens: 48_000, cacheReadInputTokens: 44_160, outputTokens: 3_100 },
    metrics: {
      precision: "exact",
      wallMs: 80_000,
      timeToFirstTokenMs: 900,
      decodeOutputTokens: 410,
      decodeMs: 10_000,
      toolMs: 0,
      modelCalls: 1,
    },
    startedAt: decodeUtcTimestamp("2026-10-06T10:00:00.000Z"),
    endedAt: decodeUtcTimestamp("2026-10-06T10:01:20.000Z"),
    ...overrides,
  };
}

function summaryOf(turns: ReadonlyArray<TurnMetricsRecord>): TurnMetricsSummary {
  const first = turns[0];
  if (first === undefined) throw new Error("A summary needs a turn.");
  const measured = turns.filter((entry) => entry.metrics.precision !== "unavailable");
  return {
    turns,
    turnCount: turns.length,
    ...(first.usage === undefined ? {} : { usage: first.usage }),
    metrics: {
      turns: turns.length,
      measuredTurns: measured.length,
      precision: measured.some((entry) => entry.metrics.precision === "approximate")
        ? "approximate"
        : measured.length === 0
          ? "unavailable"
          : "exact",
      decodeOutputTokens: measured.reduce(
        (sum, entry) => sum + (entry.metrics.decodeOutputTokens ?? 0),
        0,
      ),
      decodeMs: measured.reduce((sum, entry) => sum + (entry.metrics.decodeMs ?? 0), 0),
      toolMs: 0,
      timeToFirstTokenTotalMs: measured.reduce(
        (sum, entry) => sum + (entry.metrics.timeToFirstTokenMs ?? 0),
        0,
      ),
    },
  };
}

function Harness(props: {
  readonly summary: TurnMetricsSummary | undefined;
  readonly limits?: ReadonlyArray<CodeProviderLimit>;
  /** Whether this composer is the active pane, which is the only one the meter's figures belong to. */
  readonly paneActive?: boolean;
  /** What stands in the composer's place; the bare stats line when absent. */
  readonly children?: ReactNode;
}) {
  return (
    <ThreadStatsProvider subjectKey="thread-a" summary={props.summary}>
      <ComposerContextMeterProvider
        status="not-planned"
        subjectKey="code-thread:a"
        {...(props.limits === undefined ? {} : { fallback: { limits: props.limits } })}
      >
        <ComposerContextMeterGate enabled={props.paneActive ?? true}>
          <ComposerContextMeter />
          {props.children === undefined ? <ThreadStatsBlock /> : props.children}
          <ThreadStatsDetailDialog />
        </ComposerContextMeterGate>
      </ComposerContextMeterProvider>
    </ThreadStatsProvider>
  );
}

// The dots between figures are drawn by CSS, so the figures are read one by one.
function figures(line: HTMLElement): ReadonlyArray<string> {
  return Array.from(line.querySelectorAll(".thread-stats__item"), (item) => item.textContent);
}

describe("the thread stats block", () => {
  it("states every reported figure in the Thread info panel", () => {
    const record = turn();
    render(<Harness summary={summaryOf([record])} />);

    const line = screen.getByTestId("thread-stats-block");
    expect(figures(line)).toEqual([
      "1 turn",
      "↑ 48k in",
      "↓ 3.1k out",
      "cache 92%",
      "41 tok/s",
      "0.9 s first token",
      "$0.01 est.",
    ]);
  });

  it("shows no stats line in an inactive pane, so it never carries another thread's figures", () => {
    render(
      <Harness
        limits={[{ window: "five_hour", status: "allowed", utilization: 0.12 }]}
        paneActive={false}
        summary={summaryOf([turn()])}
      />,
    );

    expect(screen.queryByTestId("thread-stats-block")).toBeNull();
  });

  it("shows the stats line only in the active pane of a split workspace", () => {
    render(
      <ThreadStatsProvider subjectKey="thread-a" summary={summaryOf([turn()])}>
        <ComposerContextMeterProvider status="not-planned" subjectKey="code-thread:a">
          <ComposerContextMeterGate enabled={false}>
            <ThreadStatsBlock />
          </ComposerContextMeterGate>
          <ComposerContextMeterGate enabled>
            <ThreadStatsBlock />
          </ComposerContextMeterGate>
        </ComposerContextMeterProvider>
      </ThreadStatsProvider>,
    );

    expect(screen.getAllByTestId("thread-stats-block")).toHaveLength(1);
  });

  it("shows no line for a provider that reported neither usage nor windows", () => {
    render(<Harness summary={undefined} />);

    expect(screen.queryByTestId("thread-stats-block")).toBeNull();
  });

  it("never rounds a partial cache hit up to a whole", () => {
    const record = turn({
      usage: { inputTokens: 200_000, cacheReadInputTokens: 199_900, outputTokens: 100 },
    });
    render(<Harness summary={summaryOf([record])} />);

    expect(screen.getByTestId("thread-stats-block")).toHaveTextContent("cache 99.95%");
    expect(screen.getByTestId("thread-stats-block")).not.toHaveTextContent("cache 100%");
  });

  it("marks an approximate speed with a tilde", () => {
    const record = turn({
      metrics: {
        precision: "approximate",
        wallMs: 20_000,
        timeToFirstTokenMs: 900,
        decodeOutputTokens: 410,
        decodeMs: 10_000,
        toolMs: 4_000,
        modelCalls: 1,
      },
    });
    render(<Harness summary={summaryOf([record])} />);

    const line = screen.getByTestId("thread-stats-block");
    expect(line).toHaveTextContent("~41 tok/s");
    expect(within(line).getByText("~41 tok/s")).toHaveAttribute("data-hinted", "true");
  });

  it("leaves out speed and first token when the speed is unavailable", () => {
    const record = turn({ metrics: { precision: "unavailable", wallMs: 5_000 } });
    render(<Harness summary={summaryOf([record])} />);

    const line = screen.getByTestId("thread-stats-block");
    expect(figures(line).join(" · ")).toContain("↑ 48k in · ↓ 3.1k out · cache 92%");
    expect(line).not.toHaveTextContent("tok/s");
    expect(line).not.toHaveTextContent("first token");
  });

  it("leaves out the cache share when the provider never reported a cache figure", () => {
    const record = turn({ usage: { inputTokens: 48_000, outputTokens: 3_100 } });
    render(<Harness summary={summaryOf([record])} />);

    expect(screen.getByTestId("thread-stats-block")).not.toHaveTextContent("cache");
  });

  it("drops est. when the provider reported the cost", () => {
    const record = turn({
      usage: { inputTokens: 48_000, outputTokens: 3_100, costUsd: 0.12 },
    });
    render(<Harness summary={summaryOf([record])} />);

    const line = screen.getByTestId("thread-stats-block");
    expect(line).toHaveTextContent("$0.12");
    expect(line).not.toHaveTextContent("est.");
  });

  it("leaves out the cost when the model has no price", () => {
    const record = turn({ modelId: "local-unpriced" as never });
    render(<Harness summary={summaryOf([record])} />);

    expect(screen.getByTestId("thread-stats-block")).not.toHaveTextContent("$");
  });

  it("shows no line for a provider that reported no usage and no timing", () => {
    const record = turn({ usage: undefined, metrics: { precision: "unavailable", wallMs: 2_000 } });
    render(<Harness summary={summaryOf([record])} />);

    expect(screen.queryByTestId("thread-stats-block")).not.toBeInTheDocument();
  });

  it("shows no line before the host has recorded a turn", () => {
    render(<Harness summary={undefined} />);

    expect(screen.queryByTestId("thread-stats-block")).not.toBeInTheDocument();
  });
});

describe("turn details", () => {
  it("opens from the line and shows the latest turn", async () => {
    const user = userEvent.setup();
    render(<Harness summary={summaryOf([turn()])} />);

    await user.click(screen.getByRole("button", { name: "Turn details" }));

    const dialog = screen.getByRole("dialog", { name: "Turn details" });
    expect(within(dialog).getByText("48,000")).toBeInTheDocument();
    expect(within(dialog).getByText("44,160")).toBeInTheDocument();
    expect(within(dialog).getByText("3,100")).toBeInTheDocument();
    expect(within(dialog).getByText("$0.01 est.")).toBeInTheDocument();
    expect(within(dialog).getByText("Turn 1 of 1")).toBeInTheDocument();
  });

  it("is reachable from the context meter while the line is hidden", async () => {
    const user = userEvent.setup();
    render(<Harness summary={summaryOf([turn()])}>{null}</Harness>);
    expect(screen.queryByTestId("thread-stats-block")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Show context usage/ }));
    await user.click(screen.getByRole("button", { name: "Turn details" }));

    expect(screen.getByRole("dialog", { name: "Turn details" })).toBeInTheDocument();
  });

  it("is reachable for a provider whose turns carry no usage, and says so", async () => {
    const user = userEvent.setup();
    const record = turn({ usage: undefined, metrics: { precision: "unavailable", wallMs: 2_000 } });
    render(<Harness summary={summaryOf([record])} />);

    await user.click(screen.getByRole("button", { name: /Show context usage/ }));
    await user.click(screen.getByRole("button", { name: "Turn details" }));

    const dialog = screen.getByRole("dialog", { name: "Turn details" });
    expect(dialog).toHaveTextContent("The provider reported no token usage for this turn.");
    expect(dialog).toHaveTextContent("Speed was not measured");
    expect(within(dialog).queryByText("Input")).not.toBeInTheDocument();
  });

  it("steps between turns and says which one of how many", async () => {
    const user = userEvent.setup();
    const older = turn({ usage: { inputTokens: 1_000, outputTokens: 50 } });
    const newer = turn({ usage: { inputTokens: 2_000, outputTokens: 80 } });
    render(<Harness summary={{ ...summaryOf([older, newer]), turnCount: 12 }} />);

    await user.click(screen.getByRole("button", { name: "Turn details" }));
    const dialog = screen.getByRole("dialog", { name: "Turn details" });
    expect(within(dialog).getByText("Turn 12 of 12")).toBeInTheDocument();
    expect(within(dialog).getByText("2,000")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Previous turn" }));

    expect(within(dialog).getByText("Turn 11 of 12")).toBeInTheDocument();
    expect(within(dialog).getByText("1,000")).toBeInTheDocument();
  });

  it("explains an approximate speed and lists tool time and retries", async () => {
    const user = userEvent.setup();
    const record = turn({
      metrics: {
        precision: "approximate",
        wallMs: 30_000,
        timeToFirstTokenMs: 900,
        decodeOutputTokens: 410,
        decodeMs: 10_000,
        toolMs: 15_000,
        modelCalls: 1,
        retries: 2,
      },
    });
    render(<Harness summary={summaryOf([record])} />);

    await user.click(screen.getByRole("button", { name: "Turn details" }));

    const dialog = screen.getByRole("dialog", { name: "Turn details" });
    expect(dialog).toHaveTextContent("~41 tok/s");
    expect(dialog).toHaveTextContent("Speed is measured per turn and includes some tool time.");
    expect(within(dialog).getByText("Tool time")).toBeInTheDocument();
    expect(within(dialog).getByText("Retries")).toBeInTheDocument();
  });
});

describe("the figures in a thread's Thread info panel", () => {
  it("stand at the top of the panel and nowhere under the composer", () => {
    const { container } = render(
      <Harness summary={summaryOf([turn()])}>
        <ThreadComposer
          info={
            <ThreadInfo>
              <p>Access row</p>
            </ThreadInfo>
          }
          input={<textarea aria-label="Message" className="composer-input" />}
          presentation="follow-up"
          row={{ actions: { kind: "send", send: { ariaLabel: "Send", onSend: vi.fn() } } }}
        />
      </Harness>,
    );

    const panel = container.querySelector(".thread-info__panel") as HTMLElement;
    const block = within(panel).getByTestId("thread-stats-block");
    expect(panel.firstElementChild).toBe(block);
    expect(figures(block)).toContain("cache 92%");
    // Under the composer there is the one row, and no line of figures.
    expect(container.querySelectorAll('[data-testid="thread-stats-block"]')).toHaveLength(1);
    expect(container.querySelector(".composer-frame")?.nextElementSibling).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide stats line" })).toBeNull();
    // The turn-details link they had stays.
    expect(
      within(block).getByRole("button", { name: "Turn details", hidden: true }),
    ).toBeInTheDocument();
  });
});
