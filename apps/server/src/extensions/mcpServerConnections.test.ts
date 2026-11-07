import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionPackageState,
  ExtensionSnapshot,
  McpServerSignInView,
} from "@octant/contracts";
import { listMcpServerConnections, transportOf } from "./mcpServerConnections";
import type { McpConnectionObservation } from "./agentPluginMcpSessionManager";

const extensionId = "44000000-0000-4000-8000-000000000002";
const activation = {
  installed: true,
  trusted: true,
  pluginDesired: true,
  componentDesired: true,
  compatible: true,
  policyAllowed: true,
  quarantined: false,
  draining: false,
  broken: false,
  unavailable: false,
  interrupted: false,
  waiting: false,
};

function server(
  componentId: string,
  overrides: Partial<ExtensionPackageState["components"][number]> = {},
): ExtensionPackageState["components"][number] {
  return {
    component: { id: componentId, kind: "mcp-server", displayName: componentId },
    activation,
    effectiveState: { kind: "effective" },
    ...overrides,
  } as never;
}

function snapshot(
  components: ReadonlyArray<ExtensionPackageState["components"][number]>,
  slug = "connector-linear",
) {
  return {
    sequence: 0,
    snapshotAt: "2026-11-07T12:00:00.000Z",
    collisions: [],
    packages: [
      {
        extensionId,
        packageId: "linear",
        displayName: "Linear",
        slug,
        addedInSettings: true,
        version: "1.0.0",
        digest: `sha256:${"a".repeat(64)}`,
        components: [
          ...components,
          { component: { id: "notes", kind: "skill-instructions", displayName: "Notes" } },
        ],
      },
    ],
  } as unknown as ExtensionSnapshot;
}

async function list(input: {
  readonly components: ReadonlyArray<ExtensionPackageState["components"][number]>;
  readonly signIn?: Record<string, McpServerSignInView>;
  readonly observations?: ReadonlyArray<McpConnectionObservation>;
  readonly slug?: string;
}) {
  const signInStatus = vi.fn(
    async (_extensionId: string, componentId: string): Promise<McpServerSignInView> =>
      input.signIn?.[componentId] ?? { kind: "not-applicable" },
  );
  const listing = await listMcpServerConnections({
    snapshot: () => snapshot(input.components, input.slug),
    observations: () => input.observations ?? [],
    signInStatus,
    readConfiguration: async (_packageState, componentId) =>
      componentId === "local"
        ? JSON.stringify({ mcpServers: { local: { command: "node", args: ["server.js"] } } })
        : JSON.stringify({ mcpServers: { remote: { url: "https://mcp.example.com/mcp" } } }),
  });
  return { listing, signInStatus };
}

describe("the server connection listing", () => {
  it("lists only MCP servers, naming their package and transport", async () => {
    const { listing } = await list({ components: [server("remote"), server("local")] });
    expect(listing.servers).toEqual([
      expect.objectContaining({
        packageName: "Linear",
        serverName: "remote",
        transport: "streamable-http",
        state: "ready",
      }),
      expect.objectContaining({ serverName: "local", transport: "stdio", state: "ready" }),
    ]);
  });

  it("says a switched-off server is off before anything else", async () => {
    const { listing } = await list({
      components: [
        server("remote", {
          activation: { ...activation, componentDesired: false },
          effectiveState: { kind: "blocked", reason: "component-disabled" },
        }),
      ],
      signIn: { remote: { kind: "sign-in-again", reason: "expired" } },
    });
    expect(listing.servers[0]).toMatchObject({ state: "off", reason: "Switched off." });
  });

  it("flags a missing or expired sign-in in plain words", async () => {
    const { listing } = await list({
      components: [server("remote"), server("local")],
      signIn: {
        remote: { kind: "sign-in-again", reason: "revoked" },
        local: { kind: "signed-out" },
      },
      observations: [
        {
          extensionId,
          componentId: "remote",
          state: "failed",
          reason: "401",
          at: "2026-11-07T11:00:00.000Z",
        },
      ],
    });
    expect(listing.servers[0]).toMatchObject({
      state: "needs-sign-in",
      reason: "The sign-in was revoked. Sign in again.",
      checkedAt: "2026-11-07T11:00:00.000Z",
    });
    expect(listing.servers[1]).toMatchObject({ state: "needs-sign-in", reason: "Not signed in." });
  });

  it("reports what the last connection attempt saw: connected, connecting, or failed with its reason", async () => {
    const { listing } = await list({
      components: [server("remote"), server("local"), server("third")],
      observations: [
        {
          extensionId,
          componentId: "remote",
          state: "connected",
          at: "2026-11-07T11:30:00.000Z",
        },
        { extensionId, componentId: "local", state: "connecting" },
        {
          extensionId,
          componentId: "third",
          state: "failed",
          reason: "fetch failed",
          at: "2026-11-07T11:45:00.000Z",
        },
      ],
    });
    expect(listing.servers.map((entry) => entry.state)).toEqual([
      "connected",
      "connecting",
      "failed",
    ]);
    expect(listing.servers[2]).toMatchObject({
      reason: "Could not connect: fetch failed",
      checkedAt: "2026-11-07T11:45:00.000Z",
    });
  });

  it("names a lifecycle block and keeps an idle server's last connection time", async () => {
    const { listing } = await list({
      components: [
        server("remote", { effectiveState: { kind: "blocked", reason: "quarantined" } }),
        server("local"),
      ],
      observations: [
        { extensionId, componentId: "local", state: "idle", at: "2026-11-07T10:00:00.000Z" },
      ],
    });
    expect(listing.servers[0]).toMatchObject({
      state: "blocked",
      reason: "The package is quarantined.",
    });
    expect(listing.servers[1]).toMatchObject({
      state: "ready",
      checkedAt: "2026-11-07T10:00:00.000Z",
    });
  });

  it("asks only for the stored sign-in status, once per server", async () => {
    const { signInStatus } = await list({ components: [server("remote")] });
    expect(signInStatus).toHaveBeenCalledTimes(1);
    expect(signInStatus).toHaveBeenCalledWith(extensionId, "remote");
  });

  it("does not flag signed out for a server that works without a sign-in, or one that is connected", async () => {
    const keyed = await list({
      components: [server("remote")],
      signIn: { remote: { kind: "signed-out" } },
      slug: "my-own-server",
    });
    expect(keyed.listing.servers[0]?.state).toBe("ready");
    const connected = await list({
      components: [server("remote")],
      signIn: { remote: { kind: "signed-out" } },
      observations: [{ extensionId, componentId: "remote", state: "connected" }],
    });
    expect(connected.listing.servers[0]?.state).toBe("connected");
  });

  it("reads the transport of the entry this component runs from a shared mcp.json", () => {
    const shared = JSON.stringify({
      mcpServers: {
        docs: { url: "https://mcp.example.com/mcp" },
        "Local Tools": { command: "node", args: ["server.js"] },
      },
    });
    expect(transportOf(shared, "Local Tools", "mcp-local-tools")).toBe("stdio");
    expect(transportOf(shared, "Docs", "mcp-docs")).toBe("streamable-http");
    expect(transportOf(shared, "Other", "mcp-other")).toBe("unknown");
  });

  it("asks for client setup on a connector whose sign-in app is not registered yet", async () => {
    const { listing } = await list({
      components: [server("remote")],
      signIn: {
        remote: {
          kind: "client-setup-required",
          message: "Set up your registered app before signing in.",
        },
      },
    });
    expect(listing.servers[0]).toMatchObject({
      state: "needs-sign-in",
      reason: "Set up your registered app before signing in.",
    });
  });

  it("blocks a sign-in connector on a host that cannot sign in, naming why", async () => {
    const { listing } = await list({
      components: [server("remote")],
      signIn: {
        remote: {
          kind: "refused",
          reason: "unavailable",
          message: "Signing in needs the credential broker.",
        },
      },
    });
    expect(listing.servers[0]).toMatchObject({
      state: "blocked",
      reason: "Signing in needs the credential broker.",
    });
  });
});
