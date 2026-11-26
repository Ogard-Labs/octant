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
      agentRoutinesStartActiveAtFullAccess: true,
    });
    // The default is named beside the stepper, not in the sentence, and hidden
    // while the value is the default.
    const waiting = screen.getByRole("group", { name: "Wake-ups waiting per thread setting" });
    expect(waiting.querySelector(".setrow-default")).toHaveTextContent("Default 8");
    expect(waiting.querySelector(".setrow-default")).toHaveAttribute("data-at-default", "true");
    expect(screen.getByText(/A recurring wake-up may fire as often as every minute/)).toBeTruthy();
  });

  it("names the default beside a limit once it has been changed from it", () => {
    render(
      <OctantLimitsSettings
        focusedSetting={undefined}
        onSettingsChange={vi.fn()}
        settings={{ ...defaultShellSettings(), coordinatorsPerProject: 6 }}
      />,
    );
    const row = screen.getByRole("group", { name: "Coordinators per Project setting" });
    expect(row.querySelector(".setrow-default")).toHaveAttribute("data-at-default", "false");
    expect(row).toHaveAccessibleDescription(/Default 4$/);
  });

  it("says every limit in one sentence, with no default in it", () => {
    render(
      <OctantLimitsSettings
        focusedSetting={undefined}
        onSettingsChange={vi.fn()}
        settings={defaultShellSettings()}
      />,
    );
    for (const hint of document.querySelectorAll(".setrow-hint")) {
      // The sentence alone, without the scope label the hint line also carries.
      const sentence = hint.querySelector(":scope > span")?.textContent?.trim() ?? "";
      expect(sentence, sentence).not.toMatch(/Default \d/);
      // One sentence: a full stop only at the end.
      expect(sentence.replace(/\.$/, ""), sentence).not.toMatch(/\.\s/);
    }
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

    expect(screen.getByText(/^Under Strict, how many times one turn may ask/)).toBeTruthy();
    expect(screen.getByText(/^Under Strict, how many times one turn may read/)).toBeTruthy();
    expect(screen.getByText(/^Under Strict, how many times one turn may wait/)).toBeTruthy();
    expect(screen.getByText(/^Under Strict, how long an agent's Browser may wait/)).toBeTruthy();
    // What holds outside Strict is kept, behind each row's More.
    expect(screen.getAllByText("Outside Strict there is no limit.")).toHaveLength(3);
    expect(screen.getByText(/^Outside Strict there is no wait limit\./)).toBeTruthy();

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
