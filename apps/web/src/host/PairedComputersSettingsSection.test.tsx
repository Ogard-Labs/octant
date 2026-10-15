import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PairedComputersBridge } from "../shell/hostBridge";
import { PairedComputersSettingsSection } from "./PairedComputersSettingsSection";

const studio = { origin: "https://100.101.102.103:8443", displayName: "Studio Mac" };

function bridgeWith(overrides: Partial<PairedComputersBridge> = {}): PairedComputersBridge {
  return {
    pairWithPairingCode: vi.fn(async () => ({ status: "opened" as const, computer: studio })),
    listPairedComputers: vi.fn(async () => []),
    openPairedComputer: vi.fn(async () => ({ status: "opened" as const, computer: studio })),
    forgetPairedComputer: vi.fn(async () => ({ status: "forgotten" as const })),
    ...overrides,
  };
}

describe("pairing this desktop app with another computer", () => {
  it("hands the pasted code to the desktop app and lists the computer it opened", async () => {
    const listPairedComputers = vi
      .fn<PairedComputersBridge["listPairedComputers"]>()
      .mockResolvedValueOnce([])
      .mockResolvedValue([studio]);
    const bridge = bridgeWith({ listPairedComputers });
    render(<PairedComputersSettingsSection bridge={bridge} />);

    await userEvent.type(screen.getByLabelText("Pairing code"), "octant-pair-1.abc");
    await userEvent.click(screen.getByRole("button", { name: "Pair" }));

    expect(bridge.pairWithPairingCode).toHaveBeenCalledWith("octant-pair-1.abc");
    expect(await screen.findByText(/Opened Studio Mac\./)).toBeTruthy();
    await userEvent.click(await screen.findByRole("button", { name: "Open" }));
    expect(bridge.openPairedComputer).toHaveBeenCalledWith(studio.origin);
  });

  it("shows the refusal the desktop app gives and keeps the code for a second look", async () => {
    const message =
      "This isn't the computer you paired with: its security key has changed. Octant stopped before sending anything. If its key was replaced on purpose, pair again from that computer.";
    const bridge = bridgeWith({
      pairWithPairingCode: vi.fn(async () => ({ status: "refused" as const, message })),
    });
    render(<PairedComputersSettingsSection bridge={bridge} />);

    await userEvent.type(screen.getByLabelText("Pairing code"), "octant-pair-1.abc");
    await userEvent.click(screen.getByRole("button", { name: "Pair" }));

    expect(await screen.findByText(message)).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByLabelText("Pairing code") as HTMLTextAreaElement).value).toBe(
        "octant-pair-1.abc",
      ),
    );
  });
});

describe("forgetting a paired computer", () => {
  it("asks first, and forgets nothing when the person keeps it", async () => {
    const bridge = bridgeWith({ listPairedComputers: vi.fn(async () => [studio]) });
    render(<PairedComputersSettingsSection bridge={bridge} />);

    await userEvent.click(await screen.findByRole("button", { name: "Forget Studio Mac" }));
    expect(screen.getByRole("dialog", { name: "Forget Studio Mac?" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Keep it" }));

    expect(bridge.forgetPairedComputer).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("forgets the computer on confirm and drops it from the list", async () => {
    const listPairedComputers = vi
      .fn<PairedComputersBridge["listPairedComputers"]>()
      .mockResolvedValueOnce([studio])
      .mockResolvedValue([]);
    const bridge = bridgeWith({ listPairedComputers });
    render(<PairedComputersSettingsSection bridge={bridge} />);

    await userEvent.click(await screen.findByRole("button", { name: "Forget Studio Mac" }));
    await userEvent.click(screen.getByRole("button", { name: "Forget computer" }));

    expect(bridge.forgetPairedComputer).toHaveBeenCalledWith(studio.origin);
    expect(await screen.findByText("Forgot Studio Mac.")).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Forget Studio Mac" })).toBeNull(),
    );
  });

  it("shows the refusal the desktop app gives", async () => {
    const bridge = bridgeWith({
      listPairedComputers: vi.fn(async () => [studio]),
      forgetPairedComputer: vi.fn(async () => ({ status: "refused" as const, message: "Nope." })),
    });
    render(<PairedComputersSettingsSection bridge={bridge} />);

    await userEvent.click(await screen.findByRole("button", { name: "Forget Studio Mac" }));
    await userEvent.click(screen.getByRole("button", { name: "Forget computer" }));

    expect(await screen.findByText("Nope.")).toBeTruthy();
  });
});
