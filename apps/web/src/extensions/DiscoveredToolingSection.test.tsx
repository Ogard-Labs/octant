import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DiscoveredAgentToolingListing } from "@octant/contracts/extension-rpc";
import { describe, expect, it, vi } from "vitest";
import { HostPlatformContext } from "../platform";
import { DiscoveredToolingSection } from "./DiscoveredToolingSection";

const listing: DiscoveredAgentToolingListing = {
  servers: [
    {
      id: "claude-00000000000000000000000000000001" as never,
      origin: "claude-code",
      scope: "user",
      name: "docs",
      transport: "stdio",
      summary: "npx -y docs-mcp",
      needsValues: [],
      unsupportedPlaceholders: [],
      secretNames: ["DOCS_TOKEN"],
    },
    {
      id: "claude-00000000000000000000000000000003" as never,
      origin: "claude-code",
      scope: "user",
      name: "remote",
      transport: "streamable-http",
      summary: "https://mcp.example/mcp",
      needsValues: ["MCP_TOKEN"],
      unsupportedPlaceholders: ["API_HOST"],
      secretNames: [],
    },
  ],
  plugins: [
    {
      id: "codex-00000000000000000000000000000002" as never,
      origin: "codex",
      name: "github@openai-curated",
      version: "1.1.0",
      format: "codex-plugin",
      enabledThere: false,
    },
  ],
  notes: ["legacy (Claude Code): its sse transport is not one Octant connects to."],
};

describe("Found on the host's computer", () => {
  it("lists what the other tools know and adds a server with one click", async () => {
    const user = userEvent.setup();
    const applyDiscoveredTooling = vi.fn(
      async () => ({ kind: "extension-state-updated" }) as never,
    );
    const onServerAdded = vi.fn();
    render(
      <DiscoveredToolingSection
        client={{ listDiscoveredTooling: async () => listing, applyDiscoveredTooling }}
        disabled={false}
        onPluginInspected={vi.fn()}
        onServerAdded={onServerAdded}
        revision={0}
      />,
    );
    const servers = await screen.findByRole("list", { name: "Servers found on this computer" });
    expect(within(servers).getByText("docs")).toBeInTheDocument();
    expect(within(servers).getByText(/Claude Code · npx -y docs-mcp/)).toBeInTheDocument();
    expect(
      within(servers).getByText(/Kept in the credential store: DOCS_TOKEN/),
    ).toBeInTheDocument();
    expect(within(servers).getByRole("note")).toHaveTextContent("Uses API_HOST");
    const buttons = within(servers).getAllByRole("button", { name: "Add to Octant" });
    expect(buttons[1]).toBeDisabled();
    const plugins = screen.getByRole("list", { name: "Plugins found on this computer" });
    expect(
      within(plugins).getByText(/Codex · Codex plugin · v1.1.0 · off there/),
    ).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Left out" })).toHaveTextContent(
      "legacy (Claude Code)",
    );

    await user.click(buttons[0] as HTMLElement);
    await waitFor(() => expect(onServerAdded).toHaveBeenCalled());
    expect(applyDiscoveredTooling).toHaveBeenCalledWith({
      kind: "add-server",
      id: "claude-00000000000000000000000000000001",
    });
  });

  it("hands a found plugin's preview to the page, and shows a refusal in its own words beside it", async () => {
    const user = userEvent.setup();
    const preview = { entry: { displayName: "github" } };
    const applyDiscoveredTooling = vi
      .fn()
      .mockResolvedValueOnce({ kind: "package-inspected", preview })
      .mockResolvedValueOnce({
        kind: "extension-command-failed",
        failure: { category: "stale", message: "That plugin is no longer listed. Look again." },
      });
    const onPluginInspected = vi.fn();
    render(
      <DiscoveredToolingSection
        client={{ listDiscoveredTooling: async () => listing, applyDiscoveredTooling }}
        disabled={false}
        onPluginInspected={onPluginInspected}
        onServerAdded={vi.fn()}
        revision={0}
      />,
    );
    const plugins = await screen.findByRole("list", { name: "Plugins found on this computer" });
    await user.click(within(plugins).getByRole("button", { name: "Review and import" }));
    await waitFor(() => expect(onPluginInspected).toHaveBeenCalledWith(preview));
    await user.click(within(plugins).getByRole("button", { name: "Review and import" }));
    // The refusal sits in the clicked row: below a long list it was out of
    // sight, and the click looked like it did nothing.
    expect(await within(plugins).findByRole("alert")).toHaveTextContent(
      "That plugin is no longer listed. Look again.",
    );
  });

  it("shows nothing when the other tools know nothing", async () => {
    const { container } = render(
      <DiscoveredToolingSection
        client={{
          listDiscoveredTooling: async () => ({ servers: [], plugins: [], notes: [] }),
          applyDiscoveredTooling: vi.fn(),
        }}
        disabled={false}
        onPluginInspected={vi.fn()}
        onServerAdded={vi.fn()}
        revision={0}
      />,
    );
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("names the computer the host reports, not the window's", async () => {
    // The scan reads the host's files, so a Mac window driving a Linux host
    // must not say "this Mac".
    Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true });
    try {
      const section = (
        <DiscoveredToolingSection
          client={{ listDiscoveredTooling: async () => listing, applyDiscoveredTooling: vi.fn() }}
          disabled={false}
          onPluginInspected={vi.fn()}
          onServerAdded={vi.fn()}
          revision={0}
        />
      );
      const { unmount } = render(
        <HostPlatformContext.Provider value="linux">{section}</HostPlatformContext.Provider>,
      );
      expect(
        await screen.findByRole("heading", { name: "Found on this computer" }),
      ).toBeInTheDocument();
      expect(screen.getByText(/other agent tools on this computer already use/)).toBeVisible();
      unmount();

      render(<HostPlatformContext.Provider value="darwin">{section}</HostPlatformContext.Provider>);
      expect(await screen.findByRole("heading", { name: "Found on this Mac" })).toBeInTheDocument();
      expect(screen.getByRole("list", { name: "Servers found on this Mac" })).toBeVisible();
      expect(screen.getByRole("list", { name: "Plugins found on this Mac" })).toBeVisible();
    } finally {
      Reflect.deleteProperty(window.navigator, "platform");
    }
  });
});
