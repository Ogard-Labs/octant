import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_HOST_RESOURCE_POLICY, decodeAgentRunPolicySettings } from "@octant/contracts";
import type { KeepAwakeStatus } from "../shell/hostBridge";
import { HostResourceSettings } from "./HostResourceSettings";

describe("computer resource settings", () => {
  it.each([
    { memory: { availableMemoryBytes: 8 * 2 ** 30 }, label: "8 GiB available" },
    { memory: { memoryPressure: "normal" as const }, label: "Memory pressure: normal" },
  ])(
    "shows $label and saves a pause without changing helper permissions",
    async ({ memory, label }) => {
      const settings = decodeAgentRunPolicySettings({
        creationPosture: "off",
        version: 2,
        updatedAt: "2026-11-12T12:00:00.000Z",
      });
      const update = vi.fn(async (input) =>
        decodeAgentRunPolicySettings({
          ...settings,
          resourcePolicy: input.resourcePolicy,
          version: 3,
        }),
      );
      const view = render(
        <HostResourceSettings
          client={{
            current: async () => settings,
            update,
            resources: async () => ({
              policy: DEFAULT_HOST_RESOURCE_POLICY,
              cores: 8,
              cpuPercent: 20,
              totalMemoryBytes: 16 * 2 ** 30,
              ...memory,
              commands: 2,
              workers: 2,
              agents: 2,
              activeCommands: 1,
              queuedCommands: 1,
              reason: "ready",
            }),
          }}
        />,
      );
      expect(await screen.findByText(/8 cores/)).toBeTruthy();
      expect(screen.getByText((text) => text.includes(label))).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Pause new work" }));
      await waitFor(() =>
        expect(update).toHaveBeenCalledWith(
          expect.objectContaining({
            creationPosture: "off",
            expectedVersion: 2,
            resourcePolicy: expect.objectContaining({ mode: "paused" }),
          }),
        ),
      );
      expect(await screen.findByRole("button", { name: "Resume automatic limits" })).toBeTruthy();
      view.unmount();
    },
  );
  it("draws its rows from the first frame with nothing to read or press, so the page holds still", async () => {
    let answer: (value: ReturnType<typeof decodeAgentRunPolicySettings>) => void = () => undefined;
    const current = vi.fn(
      () =>
        new Promise<ReturnType<typeof decodeAgentRunPolicySettings>>((done) => {
          answer = done;
        }),
    );
    render(<HostResourceSettings client={{ current, update: vi.fn() }} />);

    const group = screen.getByRole("group", { name: "Computer resource limits" });
    expect(screen.getByRole("heading", { name: "Computer resources" })).toBeVisible();
    expect(screen.getByText("Concurrent commands")).toBeVisible();
    expect(group).toBeDisabled();
    expect(group).toHaveAttribute("data-loading", "true");
    expect(screen.getByText("Reading the host's load…")).toBeVisible();

    answer(
      decodeAgentRunPolicySettings({
        creationPosture: "off",
        version: 2,
        updatedAt: "2026-11-12T12:00:00.000Z",
      }),
    );
    await waitFor(() => expect(group).not.toHaveAttribute("data-loading"));
    expect(group).toBeEnabled();
  });

  it("makes a failed load retryable instead of presenting unsaved defaults", async () => {
    const current = vi.fn().mockRejectedValue(new Error("offline"));
    render(<HostResourceSettings client={{ current, update: vi.fn() }} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(current).toHaveBeenCalledTimes(2));
  });

  it("offers While on power, Always, and Never for keeping the computer awake, saves changes immediately, and shows live held, idle, and unavailable statuses", async () => {
    const user = userEvent.setup();
    let stored = decodeAgentRunPolicySettings({
      creationPosture: "automatic",
      version: 1,
      updatedAt: "2026-11-19T20:00:00.000Z",
    });
    const update = vi.fn(async (input) => {
      stored = decodeAgentRunPolicySettings({
        ...stored,
        resourcePolicy: input.resourcePolicy,
        version: stored.version + 1,
      });
      return stored;
    });
    let publishStatus: ((status: KeepAwakeStatus) => void) | undefined;
    const refreshKeepAwakeStatus = vi.fn(
      async (): Promise<KeepAwakeStatus> => ({
        state: "active",
        summary: "Kept awake: 2 turns running",
      }),
    );

    render(
      <HostResourceSettings
        client={{ current: async () => stored, update }}
        hostBridge={{
          subscribeKeepAwakeStatus: (listener) => {
            publishStatus = listener;
            listener({ state: "idle", reason: "no-work" });
            return () => {
              publishStatus = undefined;
            };
          },
          refreshKeepAwakeStatus,
        }}
      />,
    );

    const select = await screen.findByRole("combobox", {
      name: "Keep the computer awake while agents work",
    });
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveTextContent("While on power");
    expect(screen.getByText("Idle — no agent work running.")).toBeVisible();

    await user.click(select);
    expect(await screen.findByRole("option", { name: "While on power" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Always" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Never" })).toBeVisible();

    await user.click(screen.getByRole("option", { name: "Always" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          creationPosture: "automatic",
          expectedVersion: 1,
          resourcePolicy: expect.objectContaining({ keepAwake: "always" }),
        }),
      ),
    );
    expect(refreshKeepAwakeStatus).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Kept awake: 2 turns running")).toBeVisible();

    // Live updates from the desktop main process reflect battery, disabled, and unavailable states.
    act(() => publishStatus?.({ state: "idle", reason: "on-battery" }));
    expect(screen.getByText("Idle — on battery power.")).toBeVisible();

    act(() => publishStatus?.({ state: "idle", reason: "disabled" }));
    expect(screen.getByText("Off — this computer may sleep while agents work.")).toBeVisible();

    act(() => publishStatus?.({ state: "unavailable" }));
    expect(
      screen.getByText("Unavailable — this computer did not allow preventing sleep."),
    ).toBeVisible();

    // Saving limits keeps the saved keep-awake choice intact.
    fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
    await waitFor(() =>
      expect(update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          expectedVersion: 2,
          resourcePolicy: expect.objectContaining({ keepAwake: "always" }),
        }),
      ),
    );
  });
});
