import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ShieldServersClient } from "@octant/client-runtime/shield-servers-client";
import type { RemoteSetupCheckResult, RemoteSetupCheckInput } from "@octant/contracts/remote-setup";
import { RemoteSetupChecks } from "./RemoteSetupChecks";
const serverId = "00000000-0000-4000-8000-000000000710";
const servers: Pick<ShieldServersClient, "read"> = {
  read: async () => ({
    sshAgent: "available",
    servers: [
      {
        serverId: serverId as never,
        alias: "web1",
        user: "deploy",
        profile: "read-only",
        deployCommands: [],
      },
    ],
  }),
};
async function selectServer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("combobox", { name: "Registered server to check" }));
  await user.click(await screen.findByRole("option", { name: "deploy@web1" }));
}
describe("read-only guided setup checks", () => {
  it("loads registration without connecting, checks the chosen folder, and keeps a failed folder for correction", async () => {
    const user = userEvent.setup();
    const check = vi.fn(async () => ({
      status: "disconnected" as const,
      reason: "directory-unavailable" as const,
    }));
    render(<RemoteSetupChecks intent="server-folder" servers={servers} client={{ check }} />);
    await selectServer(user);
    expect(check).not.toHaveBeenCalled();
    const folder = screen.getByRole("textbox", { name: "Directory to check on the server" });
    await user.type(folder, "/srv/missing");
    await user.click(screen.getByRole("button", { name: "Run read-only checks" }));
    expect(check).toHaveBeenCalledWith(
      { serverId, runtime: "octant-harness", folder: "/srv/missing" },
      expect.any(AbortSignal),
    );
    expect(
      await screen.findByText(/SSH answered, but that directory could not be opened/),
    ).toBeVisible();
    expect(folder).toHaveValue("/srv/missing");
    await user.type(folder, "-corrected");
    expect(screen.getByText("Not checked")).toBeVisible();
    expect(screen.queryByText(/SSH answered, but that directory/)).toBeNull();
  });
  it.each([
    ["unknown-identity", /Make your own first SSH connection/],
    ["changed-identity", /verify the change with the server administrator/],
    ["missing-agent", /Start or unlock your agent/],
    ["unsupported-runtime", /Server Projects use Octant Harness/],
    ["host-unavailable", /No uncertain command is restarted/],
  ] as const)(
    "shows a separate remedy for %s without dispatching a command",
    async (reason, remedy) => {
      const user = userEvent.setup();
      const check = vi.fn(async () => ({ status: "disconnected" as const, reason }));
      render(<RemoteSetupChecks intent="server-command" servers={servers} client={{ check }} />);
      await selectServer(user);
      await user.click(screen.getByRole("button", { name: "Run read-only checks" }));
      expect(await screen.findByText(remedy)).toBeVisible();
      expect(check).toHaveBeenCalledTimes(1);
    },
  );
  it("stops a pending check, ignores its late answer, and rechecks only on explicit request", async () => {
    const user = userEvent.setup();
    let finish: ((result: RemoteSetupCheckResult) => void) | undefined;
    const check = vi.fn(
      (_input: RemoteSetupCheckInput, _signal?: AbortSignal) =>
        new Promise<RemoteSetupCheckResult>((resolve) => {
          finish = resolve;
        }),
    );
    render(<RemoteSetupChecks intent="server-command" servers={servers} client={{ check }} />);
    await selectServer(user);
    await user.click(screen.getByRole("button", { name: "Run read-only checks" }));
    await user.click(screen.getByRole("button", { name: "Stop check" }));
    expect(check.mock.calls[0]?.[1]?.aborted).toBe(true);
    await act(async () => finish?.({ status: "connected", reason: "ready", folder: "/srv/app" }));
    expect(screen.getByText("Stopped")).toBeVisible();
    expect(screen.queryByText("Connected for this check")).toBeNull();
    expect(check).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Recheck read-only" }));
    expect(screen.getByText(/Reconnecting for a read-only check/)).toBeVisible();
    await act(async () => finish?.({ status: "connected", reason: "ready", folder: "/srv/app" }));
    expect(await screen.findByText("Connected for this check")).toBeVisible();
  });
  it("refuses to claim host reachability from a local listener status", async () => {
    const user = userEvent.setup();
    const readHostStatus = vi.fn(async () => ({
      enabled: true,
      state: "ready" as const,
      hostname: "host.local",
      port: 13774,
      origin: null,
      exposureClass: null,
      certificateFingerprint: null,
      certificateReady: true,
      certificateSource: null,
      tlsPin: null,
    }));
    render(<RemoteSetupChecks intent="control-host" readHostStatus={readHostStatus} />);
    expect(readHostStatus).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Run read-only checks" }));
    expect(await screen.findByText(/this is not a remote reachability test/)).toBeVisible();
    expect(readHostStatus).toHaveBeenCalledTimes(1);
  });
  it("shows unavailable checks honestly for older clients and an unavailable host", async () => {
    const { rerender } = render(<RemoteSetupChecks intent="server-command" />);
    expect(screen.getByText(/Read-only connection checks are unavailable/)).toBeVisible();
    rerender(
      <RemoteSetupChecks
        intent="control-host"
        readHostStatus={async () => {
          throw new Error("offline");
        }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Run read-only checks" }));
    expect(await screen.findByText(/The Octant host could not answer/)).toBeVisible();
  });
});
