import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { McpServerConnection } from "@octant/contracts/extension-rpc";
import { describe, expect, it, vi } from "vitest";
import { ServerConnections } from "./ServerConnections";

const extensionId = "44000000-0000-4000-8000-000000000002";

function server(overrides: Partial<McpServerConnection>): McpServerConnection {
  return {
    extensionId,
    packageId: "linear",
    componentId: "mcp",
    packageName: "Linear",
    serverName: "Linear",
    transport: "streamable-http",
    state: "ready",
    ...overrides,
  } as McpServerConnection;
}

const servers: ReadonlyArray<McpServerConnection> = [
  server({ componentId: "a" as never, serverName: "Docs", state: "connected" }),
  server({
    componentId: "b" as never,
    serverName: "Search",
    state: "failed",
    reason: "Could not connect: fetch failed",
    checkedAt: "2026-11-07T11:45:00.000Z" as never,
  }),
  server({
    componentId: "c" as never,
    serverName: "Tickets",
    state: "needs-sign-in",
    reason: "The sign-in expired. Sign in again.",
  }),
  server({
    componentId: "d" as never,
    serverName: "Local",
    transport: "stdio",
    state: "off",
    reason: "Switched off.",
  }),
];

function client() {
  return {
    mcpServerSignIn: vi.fn(async () => ({ kind: "sign-in-again", reason: "expired" }) as const),
    reconnectMcpServer: vi.fn(async () => ({ kind: "reconnecting" }) as const),
  };
}

describe("Server connections in Settings", () => {
  it("lists every server with its state, flagging the ones that need attention with the host's reason", async () => {
    render(
      <ServerConnections
        client={client() as never}
        disabled={false}
        localHost
        onChanged={vi.fn()}
        servers={servers}
      />,
    );
    const rows = within(screen.getByRole("list", { name: "Server connections" })).getAllByRole(
      "listitem",
    );
    expect(rows.map((row) => row.dataset["state"])).toEqual([
      "connected",
      "failed",
      "needs-sign-in",
      "off",
    ]);
    expect(within(rows[0]!).getByText("Connected")).toBeTruthy();
    expect(within(rows[1]!).getByText("Not connecting")).toBeTruthy();
    expect(within(rows[1]!).getByText("Could not connect: fetch failed")).toBeTruthy();
    expect(within(rows[1]!).getByText(/Last checked/)).toBeTruthy();
    expect(within(rows[2]!).getByText("The sign-in expired. Sign in again.")).toBeTruthy();
    expect(within(rows[3]!).getByText(/Runs on this computer/)).toBeTruthy();
    // Off is a choice, not a fault: no warning sentence beside it.
    expect(within(rows[3]!).queryByText("Switched off.")).toBeNull();
    expect(await within(rows[2]!).findByRole("button", { name: "Sign in again" })).toBeTruthy();
  });

  it("reconnects only the failed server and reads the listing again", async () => {
    const user = userEvent.setup();
    const extensions = client();
    const onChanged = vi.fn();
    render(
      <ServerConnections
        client={extensions as never}
        disabled={false}
        localHost
        onChanged={onChanged}
        servers={servers}
      />,
    );
    expect(screen.getAllByRole("button", { name: /^Reconnect/ })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Reconnect Search" }));
    expect(extensions.reconnectMcpServer).toHaveBeenCalledWith({ extensionId, componentId: "b" });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("reads the listing again once a row's sign-in finishes", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const extensions = {
      mcpServerSignIn: vi.fn(async (request: { readonly kind: string }) =>
        request.kind === "status"
          ? ({ kind: "sign-in-again", reason: "expired" } as const)
          : ({ kind: "signed-in", issuer: "auth.example" } as const),
      ),
      reconnectMcpServer: vi.fn(),
    };
    render(
      <ServerConnections
        client={extensions as never}
        disabled={false}
        localHost
        onChanged={onChanged}
        servers={[servers[2] as McpServerConnection]}
      />,
    );
    expect(onChanged).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("shows a paired device the states without Reconnect or sign-in", () => {
    const extensions = client();
    render(
      <ServerConnections
        client={extensions as never}
        disabled={false}
        localHost={false}
        onChanged={vi.fn()}
        servers={servers}
      />,
    );
    expect(screen.getByText("Could not connect: fetch failed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Reconnect/ })).toBeNull();
    expect(extensions.mcpServerSignIn).not.toHaveBeenCalled();
  });

  it("says so when the host could not report connections", () => {
    render(
      <ServerConnections
        client={client() as never}
        disabled={false}
        localHost
        onChanged={vi.fn()}
        servers={undefined}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("Server connections could not be read.");
  });
});
