import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentRunSettingsClientFailure } from "@octant/client-runtime/agent-run-settings-client";
import { AgentRunSettingsPanel } from "./AgentRunSettingsPanel";

function baseSettings(
  overrides: Partial<{ creationPosture: "off" | "ask" | "automatic"; version: number }> = {},
) {
  return {
    creationPosture: overrides.creationPosture ?? "ask",
    version: (overrides.version ?? 1) as never,
    updatedAt: "2026-08-01T15:00:00.000Z" as never,
  };
}

function posture() {
  return screen.getByRole("combobox", { name: "Subagent creation" });
}

describe("AgentRunSettingsPanel", () => {
  it("loads and displays the current server-authoritative posture", async () => {
    const client = {
      current: vi.fn(async () => baseSettings({ creationPosture: "automatic" })),
      update: vi.fn(),
    };
    render(<AgentRunSettingsPanel client={client} />);
    await waitFor(() => expect(posture()).toHaveTextContent("Automatic"));
    expect(screen.getByText(/without a separate confirmation step/)).toBeVisible();
  });

  it("updates the posture with the expected version and reflects the server's response", async () => {
    const user = userEvent.setup();
    const update = vi.fn(async () => baseSettings({ creationPosture: "automatic", version: 2 }));
    const client = {
      current: vi.fn(async () => baseSettings({ creationPosture: "ask", version: 1 })),
      update,
    };
    render(<AgentRunSettingsPanel client={client} />);
    await waitFor(() => expect(posture()).toHaveTextContent("Ask"));

    await user.click(posture());
    await user.click(await screen.findByRole("option", { name: "Automatic" }));

    expect(update).toHaveBeenCalledWith({ creationPosture: "automatic", expectedVersion: 1 });
    await waitFor(() => expect(posture()).toHaveTextContent("Automatic"));
  });

  it("reloads the authoritative policy after a concurrent-change conflict", async () => {
    const user = userEvent.setup();
    const current = vi
      .fn()
      .mockResolvedValueOnce(baseSettings({ creationPosture: "ask", version: 1 }))
      .mockResolvedValueOnce(baseSettings({ creationPosture: "off", version: 5 }));
    const update = vi
      .fn()
      .mockRejectedValueOnce(new AgentRunSettingsClientFailure("conflict", "stale"));
    const client = { current, update };
    render(<AgentRunSettingsPanel client={client} />);
    await waitFor(() => expect(posture()).toHaveTextContent("Ask"));

    await user.click(posture());
    await user.click(await screen.findByRole("option", { name: "Automatic" }));

    await waitFor(() => expect(posture()).toHaveTextContent("Off"));
    expect(screen.getByText(/changed elsewhere/i)).toBeInTheDocument();
  });

  it("shows an alert when the initial load fails", async () => {
    const client = {
      current: vi.fn(async () => {
        throw new AgentRunSettingsClientFailure("unavailable", "Agents settings are down.");
      }),
      update: vi.fn(),
    };
    render(<AgentRunSettingsPanel client={client} />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Agents settings are down."),
    );
  });
});
