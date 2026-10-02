import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentRunSettingsClientFailure } from "@octant/client-runtime/agent-run-settings-client";
import { AgentRunSettingsPanel } from "./AgentRunSettingsPanel";

function baseSettings(
  overrides: Partial<{ creationPosture: "off" | "automatic"; version: number }> = {},
) {
  return {
    creationPosture: overrides.creationPosture ?? "automatic",
    version: (overrides.version ?? 1) as never,
    updatedAt: "2026-08-01T15:00:00.000Z" as never,
  };
}

function toggle() {
  return screen.getByRole("switch", { name: "Let the agent start subagents" });
}

describe("AgentRunSettingsPanel", () => {
  it("shows the agent may start subagents when the host lets it", async () => {
    const client = {
      current: vi.fn(async () => baseSettings({ creationPosture: "automatic" })),
      update: vi.fn(),
    };
    render(<AgentRunSettingsPanel client={client} />);
    await waitFor(() => expect(toggle()).toBeChecked());
    expect(screen.getByText(/hand part of its work to a subagent/)).toBeVisible();
  });

  it("offers only on or off, with no choice to start subagents by hand", async () => {
    const client = {
      current: vi.fn(async () => baseSettings({ creationPosture: "off" })),
      update: vi.fn(),
    };
    render(<AgentRunSettingsPanel client={client} />);
    await waitFor(() => expect(toggle()).not.toBeChecked());
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText(/Only when I start them/)).toBeNull();
    expect(screen.getByText(/does all of its work itself/)).toBeVisible();
  });

  it("turns subagents on with the expected version and reflects the server's response", async () => {
    const user = userEvent.setup();
    const update = vi.fn(async () => baseSettings({ creationPosture: "automatic", version: 2 }));
    const client = {
      current: vi.fn(async () => baseSettings({ creationPosture: "off", version: 1 })),
      update,
    };
    render(<AgentRunSettingsPanel client={client} />);
    await waitFor(() => expect(toggle()).not.toBeChecked());

    await user.click(toggle());

    expect(update).toHaveBeenCalledWith({ creationPosture: "automatic", expectedVersion: 1 });
    await waitFor(() => expect(toggle()).toBeChecked());
  });

  it("raises how many helpers run at once in a thread, keeping the app limit and posture", async () => {
    const user = userEvent.setup();
    const update = vi.fn(async () => ({
      ...baseSettings({ creationPosture: "automatic", version: 2 }),
      concurrency: { perThread: 5, onHost: 8 },
    }));
    const client = {
      current: vi.fn(async () => baseSettings({ creationPosture: "automatic", version: 1 })),
      update,
    };
    render(<AgentRunSettingsPanel client={client} />);
    await waitFor(() => expect(toggle()).toBeChecked());
    expect(screen.getByRole("spinbutton", { name: "Run at once in a thread" })).toHaveValue(4);
    expect(screen.getByRole("spinbutton", { name: "Run at once in the app" })).toHaveValue(8);

    await user.click(screen.getByRole("button", { name: "Increase Run at once in a thread" }));

    expect(update).toHaveBeenCalledWith({
      creationPosture: "automatic",
      concurrency: { perThread: 5, onHost: 8 },
      expectedVersion: 1,
    });
    await waitFor(() =>
      expect(screen.getByRole("spinbutton", { name: "Run at once in a thread" })).toHaveValue(5),
    );
  });

  it("turns subagents off", async () => {
    const user = userEvent.setup();
    const update = vi.fn(async () => baseSettings({ creationPosture: "off", version: 2 }));
    const client = {
      current: vi.fn(async () => baseSettings({ creationPosture: "automatic", version: 1 })),
      update,
    };
    render(<AgentRunSettingsPanel client={client} />);
    await waitFor(() => expect(toggle()).toBeChecked());

    await user.click(toggle());

    expect(update).toHaveBeenCalledWith({ creationPosture: "off", expectedVersion: 1 });
    await waitFor(() => expect(toggle()).not.toBeChecked());
  });

  it("reloads the authoritative policy after a concurrent-change conflict", async () => {
    const user = userEvent.setup();
    const current = vi
      .fn()
      .mockResolvedValueOnce(baseSettings({ creationPosture: "automatic", version: 1 }))
      .mockResolvedValueOnce(baseSettings({ creationPosture: "off", version: 5 }));
    const update = vi
      .fn()
      .mockRejectedValueOnce(new AgentRunSettingsClientFailure("conflict", "stale"));
    const client = { current, update };
    render(<AgentRunSettingsPanel client={client} />);
    await waitFor(() => expect(toggle()).toBeChecked());

    await user.click(toggle());

    await waitFor(() => expect(toggle()).not.toBeChecked());
    expect(screen.getByText(/changed elsewhere/i)).toBeInTheDocument();
  });

  it("lands a link to the setting on its control", async () => {
    const client = { current: vi.fn(async () => baseSettings()), update: vi.fn() };
    render(<AgentRunSettingsPanel client={client} focused />);
    await waitFor(() => expect(toggle()).toHaveFocus());
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
