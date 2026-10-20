import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorsView } from "./ConnectorsView";

const EXTENSION = "44000000-0000-4000-8000-000000000002";

function snapshotWith(packages: ExtensionSnapshot["packages"] = []): ExtensionSnapshot {
  return {
    sequence: 0 as never,
    snapshotAt: "2026-10-20T12:00:00.000Z" as never,
    packages,
    collisions: [],
  };
}

function addedPackage(displayName: string): ExtensionSnapshot["packages"][number] {
  return {
    extensionId: EXTENSION,
    packageId: "44000000-0000-4000-8000-000000000003",
    displayName,
    version: "1.0.0",
    digest: `sha256:${"a".repeat(64)}`,
    source: { kind: "user-added", sourceRef: "user-linear" },
    activation: { installed: true, trusted: true, pluginDesired: true },
    components: [
      {
        component: { id: "mcp-linear", kind: "mcp-server", displayName: "Linear" },
        activation: { componentDesired: true },
        effectiveState: { kind: "effective" },
      },
    ],
    diagnostics: [],
  } as never;
}

beforeEach(() => {
  localStorage.clear();
});

describe("Connectors", () => {
  it("connects a sign-in connector: adds its server, then starts the sign-in and links to the page", async () => {
    const user = userEvent.setup();
    const addUserMcpServer = vi.fn(async () => ({
      kind: "extension-state-updated",
      snapshot: snapshotWith([addedPackage("linear")]),
    })) as never;
    const mcpServerSignIn = vi
      .fn()
      .mockResolvedValueOnce({ kind: "signed-out" })
      .mockResolvedValueOnce({
        kind: "awaiting-consent",
        attemptId: "55000000-0000-4000-8000-000000000001",
        authorizationUrl: "https://mcp.linear.app/authorize?x=1",
        expiresAt: "2026-10-20T12:10:00.000Z",
      })
      .mockResolvedValue({ kind: "signed-in", issuer: "mcp.linear.app" });
    const onConnected = vi.fn();
    render(
      <ConnectorsView
        actions={null}
        client={{ addUserMcpServer, mcpServerSignIn: mcpServerSignIn as never }}
        disabled={false}
        localHost
        onConnected={onConnected}
        snapshot={snapshotWith()}
      />,
    );
    const popular = screen.getByRole("region", { name: "Popular" });
    await user.click(within(popular).getByRole("button", { name: "Connect Linear" }));
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
    expect(addUserMcpServer).toHaveBeenCalledWith({
      name: "Linear",
      server: { type: "streamable-http", url: "https://mcp.linear.app/mcp", headers: [] },
    });
    expect(await screen.findByRole("link", { name: "Open the sign-in page" })).toHaveAttribute(
      "href",
      "https://mcp.linear.app/authorize?x=1",
    );
    expect(mcpServerSignIn).toHaveBeenNthCalledWith(2, {
      kind: "begin",
      extensionId: EXTENSION,
      componentId: "mcp-linear",
    });
  });

  it("takes the vendor's key for a key connector and sends it as a secret header", async () => {
    const user = userEvent.setup();
    const addUserMcpServer = vi.fn(async () => ({
      kind: "extension-state-updated",
      snapshot: snapshotWith(),
    })) as never;
    render(
      <ConnectorsView
        actions={null}
        client={{ addUserMcpServer, mcpServerSignIn: vi.fn() as never }}
        disabled={false}
        localHost
        onConnected={vi.fn()}
        snapshot={snapshotWith()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Connect GitHub" }));
    const form = screen.getByRole("form", { name: "GitHub key" });
    expect(within(form).getByRole("link")).toHaveAttribute(
      "href",
      "https://github.com/settings/personal-access-tokens",
    );
    await user.type(within(form).getByLabelText("Key"), "private-value");
    await user.click(within(form).getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(addUserMcpServer).toHaveBeenCalledWith({
        name: "GitHub",
        server: {
          type: "streamable-http",
          url: "https://api.githubcopilot.com/mcp/",
          headers: [{ name: "Authorization", value: "Bearer private-value", secret: true }],
        },
      }),
    );
  });

  it("searches, hides an entry on this computer, shows hidden ones again, and marks an installed one Connected", async () => {
    const user = userEvent.setup();
    render(
      <ConnectorsView
        actions={null}
        client={{
          addUserMcpServer: vi.fn() as never,
          mcpServerSignIn: vi.fn(async () => ({
            kind: "signed-in",
            issuer: "mcp.linear.app",
          })) as never,
        }}
        disabled={false}
        localHost
        onConnected={vi.fn()}
        snapshot={snapshotWith([addedPackage("linear")])}
      />,
    );
    expect(screen.getByRole("button", { name: "Connect Notion" })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Search connectors" }), "postgres");
    expect(screen.queryByRole("button", { name: "Connect Notion" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Neon" })).toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Search connectors" }));

    await user.click(screen.getByRole("button", { name: "Hide Notion" }));
    expect(screen.queryByRole("button", { name: "Connect Notion" })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("octant.connectors.hidden") ?? "[]")).toEqual([
      "notion",
    ]);
    await user.click(screen.getByRole("button", { name: "Show hidden (1)" }));
    expect(screen.getByRole("button", { name: "Connect Notion" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all again" }));
    expect(localStorage.getItem("octant.connectors.hidden")).toBe("[]");

    const popular = screen.getByRole("region", { name: "Popular" });
    expect(
      within(popular)
        .getAllByRole("status")
        .some((node) => node.textContent === "Connected"),
    ).toBe(true);
    expect(
      within(popular).queryByRole("button", { name: "Connect Linear" }),
    ).not.toBeInTheDocument();
  });

  it("explains that a browser-hosted Settings cannot connect", () => {
    render(
      <ConnectorsView
        actions={null}
        client={{ addUserMcpServer: vi.fn() as never, mcpServerSignIn: vi.fn() as never }}
        disabled={false}
        localHost={false}
        onConnected={vi.fn()}
        snapshot={snapshotWith()}
      />,
    );
    expect(screen.getByRole("button", { name: "Connect Linear" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Connect from the Octant window on this host",
    );
  });
});
