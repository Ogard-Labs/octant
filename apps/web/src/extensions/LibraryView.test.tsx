import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { LibraryView } from "./LibraryView";
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
  it("lists installed items before the catalog and groups them by kind", () => {
    renderLibrary();
    const groups = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(groups[0]).toMatch(/^Connectors|^MCP servers|^Plugins/);
    expect(screen.getByRole("button", { name: "Build Helper" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Linear" })).toBeTruthy();
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

  it("sends a connector to the Connectors flow instead of installing it from here", async () => {
    const user = userEvent.setup();
    const props = renderLibrary();
    await user.click(screen.getByRole("button", { name: "Linear" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Connect…" }));
    expect(props.onOpen).toHaveBeenCalledWith(
      "connectors",
      expect.objectContaining({ name: "Linear" }),
    );
  });

  it("says the Marketplace is off when fetches are off, and draws loading placeholders", () => {
    renderLibrary({ marketplaceFetchesEnabled: false, loading: true });
    expect(screen.getByText(/Marketplace fetches are off/)).toBeTruthy();
    expect(screen.getByLabelText("Loading the library")).toBeTruthy();
  });
});
