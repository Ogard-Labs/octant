import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { LibraryView, monogramFor } from "./LibraryView";
import { buildLibrary } from "./libraryModel";

const active = {
  installed: true,
  trusted: false,
  pluginDesired: false,
  componentDesired: false,
  compatible: true,
  policyAllowed: true,
  quarantined: false,
  draining: false,
  broken: false,
  unavailable: false,
  interrupted: false,
  waiting: false,
};
const snapshot = {
  sequence: 1,
  snapshotAt: "2026-11-02T00:00:00.000Z",
  collisions: [],
  packages: [
    {
      extensionId: "ext-1",
      packageId: "pkg-1",
      slug: "build-helper",
      displayName: "Build Helper",
      stateVersion: 3,
      version: "1.2.0",
      digest: "sha256:x",
      source: { kind: "catalog", catalogId: "octant", entryId: "b" },
      compatibility: { platforms: ["macos"], modes: ["code"], providerFamilies: [] },
      activation: active,
      components: [
        {
          component: {
            id: "c",
            kind: "mcp-server",
            displayName: "Server",
            declaredCapabilities: ["mcp", "shell"],
          },
          activation: active,
          effectiveState: { kind: "blocked", reason: "untrusted" },
        },
      ],
      diagnostics: [],
    },
  ],
} as never as ExtensionSnapshot;

const addUserMcpServer = vi.fn();
const connectClient = { addUserMcpServer, mcpServerSignIn: vi.fn() } as never;
beforeEach(() => {
  addUserMcpServer.mockReset();
  addUserMcpServer.mockResolvedValue({ kind: "extension-state-updated" });
});

function renderLibrary(overrides: Partial<React.ComponentProps<typeof LibraryView>> = {}) {
  const props = {
    items: buildLibrary({ snapshot }),
    actions: null,
    marketplaceFetchesEnabled: true,
    disabled: false,
    onOpen: vi.fn(),
    onTrust: vi.fn(),
    onPluginDesired: vi.fn(),
    ...overrides,
  };
  render(<LibraryView {...props} />);
  return props;
}

describe("the library view", () => {
  it("adds Paper through the local package route and keeps Desktop/file readiness unclaimed", async () => {
    const user = userEvent.setup();
    const addUserMcpServer = vi.fn(async () => ({ kind: "extension-state-updated", snapshot }));
    const mcpServerSignIn = vi.fn();
    renderLibrary({
      connectClient: { addUserMcpServer, mcpServerSignIn } as never,
      localHost: true,
    });
    await user.click(screen.getByRole("button", { name: "Set up… Paper" }));
    const dialog = screen.getByRole("dialog", { name: "Paper" });
    expect(within(dialog).getByText(/availability has not been checked/)).toBeTruthy();
    expect(within(dialog).getByText(/CLI is optional/)).toBeTruthy();
    expect(within(dialog).getByText(/If Desktop is closed or no file is open/)).toBeTruthy();
    expect(addUserMcpServer).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Add local server" }));
    expect(addUserMcpServer).toHaveBeenCalledWith({
      name: "Paper",
      localSetupId: "paper",
      server: { type: "streamable-http", url: "http://127.0.0.1:29979/mcp", headers: [] },
    });
    expect(mcpServerSignIn).not.toHaveBeenCalled();
  });

  it("keeps Paper uninstalled with a retry action when the local add is unavailable", async () => {
    const user = userEvent.setup();
    const onConnected = vi.fn();
    const addUserMcpServer = vi.fn(async () => ({
      kind: "extension-command-failed",
      failure: { category: "unavailable", message: "Local server setup is unavailable." },
    }));
    renderLibrary({
      connectClient: { addUserMcpServer, mcpServerSignIn: vi.fn() } as never,
      localHost: true,
      onConnected,
    });
    await user.click(screen.getByRole("button", { name: "Set up… Paper" }));
    const dialog = screen.getByRole("dialog", { name: "Paper" });
    await user.click(within(dialog).getByRole("button", { name: "Add local server" }));
    expect(within(dialog).getByText("Local server setup is unavailable.")).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Add local server" }).hasAttribute("disabled"),
    ).toBe(false);
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("keeps the Paper setup local to the host window", async () => {
    const user = userEvent.setup();
    renderLibrary({ connectClient, localHost: false });
    await user.click(screen.getByRole("button", { name: "Set up… Paper" }));
    const dialog = screen.getByRole("dialog", { name: "Paper" });
    expect(
      within(dialog).getByRole("button", { name: "Add local server" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      within(dialog).getByText(/Add the local server from the Octant window on this host/),
    ).toBeTruthy();
  });

  it("leads with the hand-picked connectors, then installed items, then the catalog's categories", () => {
    renderLibrary({ connectClient, localHost: true });
    const lead = screen.getByRole("region", { name: "Featured" });
    expect(within(lead).getByRole("button", { name: "Doop" })).toBeTruthy();
    const groups = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent ?? "");
    expect(groups[0]).toMatch(/^Featured/);
    expect(groups[1]).toMatch(/^Installed/);
    expect(groups.some((title) => title.startsWith("Developer tools"))).toBe(true);
    // Nothing shows twice: a featured connector is not repeated under Popular.
    expect(screen.getAllByRole("button", { name: "Doop" })).toHaveLength(1);
  });

  it("gives a connector with no licensed logo a two-letter tile that tells its neighbours apart", () => {
    renderLibrary();
    expect(screen.getByText("Co")).toBeTruthy();
    expect(screen.getByText("De")).toBeTruthy();
    expect(monogramFor("Microsoft Learn")).toBe("Ml");
    expect(monogramFor("Stripe")).not.toBe(monogramFor("Sentry"));
  });

  it("puts the next step on a card that is not installed and keeps authority findable", () => {
    renderLibrary({ connectClient, localHost: true });
    expect(screen.getByRole("button", { name: "Connect… Linear" })).toBeTruthy();
    expect(screen.queryByText("Not installed")).toBeNull();
    expect(screen.getAllByText("Medium authority").length).toBeGreaterThan(0);
  });

  it("narrows by search and says plainly when nothing matches, with a way back", async () => {
    const user = userEvent.setup();
    renderLibrary();
    await user.type(screen.getByLabelText("Search the library"), "zzzzqq");
    expect(screen.getByText("Nothing matches")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear search and filters" }));
    expect(screen.getByRole("button", { name: "Linear" })).toBeTruthy();
  });

  it("shows what an item can do and costs in authority, then trusts it on one click", async () => {
    const user = userEvent.setup();
    const props = renderLibrary();
    await user.click(screen.getByRole("button", { name: "Build Helper" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("What it can do")).toBeTruthy();
    expect(within(dialog).getByText(/Runs commands on this computer/)).toBeTruthy();
    expect(within(dialog).getByText("High")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Trust this source" }));
    expect(props.onTrust).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Build Helper" }),
      true,
    );
  });

  it("opens a connector's detail from its card and connects only on the confirming press there", async () => {
    const user = userEvent.setup();
    const onConnected = vi.fn();
    renderLibrary({ connectClient, localHost: true, onConnected });
    await user.click(screen.getByRole("button", { name: "Connect… Context7" }));
    expect(addUserMcpServer).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Sends your requests to/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(addUserMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: "context7" }),
    );
    expect(onConnected).toHaveBeenCalled();
  });

  it("takes a key in the detail before it connects a key connector", async () => {
    const user = userEvent.setup();
    const key = {
      id: "keyed",
      displayName: "Keyed",
      description: "A service that takes a key.",
      category: "business",
      url: "https://keyed.example/mcp",
      docs: "https://keyed.example/docs",
      auth: {
        kind: "key",
        header: "Authorization",
        prefix: "Bearer",
        keyPage: "https://keyed.example/keys",
      },
    } as const;
    renderLibrary({
      items: buildLibrary({ snapshot: undefined, connectors: [key] }),
      connectClient,
      localHost: true,
    });
    await user.click(screen.getByRole("button", { name: "Add key… Keyed" }));
    expect(addUserMcpServer).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Key"), "k-123");
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(addUserMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        server: expect.objectContaining({
          headers: [{ name: "Authorization", value: "Bearer k-123", secret: true }],
        }),
      }),
    );
  });

  it("refuses to connect from a browser-hosted Settings and says why", async () => {
    const user = userEvent.setup();
    renderLibrary({ connectClient, localHost: false });
    await user.click(screen.getByRole("button", { name: "Connect… Linear" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Connect" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(within(dialog).getByText(/Connect from the Octant window/)).toBeTruthy();
    expect(addUserMcpServer).not.toHaveBeenCalled();
  });

  it("reviews a Marketplace plugin and installs it without trusting or turning it on", async () => {
    const user = userEvent.setup();
    const found = {
      extensionId: "ext-9",
      packageId: "pkg-9",
      displayName: "Lint Pack",
      version: "0.3.0",
      digest: "sha256:y",
      source: { kind: "catalog", catalogId: "octant", entryId: "l" },
    } as never;
    const onInspect = vi.fn();
    const onInstall = vi.fn();
    const props = renderLibrary({
      items: buildLibrary({ snapshot, marketplace: [found] }),
      onInspect,
      onInstall,
    });
    await user.click(screen.getByRole("button", { name: "Review Lint Pack" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Install" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Review before installing" }));
    expect(onInspect).toHaveBeenCalledWith(expect.objectContaining({ name: "Lint Pack" }));
    expect(props.onTrust).not.toHaveBeenCalled();
    expect(props.onPluginDesired).not.toHaveBeenCalled();
  });

  it("installs a reviewed plugin with one Install, leaving Trust and Turn on as later steps", async () => {
    const user = userEvent.setup();
    const found = {
      extensionId: "ext-9",
      packageId: "pkg-9",
      displayName: "Lint Pack",
      version: "0.3.0",
      digest: "sha256:y",
      source: { kind: "catalog", catalogId: "octant", entryId: "l" },
    } as never;
    const onInstall = vi.fn();
    const items = buildLibrary({ snapshot, marketplace: [found] });
    const id = items.find((item) => item.name === "Lint Pack")?.id ?? "";
    const props = renderLibrary({
      items,
      onInstall,
      inspection: {
        itemId: id,
        status: "ready",
        preview: {
          entry: found,
          review: {
            declaredCapabilities: ["instructions"],
            components: [{ id: "c1", kind: "skill", displayName: "Lint rules" }],
            provenance: { reviewed: true },
          },
          diagnostics: [],
        } as never,
      },
    });
    await user.click(screen.getByRole("button", { name: "Review Lint Pack" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Lint rules")).toBeTruthy();
    expect(within(dialog).getByText(/You trust it and turn it on as separate steps/)).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /Trust|Turn on/ })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Install" }));
    expect(onInstall).toHaveBeenCalledWith(expect.objectContaining({ name: "Lint Pack" }));
    expect(props.onTrust).not.toHaveBeenCalled();
    expect(props.onPluginDesired).not.toHaveBeenCalled();
  });

  it("will not read a Marketplace plugin while Marketplace fetches are off", async () => {
    const user = userEvent.setup();
    const found = {
      extensionId: "ext-9",
      packageId: "pkg-9",
      displayName: "Lint Pack",
      version: "0.3.0",
      digest: "sha256:y",
      source: { kind: "catalog", catalogId: "octant", entryId: "l" },
    } as never;
    renderLibrary({
      items: buildLibrary({ snapshot, marketplace: [found] }),
      marketplaceFetchesEnabled: false,
      onInspect: vi.fn(),
    });
    await user.click(screen.getByRole("button", { name: "Review Lint Pack" }));
    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Review before installing" }),
    ).toHaveProperty("disabled", true);
  });

  it("says the Marketplace is off when fetches are off, and draws loading placeholders", () => {
    renderLibrary({ marketplaceFetchesEnabled: false, loading: true });
    expect(screen.getByText(/Marketplace fetches are off/)).toBeTruthy();
    expect(screen.getByLabelText("Loading the library")).toBeTruthy();
  });
});
