import { decodeHostResourceSnapshot } from "@octant/contracts/host-resources";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeCard } from "./HomeCard";
import { HomeDashboard } from "./HomeDashboard";
import {
  createComputersCard,
  type ComputersCardSource,
  type HostResourceRead,
} from "./ComputersCard";
import type { ComputersCardHost } from "./computers";

const now = Date.parse("2026-10-06T12:00:00.000Z");

function snapshot(cpuPercent = 42, disk = true) {
  return decodeHostResourceSnapshot({
    cores: 8,
    cpuPercent,
    memory: { usedBytes: 8 * 1024 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 * 1024 },
    ...(disk ? { disk: { usedBytes: 40, freeBytes: 60 } } : {}),
    sampledAt: "2026-10-06T12:00:00.000Z",
  });
}

function host(
  overrides: Partial<ComputersCardHost> & Pick<ComputersCardHost, "hostId" | "name">,
): ComputersCardHost {
  return {
    connection: "connected",
    figuresAllowed: true,
    ...overrides,
  };
}

function source(overrides: Partial<ComputersCardSource> = {}): ComputersCardSource {
  return {
    hosts: [host({ hostId: "local", name: "This computer", runningAgents: 2 })],
    launchHostId: "local",
    agentRunClient: undefined,
    runRevision: 0,
    now,
    readResources: vi.fn(
      async (): Promise<HostResourceRead> => ({
        status: "ready",
        snapshot: snapshot(),
      }),
    ),
    onOpenRunning: vi.fn(),
    ...overrides,
  };
}

function renderCard(cardSource: ComputersCardSource) {
  return render(<HomeCard definition={createComputersCard(cardSource)} />);
}

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});

describe("the Computers card", () => {
  it("names a connected host, its capacity, and monochrome load bars", async () => {
    renderCard(source());
    expect(await screen.findByText("This computer")).toBeVisible();
    expect(screen.getByText("Connected")).toBeVisible();
    expect(screen.getByText("8 cores · 16 GB")).toBeVisible();
    expect(screen.getByRole("meter", { name: "CPU 42 percent" })).toBeVisible();
    expect(screen.getByRole("meter", { name: "Memory 50 percent" })).toBeVisible();
    expect(screen.getByRole("meter", { name: "Disk 40 percent" })).toBeVisible();
    expect(screen.getByText("42%")).toBeVisible();
  });

  it("hides the disk bar when the volume figures are absent", async () => {
    renderCard(
      source({
        readResources: vi.fn(
          async (): Promise<HostResourceRead> => ({
            status: "ready",
            snapshot: snapshot(10, false),
          }),
        ),
      }),
    );
    expect(await screen.findByRole("meter", { name: "CPU 10 percent" })).toBeVisible();
    expect(screen.queryByRole("meter", { name: /Disk/ })).not.toBeInTheDocument();
  });

  it("says reconnecting in words and still shows the bars it could read", async () => {
    renderCard(
      source({
        hosts: [
          host({
            hostId: "studio",
            name: "Studio",
            connection: "reconnecting",
            runningAgents: 1,
          }),
        ],
      }),
    );
    expect(await screen.findByText("Reconnecting")).toBeVisible();
    expect(await screen.findByRole("meter", { name: "CPU 42 percent" })).toBeVisible();
  });

  it("shows an offline host's last seen and no bars", async () => {
    const readResources = vi.fn(
      async (): Promise<HostResourceRead> => ({
        status: "ready",
        snapshot: snapshot(),
      }),
    );
    renderCard(
      source({
        hosts: [
          host({
            hostId: "studio",
            name: "Studio",
            connection: "offline",
            figuresAllowed: false,
            lastSeenAt: "2026-10-06T11:56:00.000Z",
          }),
        ],
        readResources,
      }),
    );
    expect(await screen.findByText("Offline")).toBeVisible();
    expect(screen.getByText("Last seen 4m ago")).toBeVisible();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    expect(readResources).not.toHaveBeenCalled();
  });

  it("shows a connected host with no figures when this window lacks authority", async () => {
    const readResources = vi.fn(
      async (): Promise<HostResourceRead> => ({
        status: "ready",
        snapshot: snapshot(),
      }),
    );
    renderCard(
      source({
        hosts: [
          host({
            hostId: "studio",
            name: "Studio",
            connection: "connected",
            figuresAllowed: false,
          }),
        ],
        readResources,
      }),
    );
    expect(await screen.findByText("Connected")).toBeVisible();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    expect(screen.queryByText(/cores/)).not.toBeInTheDocument();
    expect(readResources).not.toHaveBeenCalled();
  });

  it("drops figures when the host refuses the read and keeps the host connected", async () => {
    renderCard(
      source({
        readResources: vi.fn(async (): Promise<HostResourceRead> => ({ status: "refused" })),
      }),
    );
    expect(await screen.findByText("Connected")).toBeVisible();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
  });

  it("opens Running for the host whose agent count was chosen", async () => {
    const onOpenRunning = vi.fn();
    const user = userEvent.setup();
    renderCard(
      source({
        hosts: [host({ hostId: "studio", name: "Studio", runningAgents: 3 })],
        onOpenRunning,
      }),
    );
    await user.click(await screen.findByRole("button", { name: "3 agents" }));
    expect(onOpenRunning).toHaveBeenCalledWith("studio");
  });

  it("leaves out the agent count for a host that does not report one", async () => {
    renderCard(
      source({
        hosts: [
          host({ hostId: "local", name: "This computer", runningAgents: 2 }),
          host({ hostId: "studio", name: "Studio" }),
        ],
      }),
    );
    expect(await screen.findByText("Studio")).toBeVisible();
    expect(screen.getByRole("button", { name: "2 agents" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: /agent/ })).toHaveLength(1);
  });

  it("drops figures a later read could not refresh instead of showing them as current", async () => {
    vi.useFakeTimers();
    const readResources = vi
      .fn<() => Promise<HostResourceRead>>()
      .mockResolvedValueOnce({ status: "ready", snapshot: snapshot() })
      .mockResolvedValue({ status: "unavailable" });
    renderCard(source({ readResources, pollMs: 10_000 }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("meter", { name: "CPU 42 percent" })).toBeVisible();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(readResources).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Connected")).toBeVisible();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
  });

  it("lists at most four hosts and says how many more there are", async () => {
    const user = userEvent.setup();
    renderCard(
      source({
        hosts: ["One", "Two", "Three", "Four", "Five", "Six"].map((name, index) =>
          host({ hostId: name, name, runningAgents: index }),
        ),
        readResources: vi.fn(async (): Promise<HostResourceRead> => ({ status: "refused" })),
      }),
    );
    expect(await screen.findByText("One")).toBeVisible();
    expect(screen.getByText("Four")).toBeVisible();
    expect(screen.queryByText("Five")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+2 more" }));
    expect(screen.getByText("Six")).toBeVisible();
  });

  it("reads while the card is visible and stops when the window is hidden", async () => {
    vi.useFakeTimers();
    const readResources = vi.fn(
      async (): Promise<HostResourceRead> => ({
        status: "ready",
        snapshot: snapshot(),
      }),
    );
    const view = renderCard(source({ readResources, pollMs: 10_000 }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(readResources).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(readResources).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(readResources).toHaveBeenCalledTimes(2);

    view.unmount();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(readResources).toHaveBeenCalledTimes(2);
  });

  it("does not read when the card is off", async () => {
    const readResources = vi.fn(
      async (): Promise<HostResourceRead> => ({
        status: "ready",
        snapshot: snapshot(),
      }),
    );
    render(
      <HomeDashboard
        cards={[createComputersCard(source({ readResources }))]}
        customization={{ order: [], visibility: [{ id: "computers", visible: false }] }}
        onCustomizationChange={vi.fn()}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText("This computer")).not.toBeInTheDocument();
    expect(readResources).not.toHaveBeenCalled();
  });
});
