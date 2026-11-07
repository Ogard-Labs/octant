import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { HostHealthHistory, HostHealthSample } from "@octant/contracts";
import { HostHealthSection } from "./HostHealthSection";

function sample(minute: number, overrides: Partial<HostHealthSample> = {}): HostHealthSample {
  return {
    sampledAt: new Date(Date.UTC(2026, 10, 7, 10, minute)).toISOString(),
    windowMs: 60_000,
    processStartedAt: "2026-11-07T09:00:00.000Z",
    rssBytes: 200 * 1_048_576,
    heapUsedBytes: 80 * 1_048_576,
    databaseBytes: 64 * 1_048_576,
    eventLoopLagCount: 0,
    eventLoopLagWorstMs: 0,
    slowStatementCount: 0,
    slowStatementWorstMs: 0,
    latency: [{ key: "rpc", count: 20, p50Ms: 4, p95Ms: 30, maxMs: 60 }],
    ...overrides,
  } as HostHealthSample;
}

function history(samples: ReadonlyArray<HostHealthSample>): HostHealthHistory {
  return {
    generatedAt: "2026-11-07T12:00:00.000Z" as never,
    resolution: "minute",
    retentionDays: 14,
    samples,
    processStarts: [...new Set(samples.map((entry) => entry.processStartedAt))].sort() as never,
  };
}

const when = (timestamp: string) => timestamp.slice(11, 16);

describe("host health on the Diagnostics page", () => {
  it("shows each measure's peak and when, notes restarts, and has the same readings as a table", async () => {
    const client = {
      hostHealth: vi.fn(async () =>
        history([
          sample(1),
          sample(2, {
            rssBytes: 900 * 1_048_576,
            eventLoopLagCount: 3,
            eventLoopLagWorstMs: 1_250,
          }),
          sample(3, { processStartedAt: "2026-11-07T10:02:30.000Z" as never }),
        ]),
      ),
    };
    render(
      <HostHealthSection client={client} from="2026-11-07T00:00:00.000Z" readKey={1} when={when} />,
    );

    const section = await screen.findByRole("region", { name: "Host health" });
    expect(within(section).getByText("Peak 900 MB · 10:02")).toBeInTheDocument();
    expect(within(section).getByText("Peak 1,250 ms · 10:02")).toBeInTheDocument();
    expect(within(section).getByText(/Restarted 1 time: 10:02\./)).toBeInTheDocument();
    expect(client.hostHealth).toHaveBeenCalledWith({ from: "2026-11-07T00:00:00.000Z" });

    await userEvent.click(within(section).getByText("Show as a table"));
    expect(within(section).getAllByRole("row")).toHaveLength(4);
  });

  it("says when there are no samples yet, and when the host does not answer", async () => {
    const empty = { hostHealth: vi.fn(async () => history([])) };
    const { unmount } = render(
      <HostHealthSection client={empty} from={undefined} readKey={1} when={when} />,
    );
    expect(await screen.findByText(/No samples yet/)).toBeInTheDocument();
    unmount();

    const failing = {
      hostHealth: vi.fn(async () => {
        throw new Error("503");
      }),
    };
    render(<HostHealthSection client={failing} from={undefined} readKey={1} when={when} />);
    expect(
      await screen.findByText("This host did not answer its health history."),
    ).toBeInTheDocument();
  });
});
