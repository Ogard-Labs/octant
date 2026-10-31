import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { HostMemoryStatus, SetHostMemoryLimitsOutcome } from "@octant/contracts/host-control";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";
import { HostMemoryLimits } from "./HostMemoryLimits";

const automatic: HostMemoryStatus = {
  pressure: "normal",
  processMegabytes: 600,
  limits: { kind: "automatic" },
  effectiveLimits: { pressuredMegabytes: 1_024, criticalMegabytes: 2_048 },
};

const custom: HostMemoryStatus = {
  ...automatic,
  limits: { kind: "custom", pressuredGb: 3, criticalGb: 6 },
  effectiveLimits: { pressuredMegabytes: 3_072, criticalMegabytes: 6_144 },
};

function setup(memory: HostMemoryStatus, outcome?: SetHostMemoryLimitsOutcome | Error) {
  const setMemoryLimits = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome ?? ({ kind: "saved", limits: { kind: "automatic" } } as const);
  });
  const onSaved = vi.fn();
  render(<HostMemoryLimits client={{ setMemoryLimits }} memory={memory} onSaved={onSaved} />);
  return { setMemoryLimits, onSaved, user: userEvent.setup() };
}

describe("HostMemoryLimits", () => {
  it("says which limits apply on this Mac while the setting is automatic", () => {
    setup(automatic);
    expect(
      screen.getByText("Automatic. On this Mac Octant treats 1 GB as low and 2 GB as very low."),
    ).toBeVisible();
    expect(screen.queryByLabelText("Low at (GB)")).toBeNull();
    expect(screen.getByRole("button", { name: "Save memory limits" })).toBeDisabled();
  });

  it("shows the saved custom pair in two fields and asks nothing until something changes", () => {
    setup(custom);
    expect(screen.getByLabelText("Low at (GB)")).toHaveValue(3);
    expect(screen.getByLabelText("Very low at (GB)")).toHaveValue(6);
    expect(screen.getByRole("button", { name: "Save memory limits" })).toBeDisabled();
  });

  it("offers the fields on Custom, prefilled with what applies now, and saves the pair", async () => {
    const { setMemoryLimits, onSaved, user } = setup(automatic, {
      kind: "saved",
      limits: { kind: "custom", pressuredGb: 1.5, criticalGb: 5 },
    });
    await chooseSelectFieldOption(
      user,
      screen.getByRole("combobox", { name: "Memory limits" }),
      "Custom",
    );
    expect(screen.getByLabelText("Low at (GB)")).toHaveValue(1);
    expect(screen.getByLabelText("Very low at (GB)")).toHaveValue(2);

    const low = screen.getByLabelText("Low at (GB)");
    const veryLow = screen.getByLabelText("Very low at (GB)");
    await user.clear(low);
    await user.type(low, "1.5");
    await user.clear(veryLow);
    await user.type(veryLow, "5");
    await user.click(screen.getByRole("button", { name: "Save memory limits" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(setMemoryLimits).toHaveBeenCalledWith({
      limits: { kind: "custom", pressuredGb: 1.5, criticalGb: 5 },
    });
    expect(screen.getByText("Memory limits saved.")).toBeVisible();
  });

  it("returns to automatic with one save", async () => {
    const { setMemoryLimits, user } = setup(custom);
    await chooseSelectFieldOption(
      user,
      screen.getByRole("combobox", { name: "Memory limits" }),
      "Automatic",
    );
    await user.click(screen.getByRole("button", { name: "Save memory limits" }));
    await waitFor(() =>
      expect(setMemoryLimits).toHaveBeenCalledWith({ limits: { kind: "automatic" } }),
    );
  });

  it("shows the host's plain refusal as it arrived and keeps what was typed", async () => {
    const { onSaved, user } = setup(custom, {
      kind: "refused",
      code: "critical-not-above-pressured",
      message: "The critical limit must be above the pressured limit.",
    });
    const veryLow = screen.getByLabelText("Very low at (GB)");
    await user.clear(veryLow);
    await user.type(veryLow, "2");
    await user.click(screen.getByRole("button", { name: "Save memory limits" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The critical limit must be above the pressured limit.",
    );
    expect(veryLow).toHaveValue(2);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("asks for both numbers before sending anything", async () => {
    const { setMemoryLimits, user } = setup(custom);
    await user.clear(screen.getByLabelText("Low at (GB)"));
    await user.click(screen.getByRole("button", { name: "Save memory limits" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter both limits as a number of GB.",
    );
    expect(setMemoryLimits).not.toHaveBeenCalled();
  });

  it("says so when the host cannot be reached instead of claiming success", async () => {
    const { onSaved, user } = setup(custom, new Error("unreachable"));
    const veryLow = screen.getByLabelText("Very low at (GB)");
    await user.clear(veryLow);
    await user.type(veryLow, "8");
    await user.click(screen.getByRole("button", { name: "Save memory limits" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The memory limits could not be saved.",
    );
    expect(onSaved).not.toHaveBeenCalled();
  });
});
