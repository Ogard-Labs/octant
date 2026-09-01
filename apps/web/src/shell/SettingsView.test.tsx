import { defaultShellSettings } from "@octant/domain/shell-policy";
import { decodeChatBootstrap } from "@octant/contracts/chat";
import { DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { settingsPastFirstRun } from "../App.test-fixtures";
import { SettingsView, type SettingsViewProps } from "./SettingsView";
import type { ChatController } from "../chat/useChatController";
import type { CodeController } from "../code/useCodeController";
import type { DiscoveryController } from "../providers/useDiscoveryController";
import type { ProviderController } from "../providers/useProviderController";

const now = "2026-07-20T08:00:00.000Z";

function chatControllerFixture(): ChatController {
  return {
    bootstrap: decodeChatBootstrap({
      settings: {
        defaultProviderInstanceId: "10000000-0000-4000-8000-000000000001",
        defaultModelId: "model-a",
        defaultResearchEnabled: false,
        defaultResearchRouting: "automatic",
        defaultPersonalityInstructions: "Be calm, direct, and useful.",
        version: 1,
        updatedAt: now,
      },
      threads: [],
    }),
    updateSettings: vi.fn(async () => true),
  } as unknown as ChatController;
}

function providerControllerFixture(): ProviderController {
  const controller = {
    status: "ready",
    snapshot: undefined,
    instances: [],
    defaults: { permissionPersistence: "current-session", version: 0 as never },
    observedByInstance: new Map(),
    busy: false,
    probingIds: new Set(),
    credentialManagementAvailable: false,
    retry: vi.fn(async () => true),
  } as unknown as ProviderController;
  return { ...controller, readInstances: () => controller.instances } as ProviderController;
}

function discoveryControllerFixture(): DiscoveryController {
  return {
    snapshot: undefined,
    scanning: false,
    connectingPaths: new Set(),
    scan: vi.fn(async () => {}),
    connect: vi.fn(async () => true),
  } as unknown as DiscoveryController;
}

function renderSettings(overrides: Partial<SettingsViewProps> = {}) {
  const props: SettingsViewProps = {
    nativeBoundsAvailable: true,
    onResetLayout: vi.fn(),
    onResetNativeBounds: vi.fn(),
    onSearchChange: vi.fn(),
    onSettingsChange: vi.fn(),
    search: "",
    settings: defaultShellSettings(),
    sidebarVibrancySupported: true,
    visibleSettings: [
      "enable-chat",
      "enable-work",
      "sidebar-width",
      "sidebar-material",
      "workspace-material",
      "sidebar-background",
      "mode-switcher",
      "project-view-switcher",
      "reset-layout",
      "reset-window-bounds",
    ],
    ...overrides,
  };
  return { props, ...render(<SettingsView {...props} />) };
}

function navigateTo(label: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
}

/**
 * Render SettingsView with a controlled `search` prop so the search results
 * panel can be exercised (the real App controls the search string).
 */
function renderSettingsWithSearch(initial: string, overrides: Partial<SettingsViewProps> = {}) {
  const onSearchChange = vi.fn();
  function Harness() {
    const [search, setSearch] = useState(initial);
    return (
      <SettingsView
        {...defaultProps()}
        {...overrides}
        onSearchChange={(value) => {
          onSearchChange(value);
          setSearch(value);
        }}
        search={search}
      />
    );
  }
  return { onSearchChange, ...render(<Harness />) };
}

function defaultProps(): SettingsViewProps {
  return {
    nativeBoundsAvailable: true,
    onResetLayout: vi.fn(),
    onResetNativeBounds: vi.fn(),
    onSearchChange: vi.fn(),
    onSettingsChange: vi.fn(),
    search: "",
    settings: defaultShellSettings(),
    sidebarVibrancySupported: true,
    visibleSettings: [
      "enable-chat",
      "enable-work",
      "sidebar-width",
      "sidebar-material",
      "workspace-material",
      "sidebar-background",
      "mode-switcher",
      "project-view-switcher",
      "reset-layout",
      "reset-window-bounds",
    ],
  };
}

describe("SettingsView", () => {
  it("mounts execution-profile management in its own Profiles settings destination", async () => {
    renderSettings({
      executionProfiles: <div data-testid="execution-profile-settings">Profile settings</div>,
      initialDeepLink: { section: "profiles" },
    });
    expect(await screen.findByTestId("execution-profile-settings")).toBeVisible();
    expect(screen.getByRole("button", { name: "Profiles" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByText("Providers", { selector: "h1" })).not.toBeInTheDocument();
  });

  it("mounts the Agents settings panel when an AgentRunSettingsClient is supplied", async () => {
    const agentRunSettingsClient = {
      current: vi.fn(async () => ({
        creationPosture: "ask" as const,
        version: 1 as never,
        updatedAt: now as never,
      })),
      update: vi.fn(),
    };
    renderSettings({
      agentRunSettingsClient,
      initialDeepLink: { section: "agents" },
    });
    expect(await screen.findByRole("combobox", { name: "Subagent creation" })).toHaveTextContent(
      "Ask",
    );
    expect(screen.getByRole("button", { name: "Agents" })).toHaveAttribute("aria-current", "page");
  });

  it("does not render the Agents panel without an AgentRunSettingsClient", () => {
    renderSettings({ initialDeepLink: { section: "agents" } });
    expect(screen.queryByRole("combobox", { name: "Subagent creation" })).not.toBeInTheDocument();
  });

  it("presents one section at a time, defaulting to General", () => {
    renderSettings();

    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Settings sidebar" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    // Appearance is in the navigator but its content is not rendered.
    expect(screen.getByRole("button", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Appearance" })).not.toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "Sidebar width" })).not.toBeInTheDocument();
  });

  it("keeps the active section in the Settings breadcrumb", () => {
    renderSettings();

    expect(screen.getByRole("navigation", { name: "Settings breadcrumb" })).toHaveTextContent(
      /Settings\s*\/\s*General/,
    );

    navigateTo("Appearance");

    expect(screen.getByRole("navigation", { name: "Settings breadcrumb" })).toHaveTextContent(
      /Settings\s*\/\s*Appearance/,
    );
  });

  it("returns to the app from the dedicated Settings sidebar", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    renderSettings({ onBack });

    await user.click(screen.getByRole("button", { name: "Back to app" }));

    expect(onBack).toHaveBeenCalledOnce();
  });

  it("marks the active section in the navigator and switches on click", () => {
    renderSettings();

    expect(screen.getByRole("button", { name: "General" })).toHaveAttribute("aria-current", "page");
    navigateTo("Appearance");
    expect(screen.getByRole("button", { name: "Appearance" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "General" })).not.toBeInTheDocument();
  });

  it("keeps Profile collapsed in the same open form as the routine General groups", () => {
    renderSettings();

    expect(
      screen.getByRole("heading", { name: "Profile" }).closest(".settings-card-section"),
    ).toHaveClass("settings-card-section--open");
    const profileDisclosure = screen.getByRole("heading", { name: "Profile" }).closest("details");
    expect(profileDisclosure).not.toHaveAttribute("open");
    expect(profileDisclosure).toHaveTextContent("Not set");
    expect(
      screen.getByRole("heading", { name: "Available modes" }).closest(".settings-card-section"),
    ).toHaveClass("settings-card-section--open");
    const modes = screen.getByRole("heading", { name: "Available modes" });
    const profile = screen.getByRole("heading", { name: "Profile" });
    expect(modes.compareDocumentPosition(profile) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("moves keyboard shortcuts out of General into a dedicated section", () => {
    renderSettings();

    expect(screen.queryByRole("heading", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();
    navigateTo("Keybindings");

    expect(screen.getByRole("heading", { level: 1, name: "Keybindings" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Change the chord for Open the command palette" }),
    ).toBeVisible();
  });

  it("keeps the active Settings page first at narrow width and moves navigation into a drawer", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    renderSettings({ isNarrow: true, onBack });

    expect(screen.queryByRole("complementary", { name: "Settings sidebar" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "General" })).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "Search settings" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Back to app" })).toBeVisible();

    const sections = screen.getByRole("button", { name: "Settings sections" });
    await user.click(sections);
    const drawer = screen.getByRole("dialog", { name: "Settings sections" });
    expect(within(drawer).getByRole("navigation", { name: "Settings sections" })).toBeVisible();

    await user.click(within(drawer).getByRole("button", { name: "Appearance" }));
    expect(screen.queryByRole("dialog", { name: "Settings sections" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Appearance" })).toBeVisible();
    await waitFor(() => expect(sections).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "Back to app" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("clears Settings search from an app-owned control and returns focus to the field", async () => {
    const user = userEvent.setup();
    const { onSearchChange } = renderSettingsWithSearch("mode", { isNarrow: true });

    const search = screen.getByRole("searchbox", { name: "Search settings" });
    await user.click(screen.getByRole("button", { name: "Clear settings search" }));

    expect(onSearchChange).toHaveBeenLastCalledWith("");
    expect(search).toHaveFocus();
  });

  it("shows a scope indicator on each relevant control", () => {
    renderSettings();

    const general = screen.getByRole("heading", { name: "General" }).closest("section")!;
    const firstRow = within(general).getAllByTestId("setting-row")[0]!;
    expect(within(firstRow).getByText("This app")).toBeInTheDocument();
  });

  it("scans once when the Providers section opens", async () => {
    const providerController = providerControllerFixture();
    const discoveryController = discoveryControllerFixture();
    const { rerender } = renderSettings({ providerController, discoveryController });

    navigateTo("Providers & Models");

    await waitFor(() => expect(discoveryController.scan).toHaveBeenCalledTimes(1));

    rerender(
      <SettingsView
        {...defaultProps()}
        discoveryController={{
          ...discoveryController,
        }}
        providerController={providerController}
      />,
    );

    await waitFor(() => expect(discoveryController.scan).toHaveBeenCalledTimes(1));
  });

  it("checks every enabled installed provider when discovery is checked again", async () => {
    const user = userEvent.setup();
    const enabledId = "70000000-0000-4000-8000-000000000091" as never;
    const disabledId = "70000000-0000-4000-8000-000000000092" as never;
    const imageId = "70000000-0000-4000-8000-000000000095" as never;
    const probe = vi.fn(async () => true);
    const instances = [
      {
        id: enabledId,
        displayName: "Enabled Codex",
        driverKind: "codex",
        enabled: true,
        configuration: { kind: "codex-cli", binaryPath: "/usr/local/bin/codex" },
        version: 1,
      },
      {
        id: disabledId,
        displayName: "Disabled OpenCode",
        driverKind: "opencode",
        enabled: false,
        configuration: { kind: "opencode-cli", binaryPath: "/usr/local/bin/opencode" },
        version: 1,
      },
      {
        id: imageId,
        displayName: "GPT Image",
        driverKind: "openai-image",
        enabled: true,
        configuration: {
          kind: "openai-image-http",
          modelAllowlist: ["gpt-image-2"],
          defaultModel: "gpt-image-2",
        },
        version: 1,
      },
    ];
    const providerController = {
      ...providerControllerFixture(),
      instances,
      readInstances: () => instances,
      probe,
    } as unknown as ProviderController;
    const discoveryController = discoveryControllerFixture();
    renderSettings({ providerController, discoveryController });
    navigateTo("Providers & Models");
    await waitFor(() => expect(discoveryController.scan).toHaveBeenCalledOnce());

    await user.click(screen.getByRole("button", { name: "Check again" }));

    expect(discoveryController.scan).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith(enabledId);
    expect(probe).not.toHaveBeenCalledWith(disabledId);
    expect(probe).not.toHaveBeenCalledWith(imageId);
  });

  it("probes providers that become available during the discovery refresh", async () => {
    const user = userEvent.setup();
    const existingId = "70000000-0000-4000-8000-000000000093" as never;
    const discoveredId = "70000000-0000-4000-8000-000000000094" as never;
    const probe = vi.fn(async () => true);
    const discovered = {
      id: discoveredId,
      displayName: "Discovered Codex",
      driverKind: "codex",
      enabled: true,
      configuration: { kind: "codex-cli", binaryPath: "/opt/homebrew/bin/codex" },
      version: 1,
    };
    const instances = [
      {
        id: existingId,
        displayName: "Existing Codex",
        driverKind: "codex",
        enabled: true,
        configuration: { kind: "codex-cli", binaryPath: "/usr/local/bin/codex" },
        version: 1,
      },
    ];
    const providerController = {
      ...providerControllerFixture(),
      instances,
      readInstances: () => instances,
      probe,
    } as unknown as ProviderController;
    let scanCount = 0;
    const discoveryController = {
      ...discoveryControllerFixture(),
      scan: vi.fn(async () => {
        scanCount += 1;
        if (scanCount > 1) instances.push(discovered);
        return undefined;
      }),
    } as unknown as DiscoveryController;

    renderSettings({ providerController, discoveryController });
    navigateTo("Providers & Models");
    await waitFor(() => expect(discoveryController.scan).toHaveBeenCalledOnce());

    await user.click(screen.getByRole("button", { name: "Check again" }));

    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledWith(existingId);
    expect(probe).toHaveBeenCalledWith(discoveredId);
  });

  it("integrates authoritative Chat defaults as a searchable section", () => {
    const chatController = {
      ...chatControllerFixture(),
      settingsMessage:
        "Chat defaults changed elsewhere. Current authoritative values were loaded; review them and save again.",
    } as ChatController;
    renderSettings({ chatController });

    navigateTo("Chat");
    expect(screen.getByRole("heading", { name: "Chat defaults" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Default research backend" })).toHaveTextContent(
      "Automatic",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("changed elsewhere");
  });

  it("integrates authoritative Code defaults as a searchable section", () => {
    const codeController = {
      bootstrap: {
        settings: {
          defaultExecutionPolicy: "approval-gated",
          defaultPermissionPersistence: "current-session",
          version: 1,
          updatedAt: now,
        },
        threads: [],
        checkouts: [],
        activity: [],
      },
      updateSettings: vi.fn(async () => true),
    } as unknown as CodeController;
    renderSettings({ codeController });

    navigateTo("Code");
    expect(screen.getByRole("heading", { name: "Code defaults" })).toBeVisible();
  });

  it("maps the saved sidebar material to the direct translucency switch", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    const { rerender } = renderSettings({ onSettingsChange });
    navigateTo("Appearance");

    const control = screen.getByRole("switch", { name: "Translucent sidebar" });
    expect(control).toHaveAttribute("aria-checked", "true");
    expect(control).toHaveAttribute("aria-describedby", "sidebar-material-description");
    expect(document.getElementById("sidebar-material-description")).toHaveTextContent(
      "Use the system sidebar material when available.",
    );
    await user.click(control);
    expect(onSettingsChange).toHaveBeenLastCalledWith({ sidebarMaterial: "opaque" });

    rerender(
      <SettingsView
        nativeBoundsAvailable
        onResetLayout={vi.fn()}
        onResetNativeBounds={vi.fn()}
        onSearchChange={vi.fn()}
        onSettingsChange={onSettingsChange}
        search=""
        settings={{ ...defaultShellSettings(), sidebarMaterial: "opaque" }}
        sidebarVibrancySupported={false}
        visibleSettings={["sidebar-material"]}
      />,
    );
    const disabledTranslucency = screen.getByRole("switch", { name: "Translucent sidebar" });
    expect(disabledTranslucency).toHaveAttribute("aria-checked", "false");
    disabledTranslucency.focus();
    await user.keyboard(" ");
    expect(onSettingsChange).toHaveBeenLastCalledWith({ sidebarMaterial: "system" });
  });

  it("selects subtle native vibrancy when translucency is enabled", async () => {
    const user = userEvent.setup();
    const applyPatch = vi.fn(async () => true);
    renderSettings({
      settings: { ...defaultShellSettings(), sidebarMaterial: "opaque" },
      themeController: {
        draft: {
          ...DEFAULT_THEME_SETTINGS,
          sidebarBackground: {
            ...DEFAULT_THEME_SETTINGS.sidebarBackground,
            vibrancyMode: "off",
          },
        },
        applyPatch,
      } as never,
    });
    navigateTo("Appearance");

    await user.click(screen.getByRole("switch", { name: "Translucent sidebar" }));

    expect(applyPatch).toHaveBeenCalledWith({
      sidebarBackground: {
        ...DEFAULT_THEME_SETTINGS.sidebarBackground,
        vibrancyMode: "subtle",
      },
    });
  });

  it("keeps saved On while exposing the generic effective opaque fallback note", () => {
    const { container, rerender } = renderSettings({ visibleSettings: ["sidebar-material"] });
    navigateTo("Appearance");

    expect(screen.getByRole("switch", { name: "Translucent sidebar" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const note = screen.getByText(
      "Translucency is unavailable, so Octant is using an opaque sidebar.",
    );
    expect(note).toHaveClass("settings-view__effective-note");
    expect(note).toHaveAttribute("data-visible-when-material", "opaque");

    rerender(
      <SettingsView
        nativeBoundsAvailable
        onResetLayout={vi.fn()}
        onResetNativeBounds={vi.fn()}
        onSearchChange={vi.fn()}
        onSettingsChange={vi.fn()}
        search=""
        settings={{ ...defaultShellSettings(), sidebarMaterial: "opaque" }}
        sidebarVibrancySupported={false}
        visibleSettings={["sidebar-material"]}
      />,
    );
    expect(
      screen.queryByText("Translucency is unavailable, so Octant is using an opaque sidebar."),
    ).not.toBeInTheDocument();
    void container;
  });

  it("only enables the workspace translucency switch once the sidebar itself is translucent", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    renderSettings({
      onSettingsChange,
      settings: { ...defaultShellSettings(), workspaceMaterial: "opaque" },
      visibleSettings: ["sidebar-material", "workspace-material"],
    });
    navigateTo("Appearance");

    const control = screen.getByRole("switch", { name: "Translucent workspace" });
    expect(control).toHaveAttribute("aria-checked", "false");
    expect(control).not.toHaveAttribute("aria-disabled", "true");
    await user.click(control);
    expect(onSettingsChange).toHaveBeenLastCalledWith({ workspaceMaterial: "system" });
  });

  it("disables the workspace translucency switch and explains why when the sidebar is opaque", () => {
    renderSettings({
      settings: {
        ...defaultShellSettings(),
        sidebarMaterial: "opaque",
        workspaceMaterial: "system",
      },
      visibleSettings: ["sidebar-material", "workspace-material"],
    });
    navigateTo("Appearance");

    const control = screen.getByRole("switch", { name: "Translucent workspace" });
    expect(control).toHaveAttribute("aria-disabled", "true");
    expect(control).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Turn on Translucent sidebar first.")).toBeInTheDocument();
  });

  it("shows the effective fallback note for reduced transparency and unsupported backdrop", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/settings.css"), "utf8");

    expect(styles).toContain(".shell--material-translucent .settings-view__effective-note");
    expect(styles).toContain("@media (prefers-reduced-transparency: reduce)");
    expect(styles).toContain("@supports");
    expect(styles).toContain("not (backdrop-filter: blur(1px))");
    expect(styles).toContain("not (-webkit-backdrop-filter: blur(1px))");
    expect(styles).toMatch(
      /\.shell--material-translucent \.settings-view__sidebar\s*\{[^}]*background:\s*var\(--octant-sidebar-translucent\);[^}]*backdrop-filter:/s,
    );
    expect(styles).toMatch(
      /@media \(prefers-reduced-transparency: reduce\)[\s\S]*\.shell--material-translucent \.settings-view__sidebar,\s*\.shell--material-translucent\[data-octant-sidebar-vibrancy="subtle"\] \.settings-view__sidebar,\s*\.shell--material-translucent\[data-octant-sidebar-vibrancy="strong"\] \.settings-view__sidebar\s*\{[^}]*background:\s*var\(--octant-sidebar-opaque\);[^}]*backdrop-filter:\s*none;/,
    );
  });

  it("owns its full-height shell without a stale root style collision", () => {
    const dedicatedStyles = readFileSync(resolve(process.cwd(), "src/styles/settings.css"), "utf8");
    const legacyStyles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

    expect(dedicatedStyles).toMatch(/\.settings-view\s*\{[^}]*height: 100vh;/s);
    expect(legacyStyles).not.toMatch(/(?:^|\n)\.settings-view\s*\{/);
    expect(legacyStyles).not.toMatch(/(?:^|\n)\.settings-view h1\s*\{/);
  });

  it("gives sidebar background presets a visible, keyboard-targetable grid", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/settings.css"), "utf8");

    expect(styles).toContain(".settings-view__preset-grid");
    expect(styles).toContain("grid-template-columns: repeat(5, 28px)");
    expect(styles).toContain(".settings-view__preset-swatch");
    expect(styles).toContain("min-width: 28px");
    expect(styles).toContain("min-height: 28px");
  });

  it("keeps Settings on the shared interface type scale in a navigation-anchored column", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/settings.css"), "utf8");

    expect(styles).toMatch(/\.settings-view\s*\{[\s\S]*font-family:\s*var\(--oct-font-display\);/);
    // The readable column stays bounded, but its left edge follows the
    // navigator instead of floating in the middle of wide windows.
    expect(styles).toMatch(/--oct-settings-reading-width:\s*680px;/);
    expect(styles).toMatch(/\.settings-view__content-inner\s*\{[\s\S]*margin:\s*0;/);
    expect(styles).toMatch(
      /\.settings-view__content-inner\s*\{[\s\S]*padding:\s*28px var\(--oct-settings-gutter\) 64px;/,
    );
    expect(styles).toContain("font-family: var(--oct-font-display)");
    expect(styles).toContain("font-size: var(--octant-ui-font-size)");
    expect(styles).not.toContain("--octant-ui-font-family");
  });

  it("sizes every value control in Settings from one declared column", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/settings.css"), "utf8");

    // Sized from their own content, the controls in one column measured 134,
    // 150, 158 and 180 — seven staggered left edges under a right edge they
    // already shared. A stepper's width in particular moved by 16px depending
    // on whether it happened to spell out a unit.
    expect(styles).toMatch(/--oct-settings-control:\s*180px;/);
    for (const selector of [
      "\\.settings-view__select",
      "\\.settings-font-picker",
      "\\.octant-number-stepper",
    ]) {
      expect(styles).toMatch(
        new RegExp(`${selector}[^{}]*\\{[^}]*width:\\s*var\\(--oct-settings-control`),
      );
    }
    expect(styles).toMatch(
      /\.octant-number-stepper \{[^}]*grid-template-columns:\s*30px minmax\(0, 1fr\) auto 30px;/,
    );
  });

  it("lets a scheme card be as tall as the picture it shows", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/settings.css"), "utf8");

    // The card is an OctantButton, and the button recipe fixes a single-line
    // control height. Against the card's own `overflow: hidden` that clipped
    // the preview and cut the System/Light/Dark labels off entirely.
    expect(styles).toMatch(/\.settings-scheme__card\s*\{[^}]*height:\s*auto;/);
  });

  it("keeps routine Settings groups open while discrete objects remain raised", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/settings.css"), "utf8");

    expect(styles).toMatch(
      /\.settings-view\s*\{[\s\S]*background:\s*var\(--octant-app-background\)/,
    );
    expect(styles).toMatch(
      /\.settings-card-section\s*\{[\s\S]*background:\s*var\(--octant-settings-card\)/,
    );
    expect(styles).toMatch(
      /\.settings-card-section\s*\{[\s\S]*box-shadow:\s*var\(--octant-shadow-sm\)/,
    );
    expect(styles).toMatch(/\.settings-card-section--open\s*\{[\s\S]*box-shadow:\s*none/);
    expect(styles).toContain("border-radius: var(--oct-radius-md)");
    // Code defaults are SettingRows in the shared open sections; there is no
    // Code-only section recipe left to keep in step with them.
    expect(styles).not.toMatch(/\.code-settings__section/);
    expect(styles).toMatch(
      /\.settings-card-section--open > \.settings-fact-list > \.settings-fact-list__row\s*\{[^}]*border-top:\s*1px solid var\(--oct-hairline\)/,
    );
  });

  it("does not let the legacy 720px rail squeeze narrow Settings into a phantom column", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/settings.css"), "utf8");

    expect(styles).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.settings-view:not\(\.settings-view--narrow\)\s*\{\s*grid-template-columns:\s*216px minmax\(0, 1fr\)/,
    );
  });

  it("keeps sentence-case navigation groups visible inside the narrow drawer", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/settings.css"), "utf8");

    expect(styles).toMatch(/\.settings-view__drawer \.setnav-section\s*\{[^}]*display:\s*block/);
  });

  it("keeps search and the existing mode-switcher mutation wired", async () => {
    const { onSearchChange } = renderSettingsWithSearch("");
    navigateTo("Appearance");

    fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), {
      target: { value: "translucent" },
    });
    expect(onSearchChange).toHaveBeenCalledWith("translucent");
    // With a query active, the search results panel replaces section content.
    expect(
      await screen.findByRole("listbox", { name: "Settings search results" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Mode switcher" })).not.toBeInTheDocument();
  });

  it("changes the project view switcher presentation", () => {
    const { props } = renderSettings();
    navigateTo("Appearance");

    fireEvent.click(
      within(screen.getByRole("group", { name: "Project view switcher" })).getByRole("button", {
        name: "Buttons",
      }),
    );
    expect(props.onSettingsChange).toHaveBeenCalledWith({
      projectViewSwitcherPresentation: "inline",
    });
  });

  it("search returns precise settings and deep-links to the focused control", async () => {
    const user = userEvent.setup();
    const { onSearchChange } = renderSettingsWithSearch("");
    navigateTo("Appearance");

    const searchbox = screen.getByRole("searchbox", { name: "Search settings" });
    await user.type(searchbox, "mode switcher");
    const listbox = await screen.findByRole("listbox", { name: "Settings search results" });
    listbox.focus();
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    // Selecting the result clears the search and focuses the control.
    expect(onSearchChange).toHaveBeenLastCalledWith("");
    const modeSwitcher = screen.getByRole("group", { name: "Mode switcher" });
    expect(modeSwitcher).toBeInTheDocument();
    expect(within(modeSwitcher).getByRole("button", { name: "Buttons" })).toHaveFocus();
  });

  it("applies an initial deep link on mount to open a section and focus a setting", () => {
    renderSettings({ initialDeepLink: { section: "appearance", setting: "mode-switcher" } });

    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("group", { name: "Mode switcher" })).getByRole("button", {
        name: "Buttons",
      }),
    ).toHaveFocus();
  });

  it("applies a pending deep link from another app surface and reports it consumed", () => {
    const onDeepLinkApplied = vi.fn();
    const { rerender } = renderSettings({ onDeepLinkApplied });

    rerender(
      <SettingsView
        nativeBoundsAvailable
        onResetLayout={vi.fn()}
        onResetNativeBounds={vi.fn()}
        onSearchChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onDeepLinkApplied={onDeepLinkApplied}
        pendingDeepLink={{ section: "advanced", setting: "reset-layout" }}
        search=""
        settings={defaultShellSettings()}
        sidebarVibrancySupported
        visibleSettings={["reset-layout"]}
      />,
    );
    expect(screen.getByRole("heading", { name: "Advanced" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset active mode layout" })).toHaveFocus();
    expect(
      screen.getByText(/Restores the current mode's pane arrangement.*Threads and data are kept/i),
    ).toBeVisible();
    expect(onDeepLinkApplied).toHaveBeenCalledOnce();
  });

  it("hides native-only controls in browser mode and shows them in native mode", () => {
    const { rerender } = renderSettings({ nativeBoundsAvailable: false });
    navigateTo("Advanced");
    expect(screen.getByRole("button", { name: "Reset active mode layout" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reset native window bounds" }),
    ).not.toBeInTheDocument();

    rerender(
      <SettingsView
        nativeBoundsAvailable
        onResetLayout={vi.fn()}
        onResetNativeBounds={vi.fn()}
        onSearchChange={vi.fn()}
        onSettingsChange={vi.fn()}
        search=""
        settings={defaultShellSettings()}
        sidebarVibrancySupported
        visibleSettings={["reset-layout", "reset-window-bounds"]}
      />,
    );
    navigateTo("Advanced");
    expect(screen.getByRole("button", { name: "Reset native window bounds" })).toBeInTheDocument();
  });

  it("announces no results when a search matches nothing", () => {
    renderSettingsWithSearch("zzz-nothing");
    const statuses = screen.getAllByRole("status");
    const noResults = statuses.find((el) => /no settings match/i.test(el.textContent ?? ""));
    expect(noResults).toBeDefined();
  });

  it("forwards isNarrow to the Usage dashboard activity table", async () => {
    const usageClient = {
      query: vi.fn(async () => ({
        records: [
          {
            reconciliationId: "rec-1",
            subject: { aggregateType: "chat-thread", aggregateId: "thread-1" },
            providerInstanceId: "provider-1",
            modelId: "gpt-4o",
            requestShape: "chat-turn",
            quality: "exact",
            inputTokens: 100,
            outputTokens: 50,
            plannedInputTokens: 95,
            varianceTokens: 5,
            attribution: [{ category: "conversation", plannedTokens: 95, quality: "exact" }],
            observedAt: "2026-07-24T12:00:00.000Z",
          },
        ],
        totals: {
          totalInputTokens: 100,
          totalOutputTokens: 50,
          totalRequests: 1,
          exactCount: 1,
          estimatedCount: 0,
          reconciledCount: 0,
          staleCount: 0,
          unavailableCount: 0,
        },
        byProvider: [],
        byCategory: [],
        byDay: [
          {
            bucketStart: "2026-07-24T12:00:00.000Z",
            inputTokens: 100,
            outputTokens: 50,
            requestCount: 1,
            exactCount: 1,
            estimatedCount: 0,
            reconciledCount: 0,
            staleCount: 0,
            unavailableCount: 0,
          },
        ],
        byWeek: [],
        cumulative: [],
        topConsumers: [],
        hasMore: false,
        queryAt: "2026-07-24T12:00:00.000Z",
        latencyStats: { measurements: [] },
      })),
      export: vi.fn(),
      reset: vi.fn(),
      retain: vi.fn(),
    };
    renderSettings({ usageClient: usageClient as never, isNarrow: true });
    fireEvent.click(screen.getByRole("button", { name: "Settings sections" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Settings sections" })).getByRole("button", {
        name: "Usage",
      }),
    );
    const table = await screen.findByRole("table", { name: "daily activity" });
    expect(table.className).toContain("usage-dashboard__table--narrow");
    expect(screen.getAllByRole("heading", { name: "Usage" })).toHaveLength(1);
  });

  it("mounts provider limits beside the local usage dashboard", async () => {
    const usageClient = {
      query: vi.fn(async () => {
        throw new Error("No local usage records.");
      }),
      export: vi.fn(),
      reset: vi.fn(),
      retain: vi.fn(),
    };
    const providerUsageLimitsClient = {
      list: vi.fn(async () => ({
        version: 1 as const,
        refreshedAt: now,
        entries: [],
      })),
      refresh: vi.fn(async () => ({
        version: 1 as const,
        refreshedAt: now,
        entries: [],
      })),
    };

    renderSettings({
      usageClient: usageClient as never,
      providerUsageLimitsClient: providerUsageLimitsClient as never,
      initialDeepLink: { section: "usage" },
    });

    expect(screen.getByRole("heading", { name: "Provider limits" })).toBeVisible();
    expect(await screen.findByText("No configured providers have reported limits.")).toBeVisible();
    const dashboard = document.querySelector(".usage-dashboard");
    const limits = screen.getByRole("heading", { name: "Provider limits" }).closest("section");
    expect(dashboard).not.toBeNull();
    expect(limits).not.toBeNull();
    expect(
      dashboard!.compareDocumentPosition(limits!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(providerUsageLimitsClient.list).toHaveBeenCalledOnce();
  });

  it("hides the diagnostics export control in Advanced when no client is provided", () => {
    renderSettings();
    navigateTo("Advanced");
    expect(screen.queryByRole("button", { name: /export diagnostics/i })).not.toBeInTheDocument();
  });

  it("exports diagnostics from the Advanced section when a client is provided", async () => {
    const diagnosticsExportClient = {
      exportEvidence: vi.fn(async () => ({
        kind: "exported" as const,
        packet: {
          packetVersion: 1 as const,
          packetId: "00000000-0000-4000-8000-0000000000aa",
          domain: "provider" as const,
          failureCode: "provider-support-export",
          summary: "Provider timed out.",
          hostVersions: [{ component: "runtime", version: "v22.1.0" }],
          candidateVersions: [{ component: "runtime", version: "v22.1.0" }],
          correlations: [
            {
              correlationId: "00000000-0000-4000-8000-000000000001",
              observedAt: "2026-07-24T12:00:00.000Z",
            },
          ],
          recovery: [{ action: "Verify provider credentials.", automated: false }],
          redactions: [],
          redacted: true as const,
          generatedAt: "2026-07-24T12:00:00.000Z",
        },
        receipt: {
          packetId: "00000000-0000-4000-8000-0000000000aa",
          domain: "provider" as const,
          failureCode: "provider-support-export",
          redactions: [],
          contentDigest: "a".repeat(64),
          generatedAt: "2026-07-24T12:00:00.000Z",
          createdAt: "2026-07-24T12:00:01.000Z",
        },
      })),
    };
    renderSettings({ diagnosticsExportClient: diagnosticsExportClient as never });
    navigateTo("Advanced");
    const exportButton = screen.getByRole("button", { name: /export diagnostics/i });
    expect(exportButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/describe what happened/i), {
      target: { value: "Provider timed out." },
    });
    fireEvent.change(screen.getByLabelText(/failure correlation id/i), {
      target: { value: "00000000-0000-4000-8000-000000000001" },
    });
    fireEvent.click(exportButton);
    await waitFor(() => expect(diagnosticsExportClient.exportEvidence).toHaveBeenCalledOnce());
    expect(await screen.findByText(/00000000-0000-4000-8000-0000000000aa/)).toBeInTheDocument();
  });

  it("mounts the Skills & Extensions settings view when an extension client is provided", async () => {
    const extensionClient = {
      snapshot: vi.fn(async () => ({
        sequence: 1,
        snapshotAt: now,
        packages: [],
        collisions: [],
      })),
      effectiveState: vi.fn(async () => ({
        sequence: 1,
        snapshotAt: now,
        scope: {
          hostId: "local",
          mode: "code",
          projectId: null,
          threadId: null,
          providerFamily: "openai-compatible",
        },
        catalogEpoch: `sha256:${"a".repeat(64)}`,
        catalogStatus: "available",
        stale: false,
        packages: [],
        collisions: [],
      })),
      execute: vi.fn(),
      importLocalPluginReceipt: vi.fn(),
    };
    renderSettings({ extensionClient: extensionClient as never });
    navigateTo("Skills & Extensions");
    expect(await screen.findAllByRole("heading", { name: "Skills & Extensions" })).toHaveLength(1);
    expect(await screen.findByRole("tab", { name: /installed/i })).toBeVisible();
  });

  it("mounts the Host section when a host control client is provided", async () => {
    const hostControlClient = {
      status: vi.fn(async () => ({
        identity: { hostId: "host-1", instanceId: "instance-1", serviceMode: "service" },
        versions: { server: "1.2.3", wire: "9" },
        policy: { kind: "known", enabled: true, updatedAt: now },
        readiness: {
          store: { state: "ready", integrity: "verified" },
          replay: { journalHead: 42, projections: 42 },
          clientsConnected: 2,
          uptimeSeconds: 3600,
        },
        capabilities: ["platform:systemd-user-units"],
        work: { active: 0, attentionRequired: false },
        lifecycle: {
          stop: { kind: "available" },
          restart: { kind: "available" },
          enable: { kind: "available" },
          disable: { kind: "available" },
        },
      })),
      lifecycle: vi.fn(),
      backup: vi.fn(),
      restore: vi.fn(),
    };
    renderSettings({ hostControlClient: hostControlClient as never });
    navigateTo("Host");
    expect(await screen.findByText("host-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop host" })).toBeEnabled();
  });

  it("explains that host controls stay on the host when no client is available", () => {
    renderSettings();
    navigateTo("Host");
    expect(screen.getByText(/available on the host machine only/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop host" })).not.toBeInTheDocument();
  });

  it("mounts the GitHub section when a GitHub client is provided", async () => {
    const githubClient = {
      authenticationSnapshot: vi.fn(async () => ({
        state: "ready",
        account: { login: "octocat", gitProtocol: "https", scopes: ["repo"] },
        capabilities: [{ kind: "repository-catalogue", available: true }],
      })),
      executeAuthenticationCommand: vi.fn(),
      readCatalogue: vi.fn(),
      recordRecentRepository: vi.fn(),
    };
    renderSettings({ githubClient: githubClient as never });
    navigateTo("GitHub");
    expect(await screen.findByText("octocat")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled();
  });

  it("explains that the GitHub connection stays on the host when no client is available", () => {
    renderSettings();
    navigateTo("GitHub");
    expect(screen.getByText(/managed on the owning host/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh status" })).not.toBeInTheDocument();
  });

  it("omits the GitHub section when the github-integration plugin is not effective", () => {
    renderSettings({
      effectivePlugins: new Map([["github-integration", false]]),
    });
    expect(screen.queryByRole("button", { name: "GitHub" })).not.toBeInTheDocument();
  });

  it("omits Linear when the bundled-off plugin is not effective", () => {
    renderSettings();
    expect(screen.queryByRole("button", { name: "Linear" })).not.toBeInTheDocument();
  });

  it("shows Linear through the plugin Settings contribution when effective", async () => {
    const integrationClient = {
      authenticationSnapshot: vi.fn(async () => ({
        state: "unauthorized",
        capabilities: [],
        remediation: "Connect Linear to authorize this host.",
      })),
      executeAuthenticationCommand: vi.fn(),
      storePersonalCredential: vi.fn(),
      deletePersonalCredential: vi.fn(),
    };
    renderSettings({
      effectivePlugins: new Map([["linear-integration", true]]),
      integrationClient: integrationClient as never,
    });
    expect(screen.getByRole("button", { name: "Linear" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Linear" }));
    expect(await screen.findByRole("button", { name: "Connect" })).toBeEnabled();
  });

  it("assigns the settings surface an explicit visual class contract", () => {
    const onSettingsChange = vi.fn();
    render(
      <SettingsView
        nativeBoundsAvailable
        onResetLayout={vi.fn()}
        onResetNativeBounds={vi.fn()}
        onBack={vi.fn()}
        onSearchChange={vi.fn()}
        onSettingsChange={onSettingsChange}
        search=""
        settings={settingsPastFirstRun()}
        sidebarVibrancySupported={false}
        visibleSettings={[
          "enable-chat",
          "enable-work",
          "sidebar-width",
          "sidebar-material",
          "mode-switcher",
          "reset-layout",
          "reset-window-bounds",
        ]}
      />,
    );

    expect(screen.getByRole("region", { name: "Settings" })).toHaveClass("settings-view");
    expect(screen.getByRole("complementary", { name: "Settings sidebar" })).toHaveClass(
      "settings-view__sidebar",
    );
    expect(screen.getByRole("button", { name: "Back to app" })).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "Search settings" })).toHaveClass(
      "settings-view__text-input",
    );
    expect(screen.getByRole("switch", { name: "Enable Chat" })).toHaveClass("octant-switch");
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.getByRole("slider", { name: "Sidebar width" })).toHaveClass(
      "settings-view__range",
    );
    expect(screen.getByRole("switch", { name: "Translucent sidebar" })).toHaveClass(
      "octant-switch",
    );
    const modeSwitcher = screen.getByRole("group", { name: "Mode switcher" });
    expect(within(modeSwitcher).getByRole("button", { name: "Dropdown" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(within(modeSwitcher).getByRole("button", { name: "Buttons" }));
    expect(onSettingsChange).toHaveBeenCalledWith({ modeSwitcherPresentation: "buttons" });
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByRole("button", { name: "Reset active mode layout" })).toHaveClass(
      "settings-view__action",
    );
    expect(screen.getByRole("button", { name: "Reset native window bounds" })).toHaveClass(
      "settings-view__action",
    );
  });

  it("resets the active mode layout from Advanced settings", async () => {
    const user = userEvent.setup();
    const onResetLayout = vi.fn();
    render(
      <SettingsView
        nativeBoundsAvailable={false}
        onResetLayout={onResetLayout}
        onResetNativeBounds={vi.fn()}
        onSearchChange={vi.fn()}
        onSettingsChange={vi.fn()}
        search=""
        settings={settingsPastFirstRun()}
        sidebarVibrancySupported={false}
        visibleSettings={["reset-layout"]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    await user.click(screen.getByRole("button", { name: "Reset active mode layout" }));
    expect(onResetLayout).toHaveBeenCalledOnce();
  });
});
