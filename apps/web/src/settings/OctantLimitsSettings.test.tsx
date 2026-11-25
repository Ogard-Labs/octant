import { defaultShellSettings } from "@octant/domain";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OctantLimitsSettings } from "./OctantLimitsSettings";

describe("Octant's own limits in Settings", () => {
  it("shows each limit at its default and sends a change as a settings replacement", async () => {
    const onSettingsChange = vi.fn();
    render(
      <OctantLimitsSettings
        focusedSetting={undefined}
        onSettingsChange={onSettingsChange}
        settings={defaultShellSettings()}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Increase Coordinators per Project" }),
    );
    expect(onSettingsChange).toHaveBeenLastCalledWith({ coordinatorsPerProject: 5 });
    await userEvent.click(
      screen.getByRole("switch", { name: "Start agent-created routines active at Full access" }),
    );
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      agentRoutinesStartActiveAtFullAccess: false,
    });
    expect(
      screen.getByText(/Default 8\. A recurring wake-up may fire as often as every minute/),
    ).toBeTruthy();
  });

  it("changes Shield's brakes, a follow-up's lateness and a shown command's time from their defaults", async () => {
    const onSettingsChange = vi.fn();
    render(
      <OctantLimitsSettings
        focusedSetting={undefined}
        onSettingsChange={onSettingsChange}
        settings={defaultShellSettings()}
      />,
    );
    const steps: ReadonlyArray<readonly [string, Record<string, number>]> = [
      ["Denials in a row before you decide", { shieldDenialsInARow: 4 }],
      ["Denials per thread before you decide", { shieldDenialsPerThread: 21 }],
      ["Latest a follow-up still runs, in hours", { followUpLatenessLimitHours: 25 }],
      ["Time to run a shown provider command, in minutes", { toolingCommandConfirmMinutes: 11 }],
    ];
    for (const [label, patch] of steps) {
      await userEvent.click(screen.getByRole("button", { name: `Increase ${label}` }));
      expect(onSettingsChange).toHaveBeenLastCalledWith(patch);
    }
  });

  it("shows the Strict-only messaging and Browser wait limits at their defaults and emits updated values", async () => {
    const onSettingsChange = vi.fn();
    render(
      <OctantLimitsSettings
        focusedSetting={undefined}
        onSettingsChange={onSettingsChange}
        settings={defaultShellSettings()}
      />,
    );

    expect(
      screen.getByText(/Applies under Strict only\. How many times one turn may ask/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Applies under Strict only\. How many times one turn may read/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Applies under Strict only\. How many times one turn may wait/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Applies under Strict only\. How long an agent's Browser may wait/),
    ).toBeTruthy();

    await userEvent.click(
      screen.getByRole("button", { name: "Increase Thread messages per turn" }),
    );
    expect(onSettingsChange).toHaveBeenLastCalledWith({ threadMessagesPerTurn: 4 });

    await userEvent.click(
      screen.getByRole("button", { name: "Increase Sibling thread reads per turn" }),
    );
    expect(onSettingsChange).toHaveBeenLastCalledWith({ siblingThreadReadsPerTurn: 9 });

    await userEvent.click(
      screen.getByRole("button", { name: "Increase Sibling thread waits per turn" }),
    );
    expect(onSettingsChange).toHaveBeenLastCalledWith({ siblingThreadWaitsPerTurn: 5 });

    await userEvent.click(
      screen.getByRole("button", { name: "Increase Longest Browser wait, in minutes" }),
    );
    expect(onSettingsChange).toHaveBeenLastCalledWith({ browserWaitLimitMinutes: 11 });
  });
});
