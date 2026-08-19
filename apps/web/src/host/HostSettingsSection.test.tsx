import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  HostBackupOutcome,
  HostControlStatus,
  HostLifecycleAction,
  HostLifecycleOutcome,
  HostRestoreOutcome,
} from "@octant/contracts/host-control";
import type { HostControlClient } from "@octant/client-runtime/host-control-client";
import { HostSettingsSection } from "./HostSettingsSection";

const serviceStatus: HostControlStatus = {
  identity: { hostId: "host-1", instanceId: "instance-1", serviceMode: "service" },
  versions: { server: "1.2.3", wire: "9" },
  policy: { kind: "known", enabled: true, updatedAt: "2026-08-11T12:00:00.000Z" },
  readiness: {
    store: { state: "ready", integrity: "verified" },
    replay: { journalHead: 42, projections: 42 },
    clientsConnected: 2,
    uptimeSeconds: 3_723,
  },
  capabilities: ["platform:systemd-user-units", "platform:keychain"],
  work: { active: 1, attentionRequired: false },
  lifecycle: {
    stop: { kind: "available" },
    restart: { kind: "available" },
    enable: { kind: "available" },
    disable: { kind: "available" },
  },
};

const foregroundStatus: HostControlStatus = {
  ...serviceStatus,
  identity: { ...serviceStatus.identity, serviceMode: "foreground" },
  policy: { kind: "unavailable", reason: "The service policy could not be read." },
  lifecycle: {
    stop: { kind: "available" },
    restart: {
      kind: "unavailable",
      reason: "No service manager restarts this foreground run; stop it and start it again.",
    },
    enable: { kind: "unavailable", reason: "The service policy could not be read." },
    disable: { kind: "unavailable", reason: "The service policy could not be read." },
  },
};

interface ClientOverrides {
  readonly status?: () => Promise<HostControlStatus>;
  readonly lifecycle?: (action: HostLifecycleAction) => Promise<HostLifecycleOutcome>;
  readonly backup?: (label?: string) => Promise<HostBackupOutcome>;
  readonly restore?: () => Promise<HostRestoreOutcome>;
}

function makeClient(overrides: ClientOverrides = {}): HostControlClient {
  return {
    status: overrides.status ?? (async () => serviceStatus),
    lifecycle:
      overrides.lifecycle ??
      (async (action) => ({ kind: "accepted", action, message: "Accepted." })),
    backup:
      overrides.backup ??
      (async () => ({
        kind: "created",
        label: "manual",
        migrationVersion: 4,
        journalHead: 42,
        byteLength: 2_048,
      })),
    restore:
      overrides.restore ??
      (async () => ({
        kind: "refused-online",
        guidance: "Stop the Octant host, then run the offline restore command with --confirm.",
      })),
    readThreadRetention: async () => ({ windows: [], tombstones: [] }),
    setThreadRetention: async () => ({ windows: [], tombstones: [] }),
    purgeThreads: async () => ({
      operation: "purge-threads",
      scope: { kind: "host" },
      purged: [],
      alreadyPurged: [],
      retained: [],
      deleted: [],
      occurredAt: "2026-08-19T12:00:00.000Z" as never,
    }),
  };
}

describe("HostSettingsSection", () => {
  it("renders identity, owner mode, policy, versions, readiness, and capabilities", async () => {
    render(<HostSettingsSection client={makeClient()} />);

    expect(await screen.findByText("host-1")).toBeInTheDocument();
    expect(screen.getByText("instance-1")).toBeInTheDocument();
    expect(screen.getByText("Managed service")).toBeInTheDocument();
    expect(screen.getByText(/Automatic startup is enabled/)).toBeInTheDocument();
    expect(screen.getByText("1.2.3")).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
    expect(screen.getByText(/ready/)).toBeInTheDocument();
    expect(screen.getByText(/verified/)).toBeInTheDocument();
    expect(screen.getByText(/42 \/ 42/)).toBeInTheDocument();
    expect(screen.getByText("platform:systemd-user-units")).toBeInTheDocument();
    expect(screen.getByText("platform:keychain")).toBeInTheDocument();
  });

  it("keeps the section navigable by headings for assistive technology", async () => {
    render(<HostSettingsSection client={makeClient()} />);
    await screen.findByText("host-1");

    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(headings).toEqual(
      expect.arrayContaining([
        "Identity",
        "Service policy",
        "Readiness",
        "Backup",
        "Recovery",
        "Thread retention",
      ]),
    );
  });

  it("shows an honest unavailable state and recovers through the retry control", async () => {
    let failures = 1;
    const status = vi.fn(async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("The host control service is unreachable.");
      }
      return serviceStatus;
    });
    render(<HostSettingsSection client={makeClient({ status })} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The host control service is unreachable.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("host-1")).toBeInTheDocument();
  });

  it("disables unavailable lifecycle controls and shows the reason", async () => {
    render(<HostSettingsSection client={makeClient({ status: async () => foregroundStatus })} />);

    await screen.findByText("host-1");
    expect(screen.getByRole("button", { name: "Restart host" })).toBeDisabled();
    expect(
      screen.getByText(
        "No service manager restarts this foreground run; stop it and start it again.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/The service policy could not be read/)).toBeInTheDocument();
  });

  it("sends a stop request and renders the accepted outcome", async () => {
    const lifecycle = vi.fn(
      async (action: HostLifecycleAction): Promise<HostLifecycleOutcome> => ({
        kind: "accepted",
        action,
        message: "The host is draining and will stop.",
      }),
    );
    render(<HostSettingsSection client={makeClient({ lifecycle })} />);

    await screen.findByText("host-1");
    fireEvent.click(screen.getByRole("button", { name: "Stop host" }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("The host is draining and will stop.");
    });
    expect(lifecycle).toHaveBeenCalledWith("stop");
  });

  it("renders a refused lifecycle outcome with its guidance instead of pretending success", async () => {
    const lifecycle = vi.fn(
      async (): Promise<HostLifecycleOutcome> => ({
        kind: "refused",
        action: "restart",
        code: "restart-unavailable",
        guidance: "Run octant server restart from a terminal on this host.",
      }),
    );
    render(<HostSettingsSection client={makeClient({ lifecycle })} />);

    await screen.findByText("host-1");
    fireEvent.click(screen.getByRole("button", { name: "Restart host" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Run octant server restart from a terminal on this host.",
    );
  });

  it("disables automatic startup through the policy control and refreshes status", async () => {
    const lifecycle = vi.fn(
      async (action: HostLifecycleAction): Promise<HostLifecycleOutcome> => ({
        kind: "accepted",
        action,
        message: "Automatic startup is disabled; explicit foreground run remains available.",
      }),
    );
    const status = vi.fn(async () => serviceStatus);
    render(<HostSettingsSection client={makeClient({ lifecycle, status })} />);

    await screen.findByText("host-1");
    fireEvent.click(screen.getByRole("button", { name: "Disable automatic startup" }));

    await waitFor(() => expect(lifecycle).toHaveBeenCalledWith("disable"));
    await waitFor(() => expect(status.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("creates a backup with the entered label and shows the path-free receipt", async () => {
    const backup = vi.fn(
      async (label?: string): Promise<HostBackupOutcome> => ({
        kind: "created",
        label: label ?? "manual",
        migrationVersion: 4,
        journalHead: 42,
        byteLength: 2_048,
      }),
    );
    render(<HostSettingsSection client={makeClient({ backup })} />);

    await screen.findByText("host-1");
    fireEvent.change(screen.getByLabelText("Backup label"), {
      target: { value: "pre-upgrade" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create backup" }));

    await waitFor(() => {
      expect(screen.getByText(/Backup pre-upgrade created/)).toBeInTheDocument();
    });
    expect(screen.getByText(/journal head 42/)).toBeInTheDocument();
    expect(backup).toHaveBeenCalledWith("pre-upgrade");
  });

  it("reports a failed backup honestly", async () => {
    const backup = vi.fn(
      async (): Promise<HostBackupOutcome> => ({ kind: "failed", code: "backup-failed" }),
    );
    render(<HostSettingsSection client={makeClient({ backup })} />);

    await screen.findByText("host-1");
    fireEvent.click(screen.getByRole("button", { name: "Create backup" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The backup was not created");
  });

  it("shows the honest online-restore refusal with offline guidance", async () => {
    render(<HostSettingsSection client={makeClient()} />);

    await screen.findByText("host-1");
    fireEvent.click(screen.getByRole("button", { name: "Restore from backup" }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Stop the Octant host, then run the offline restore command with --confirm.",
        ),
      ).toBeInTheDocument();
    });
  });

  it("completes a full load, lifecycle, backup, and recovery walkthrough with zero console errors", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<HostSettingsSection client={makeClient()} />);
      await screen.findByText("host-1");

      fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
      fireEvent.click(screen.getByRole("button", { name: "Restart host" }));
      await screen.findByRole("status");
      fireEvent.click(screen.getByRole("button", { name: "Create backup" }));
      await screen.findByText(/Backup manual created/);
      fireEvent.click(screen.getByRole("button", { name: "Restore from backup" }));
      await screen.findByText(/offline restore command/);

      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("supports keyboard-only traversal through the lifecycle and recovery controls", async () => {
    const user = userEvent.setup();
    render(<HostSettingsSection client={makeClient()} />);
    await screen.findByText("host-1");

    const refresh = screen.getByRole("button", { name: "Refresh status" });
    refresh.focus();
    expect(refresh).toHaveFocus();

    const expectedTabStops = ["Disable automatic startup", "Stop host", "Restart host"];
    for (const name of expectedTabStops) {
      await user.tab();
      expect(screen.getByRole("button", { name })).toHaveFocus();
    }
    await user.tab();
    expect(screen.getByLabelText("Backup label")).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Create backup" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Restore from backup" })).toHaveFocus();

    await user.keyboard("{Enter}");
    await screen.findByText(/offline restore command/);
  });

  it("keeps every control keyboard-reachable as a native button or input", async () => {
    render(<HostSettingsSection client={makeClient()} />);
    await screen.findByText("host-1");

    for (const name of [
      "Refresh status",
      "Stop host",
      "Restart host",
      "Disable automatic startup",
      "Create backup",
      "Restore from backup",
    ]) {
      const control = screen.getByRole("button", { name });
      expect(control.tagName).toBe("BUTTON");
      expect(control).not.toHaveAttribute("tabindex", "-1");
    }
    expect(screen.getByLabelText("Backup label").tagName).toBe("INPUT");
  });
});
