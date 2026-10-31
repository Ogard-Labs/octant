import type {
  AggregateVersion,
  DiscoveryCandidate,
  DiscoverySnapshot,
  OutsideProviderDriverListing,
  ProviderInstance,
  ProviderInstanceId,
  ProviderObservedState,
  UtcTimestamp,
} from "@octant/contracts";
import type { HostPlatform } from "@octant/contracts/host";
import { createAzureFoundryProvider, createCodexProvider } from "@octant/domain";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostPlatformContext } from "../../platform";
import { ProviderCatalogView, type ProviderCatalogViewProps } from "./ProviderCatalogView";

const now = "2026-10-11T12:00:00.000Z" as UtcTimestamp;
const codexId = "00000000-0000-4000-8000-000000000391" as ProviderInstanceId;

const codexCandidate = {
  driverKind: "codex",
  displayName: "Codex CLI",
  binaryPath: "/usr/local/bin/codex",
  version: "codex-cli 0.1.0",
  readiness: "ready",
  pathSummary: "/usr/local/bin",
  detectedAt: now,
} as unknown as DiscoveryCandidate;

function snapshot(candidates: ReadonlyArray<DiscoveryCandidate>): DiscoverySnapshot {
  return {
    hostId: "local",
    candidates,
    scannedAt: now,
    scanDurationMs: 20,
    status: "completed",
  } as unknown as DiscoverySnapshot;
}

function codex(enabled: boolean): ProviderInstance {
  return createCodexProvider({
    id: codexId,
    displayName: "Codex CLI",
    binaryPath: "/usr/local/bin/codex",
    existingInstances: [],
    expectedVersion: 0 as AggregateVersion,
    createdAt: now,
    enabled,
  });
}

function observed(readiness: ProviderObservedState["readiness"]): ProviderObservedState {
  return {
    instanceId: codexId,
    readiness,
    processState: "stopped",
    models: [],
    capabilities: {
      streaming: "supported",
      resume: "supported",
      interruption: "supported",
      approvals: "supported",
      userQuestions: "supported",
      reasoning: "supported",
      usage: "supported",
      toolActivity: "supported",
      fileChanges: "supported",
      diffs: "supported",
      taskProgress: "supported",
      nativeChildAgents: "unsupported",
      nativeAttachments: "supported",
      nativeWebResearch: "unsupported",
      appManagedTools: "supported",
      citations: "unsupported",
      harnessAutoReview: "unsupported",
    },
    observedAt: now,
  };
}

function props(overrides: Partial<ProviderCatalogViewProps> = {}) {
  const onScan = vi.fn(async () => undefined);
  const onConnect = vi.fn(async () => true);
  const base: ProviderCatalogViewProps = {
    status: "ready",
    instances: [],
    observedByInstance: new Map(),
    probingIds: new Set(),
    busy: false,
    discovery: {
      snapshot: undefined,
      scanning: false,
      connectingPaths: new Set(),
      onScan,
      onConnect,
    },
    onSetEnabled: vi.fn(async () => true),
    onProbe: vi.fn(async () => true),
    onOpenModelEndpoints: vi.fn(),
    onOpenProviders: vi.fn(),
    ...overrides,
  };
  return { ...base, onScan, onConnect };
}

function openSetup(name: RegExp) {
  fireEvent.click(screen.getByRole("link", { name }));
}

function renderOnHost(hostPlatform: HostPlatform, ui: ReactElement) {
  return render(
    <HostPlatformContext.Provider value={hostPlatform}>{ui}</HostPlatformContext.Provider>,
  );
}

// Each host is seen from a window on the other platform, so copy that read the
// window's platform instead of the host's would name the wrong computer.
const hostsSeenFromTheOtherPlatform = [
  {
    host: "linux",
    window: "MacIntel",
    store: "this computer's credential store",
    elsewhere: /keychain|this Mac/i,
  },
  {
    host: "darwin",
    window: "Linux x86_64",
    store: "this Mac's Keychain",
    elsewhere: /credential store|this computer|system keychain/,
  },
] as const;

function seenFromWindowOn(windowPlatform: string) {
  beforeEach(() => {
    Object.defineProperty(window.navigator, "platform", {
      value: windowPlatform,
      configurable: true,
    });
  });
  afterEach(() => Reflect.deleteProperty(window.navigator, "platform"));
}

describe("ProviderCatalogView", () => {
  it("lists all 22 bundled drivers as installed and trusted, split into runtimes and endpoints", () => {
    render(<ProviderCatalogView {...props()} />);
    const runtimes = screen.getByRole("list", { name: "Agent runtimes" });
    const endpoints = screen.getByRole("list", { name: "Model endpoints" });
    expect(within(runtimes).getAllByRole("listitem")).toHaveLength(17);
    expect(within(endpoints).getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByRole("status", { name: "Provider catalog summary" }).textContent).toBe(
      "22 drivers · 0 ready · 0 need you",
    );
    expect(screen.getByText(/each is already installed and trusted/)).toBeDefined();
  });

  it("starts nothing when the catalog or a driver's setup is opened", () => {
    const view = props();
    render(<ProviderCatalogView {...view} />);
    openSetup(/^Codex CLI, /);
    expect(screen.getByRole("heading", { level: 1, name: "Codex CLI" })).toBeDefined();
    expect(view.onScan).not.toHaveBeenCalled();
    expect(view.onConnect).not.toHaveBeenCalled();
    expect(view.onProbe).not.toHaveBeenCalled();
    expect(view.onSetEnabled).not.toHaveBeenCalled();
  });

  it("sends Amazon Bedrock to Add endpoint, saying it takes no key and signs in from the host's terminal", () => {
    const view = props();
    render(<ProviderCatalogView {...view} />);
    openSetup(/^Amazon Bedrock, /);
    expect(
      screen.getByText(
        /choose Amazon Bedrock in Add endpoint.*sign in from a terminal on this host/,
      ),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Open Model endpoints" }));
    expect(view.onOpenModelEndpoints).toHaveBeenCalledOnce();
  });

  it("says plainly that a bundled driver needs no install or trust step and offers none", () => {
    render(<ProviderCatalogView {...props()} />);
    openSetup(/^Gemini CLI, /);
    expect(
      screen.getByText(/already installed and trusted. There is nothing to download/),
    ).toBeDefined();
    expect(screen.getByText("Yes, reviewed by Octant")).toBeDefined();
    expect(screen.queryByRole("button", { name: /install|trust/i })).toBeNull();
  });

  it("looks on the host only when asked, then offers to add what it found", async () => {
    const view = props();
    const { rerender } = render(<ProviderCatalogView {...view} />);
    openSetup(/^Codex CLI, /);
    fireEvent.click(screen.getByRole("button", { name: "Look on this host" }));
    expect(view.onScan).toHaveBeenCalledTimes(1);

    rerender(
      <ProviderCatalogView
        {...view}
        discovery={{ ...view.discovery!, snapshot: snapshot([codexCandidate]) }}
      />,
    );
    expect(screen.getByText(/Found Codex CLI codex-cli 0.1.0 in \/usr\/local\/bin/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Add Codex CLI" }));
    await waitFor(() => expect(view.onConnect).toHaveBeenCalledWith(codexCandidate));
  });

  it("closes the driver's setup when it sends a person to Providers & Models", () => {
    const view = props();
    const { rerender } = render(<ProviderCatalogView {...view} />);
    openSetup(/^Codex CLI, /);
    // A look that found nothing leaves only the unusual-path route.
    rerender(
      <ProviderCatalogView {...view} discovery={{ ...view.discovery!, snapshot: snapshot([]) }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Providers & Models" }));
    expect(view.onOpenProviders).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading", { level: 1, name: "Codex CLI" })).toBeNull();
    expect(screen.getByRole("list", { name: "Agent runtimes" })).toBeDefined();
  });

  it("continues the provider already configured instead of offering to add another", () => {
    const view = props({
      instances: [codex(false)],
      discovery: {
        snapshot: snapshot([codexCandidate]),
        scanning: false,
        connectingPaths: new Set(),
        onScan: vi.fn(async () => undefined),
        onConnect: vi.fn(async () => true),
      },
    });
    render(<ProviderCatalogView {...view} />);
    openSetup(/^Codex CLI, off/);
    expect(screen.queryByRole("button", { name: "Add Codex CLI" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(view.onSetEnabled).toHaveBeenCalledWith(codexId, true);
  });

  it("shows enabled, signed in, and ready as separate facts and points sign-in at its card", () => {
    render(
      <ProviderCatalogView
        {...props({
          instances: [codex(true)],
          observedByInstance: new Map([[codexId, observed("unauthenticated")]]),
          renderRuntimeCard: (instance) => <p>Card for {instance.displayName}</p>,
        })}
      />,
    );
    openSetup(/^Codex CLI, sign in to use/);
    const facts = screen.getByRole("heading", { name: "State" }).closest("section")!;
    expect(within(facts).getByText("Available").nextSibling?.textContent).toBe("Yes");
    expect(within(facts).getByText("Enabled").nextSibling?.textContent).toBe("On");
    expect(within(facts).getByText("Signed in").nextSibling?.textContent).toBe("Needs sign-in");
    expect(within(facts).getByText("Ready").nextSibling?.textContent).toBe("No");
    expect(
      screen.getByText(/stored in this computer's credential store, never in the catalog/),
    ).toBeDefined();
    expect(screen.getByText("Card for Codex CLI")).toBeDefined();
  });

  it("keeps a refused step actionable with the host's reason and a Try again", async () => {
    const onProbe = vi.fn(async () => false);
    render(
      <ProviderCatalogView
        {...props({
          instances: [codex(true)],
          message: "Codex CLI did not answer its version check.",
          onProbe,
        })}
      />,
    );
    openSetup(/^Codex CLI, not checked yet/);
    fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
    expect(await screen.findByText("Codex CLI did not answer its version check.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onProbe).toHaveBeenCalledTimes(2));
  });

  it("says why looking on the host failed and offers Try again", async () => {
    const onScan = vi.fn(async () => undefined);
    const view = props();
    render(
      <ProviderCatalogView
        {...view}
        discovery={{
          ...view.discovery!,
          message: "Discovery service is unavailable.",
          onScan,
        }}
      />,
    );
    openSetup(/^Codex CLI, /);
    fireEvent.click(screen.getByRole("button", { name: "Look on this host" }));
    expect(await screen.findByText("Discovery service is unavailable.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onScan).toHaveBeenCalledTimes(2));
  });

  it("treats a scan that came back failed as a failure rather than success", async () => {
    const failed = {
      ...snapshot([]),
      status: "failed",
      message: "Discovery scan exceeded its time budget.",
    } as DiscoverySnapshot;
    const view = props();
    render(
      <ProviderCatalogView
        {...view}
        discovery={{ ...view.discovery!, onScan: vi.fn(async () => failed) }}
      />,
    );
    openSetup(/^Codex CLI, /);
    fireEvent.click(screen.getByRole("button", { name: "Look on this host" }));
    expect(await screen.findByText("Octant could not look on this host.")).toBeDefined();
  });

  it("sends an endpoint driver to Add endpoint rather than adding one itself", () => {
    const view = props();
    render(<ProviderCatalogView {...view} />);
    openSetup(/^Azure AI Foundry, /);
    expect(screen.queryByText("Find it on this host")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Model endpoints" }));
    expect(view.onOpenModelEndpoints).toHaveBeenCalledTimes(1);
  });

  it("states modes and agent loop honestly, including a driver that runs no turns", () => {
    render(<ProviderCatalogView {...props()} />);
    openSetup(/^Oh My Pi, /);
    const section = screen.getByRole("heading", { name: "What it can do" }).closest("section")!;
    expect(within(section).getByText("Chat").nextSibling?.textContent).toBe("No");
    expect(
      within(section).getByText("Octant lists its models but does not start turns with it yet"),
    ).toBeDefined();
  });

  it.each([
    [
      /^Codex CLI, /,
      "Runs its own agent loop. Octant's sandbox confines it and approvals gate it, except on Full access",
    ],
    [
      /^Claude Code, /,
      "Runs its own agent loop. Octant's sandbox confines it in Plan only; elsewhere its own sandbox applies, which Full access turns off",
    ],
    [
      /^Gemini CLI, /,
      "Runs its own agent loop. Octant's sandbox confines it and approvals gate it, except on Full access",
    ],
  ])("says who sandboxes %s as the confinement matrix does", (name, sentence) => {
    render(<ProviderCatalogView {...props()} />);
    openSetup(name);
    const section = screen.getByRole("heading", { name: "What it can do" }).closest("section")!;
    expect(within(section).getByText("Agent loop").nextSibling?.textContent).toBe(sentence);
    // Full access runs no sandbox at all, so no runtime's line may promise one there.
    expect(sentence).toContain("Full access");
  });

  it("returns to the row it opened from on Back and on Escape", () => {
    render(<ProviderCatalogView {...props()} />);
    openSetup(/^Codex CLI, /);
    fireEvent.click(screen.getByRole("button", { name: "Back to Provider catalog" }));
    expect(document.activeElement?.getAttribute("data-catalog-key")).toBe("codex");
    openSetup(/^Claude Code, /);
    fireEvent.keyDown(screen.getByRole("heading", { level: 1, name: "Claude Code" }), {
      key: "Escape",
    });
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });
});

describe.each(hostsSeenFromTheOtherPlatform)(
  "where the catalog says a key is kept on a $host host",
  (platform) => {
    seenFromWindowOn(platform.window);
    const foundryId = "00000000-0000-4000-8000-000000000392" as ProviderInstanceId;

    it("names the host's store before an endpoint is added", () => {
      renderOnHost(platform.host, <ProviderCatalogView {...props()} />);
      openSetup(/^Azure AI Foundry, /);
      const sentence = screen.getByText(/A key you enter is stored in/);
      expect(sentence).toHaveTextContent(`A key you enter is stored in ${platform.store}.`);
      expect(sentence.textContent).not.toMatch(platform.elsewhere);
    });

    it("names the host's store when a runtime needs a sign-in", () => {
      renderOnHost(
        platform.host,
        <ProviderCatalogView
          {...props({
            instances: [codex(true)],
            observedByInstance: new Map([[codexId, observed("unauthenticated")]]),
          })}
        />,
      );
      openSetup(/^Codex CLI, sign in to use/);
      const sentence = screen.getByText(/A key you enter there is stored in/);
      expect(sentence).toHaveTextContent(
        `A key you enter there is stored in ${platform.store}, never in the catalog.`,
      );
      expect(sentence.textContent).not.toMatch(platform.elsewhere);
    });

    it("names the host's store when an endpoint needs a sign-in or a key", () => {
      const foundry = createAzureFoundryProvider({
        id: foundryId,
        displayName: "Foundry relay",
        configuration: {
          kind: "azure-foundry-openai-http",
          baseUrl: "https://foundry.example.openai.azure.com/openai/v1/",
          authentication: "api-key",
          protocol: "auto",
          manualModelIds: ["deployment-a"],
        },
        existingInstances: [],
        expectedVersion: 0 as AggregateVersion,
        createdAt: now,
      });
      renderOnHost(
        platform.host,
        <ProviderCatalogView
          {...props({
            instances: [foundry],
            observedByInstance: new Map([
              [foundryId, { ...observed("unauthenticated"), instanceId: foundryId }],
            ]),
          })}
        />,
      );
      openSetup(/^Azure AI Foundry, /);
      const sentence = screen.getByText(/a key is stored in/);
      expect(sentence).toHaveTextContent(
        `Add it on its Model endpoints page; a key is stored in ${platform.store}, never in the catalog.`,
      );
      expect(sentence.textContent).not.toMatch(platform.elsewhere);
    });
  },
);

describe("ProviderCatalogView outside drivers", () => {
  const listing = {
    driver: {
      extensionId: "00000000-0000-4000-8000-000000000911",
      packageId: "00000000-0000-4000-8000-000000000912",
      componentId: "driver",
      version: "0.1.0",
      digest: `sha256:${"b".repeat(64)}`,
    },
    displayName: "Loopback chat",
    source: "local-folder",
    installed: true,
    trusted: true,
  } as unknown as OutsideProviderDriverListing;
  const outsideId = "00000000-0000-4000-8000-000000000913" as ProviderInstanceId;
  const outsideInstance = (digest: string, enabled = false, keyed = false): ProviderInstance =>
    ({
      id: outsideId,
      displayName: "Loopback chat",
      driverKind: "outside-harness-endpoint",
      configuration: {
        kind: "outside-harness-endpoint",
        driver: { ...listing.driver, digest },
        baseUrl: "http://127.0.0.1:11434/",
        modelIds: ["local-model"],
        ...(keyed ? { key: { header: "authorization", scheme: "Bearer" } } : {}),
      },
      enabled,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: now,
      updatedAt: now,
    }) as unknown as ProviderInstance;

  it("lists an admitted outside driver in its own group with an outside label, never as bundled", () => {
    render(<ProviderCatalogView {...props({ outsideDrivers: [listing] })} />);
    const outside = screen.getByRole("list", { name: "Outside drivers" });
    const row = within(outside).getByRole("link", {
      name: "Loopback chat, not added. Open setup",
    });
    expect(row.textContent).toContain("Model endpoint · Outside driver");
    expect(row.textContent).not.toContain("Bundled");
    expect(screen.getByRole("status", { name: "Provider catalog summary" }).textContent).toBe(
      "23 drivers · 0 ready · 0 need you",
    );
    expect(screen.getByText(/Outside drivers are listed once you have trusted/)).toBeDefined();
  });

  it("shows no outside group when the host admits none", () => {
    render(<ProviderCatalogView {...props()} />);
    expect(screen.queryByRole("list", { name: "Outside drivers" })).toBeNull();
  });

  it("adds a provider from the driver with the address, key placement, key, and models given", async () => {
    const onAddOutsideProvider = vi.fn(async () => true);
    const view = props({
      outsideDrivers: [listing],
      onAddOutsideProvider,
      credentialManagementAvailable: true,
    });
    render(<ProviderCatalogView {...view} />);
    openSetup(/^Loopback chat, /);
    expect(screen.getByRole("heading", { level: 1, name: "Loopback chat" })).toBeDefined();
    const form = screen.getByRole("form", { name: "Add a provider from Loopback chat" });
    fireEvent.change(within(form).getByLabelText("Address"), {
      target: { value: "https://models.example.test/v1" },
    });
    fireEvent.change(within(form).getByLabelText("API key"), { target: { value: "KEY-1" } });
    fireEvent.change(within(form).getByLabelText("Model IDs"), {
      target: { value: "model-a, model-b model-a" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Add provider" }));
    await waitFor(() => expect(onAddOutsideProvider).toHaveBeenCalledTimes(1));
    const [displayName, configuration, credential] = onAddOutsideProvider.mock
      .calls[0] as unknown as [string, unknown, { readonly value: string }];
    expect(displayName).toBe("Loopback chat");
    expect(configuration).toEqual({
      kind: "outside-harness-endpoint",
      driver: listing.driver,
      baseUrl: "https://models.example.test/v1",
      key: { header: "authorization", scheme: "Bearer" },
      modelIds: ["model-a", "model-b"],
    });
    expect(credential.value).toBe("KEY-1");
    // Opening and adding never start anything on their own.
    expect(view.onProbe).not.toHaveBeenCalled();
    expect(view.onSetEnabled).not.toHaveBeenCalled();
  });

  it("refuses a form with no models before it asks the host", () => {
    const onAddOutsideProvider = vi.fn(async () => true);
    render(<ProviderCatalogView {...props({ outsideDrivers: [listing], onAddOutsideProvider })} />);
    openSetup(/^Loopback chat, /);
    fireEvent.change(screen.getByLabelText("Address"), {
      target: { value: "http://127.0.0.1:11434" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    expect(screen.getByText(/at least one model ID/)).toBeDefined();
    expect(onAddOutsideProvider).not.toHaveBeenCalled();
  });

  it("names where the host keeps the driver's key: the Keychain on a Mac, the credential store on Linux", () => {
    const view = props({
      outsideDrivers: [listing],
      onAddOutsideProvider: vi.fn(async () => true),
      credentialManagementAvailable: true,
    });
    const { unmount } = render(
      <HostPlatformContext.Provider value="linux">
        <ProviderCatalogView {...view} />
      </HostPlatformContext.Provider>,
    );
    openSetup(/^Loopback chat, /);
    expect(screen.getByText(/^Saved in this computer's credential store\./)).toBeDefined();
    unmount();

    render(
      <HostPlatformContext.Provider value="darwin">
        <ProviderCatalogView {...view} />
      </HostPlatformContext.Provider>,
    );
    openSetup(/^Loopback chat, /);
    expect(screen.getByText(/^Saved in this Mac's Keychain\./)).toBeDefined();
  });

  it("tells a browser on a Linux host its key is added in the desktop app on this computer", () => {
    render(
      <HostPlatformContext.Provider value="linux">
        <ProviderCatalogView
          {...props({
            outsideDrivers: [listing],
            onAddOutsideProvider: vi.fn(async () => true),
            credentialManagementAvailable: false,
          })}
        />
      </HostPlatformContext.Provider>,
    );
    openSetup(/^Loopback chat, /);
    expect(screen.getByText(/desktop app on this computer\.$/)).toBeDefined();
  });

  it("continues the provider bound to this digest, and says the package is unsigned developer input", () => {
    render(
      <ProviderCatalogView
        {...props({
          outsideDrivers: [listing],
          instances: [outsideInstance(listing.driver.digest)],
          renderRuntimeCard: (instance) => <p>Card for {instance.displayName}</p>,
        })}
      />,
    );
    openSetup(/^Loopback chat, off/);
    expect(screen.getByRole("button", { name: "Turn on" })).toBeDefined();
    expect(screen.getByText("Card for Loopback chat")).toBeDefined();
    const pkg = screen.getByRole("heading", { name: "Package" }).closest("section")!;
    expect(within(pkg).getByText("Source").nextSibling?.textContent).toBe("Local folder, unsigned");
    expect(within(pkg).getByText("Trusted").nextSibling?.textContent).toBe(
      "Yes, by you, at this digest",
    );
    expect(within(pkg).getByText("Digest").nextSibling?.textContent).toBe(listing.driver.digest);
    expect(screen.queryByRole("button", { name: "Open Model endpoints" })).toBeNull();
  });

  it("names the publisher key of a signed driver folder", () => {
    const publisherKey = `ed25519:${"e".repeat(64)}`;
    render(
      <ProviderCatalogView
        {...props({
          outsideDrivers: [{ ...listing, publisherKey: publisherKey as never }],
          instances: [outsideInstance(listing.driver.digest)],
        })}
      />,
    );
    openSetup(/^Loopback chat, off/);
    const pkg = screen.getByRole("heading", { name: "Package" }).closest("section");
    if (pkg === null) throw new Error("expected the package section");
    expect(within(pkg).getByText("Source").nextSibling?.textContent).toBe("Local folder, signed");
    expect(within(pkg).getByText("Publisher key").nextSibling?.textContent).toBe(publisherKey);
  });

  it("names the npm package and integrity a signed driver was fetched from", () => {
    const publisherKey = `ed25519:${"e".repeat(64)}`;
    const npm = {
      packageName: "@example/loopback-chat",
      version: "0.1.0",
      registry: "https://registry.example.test",
      integrity: `sha512-${"D".repeat(86)}==`,
    };
    render(
      <ProviderCatalogView
        {...props({
          outsideDrivers: [
            { ...listing, source: "npm", npm: npm as never, publisherKey: publisherKey as never },
          ],
          instances: [outsideInstance(listing.driver.digest)],
        })}
      />,
    );
    openSetup(/^Loopback chat, off/);
    const pkg = screen.getByRole("heading", { name: "Package" }).closest("section");
    if (pkg === null) throw new Error("expected the package section");
    expect(within(pkg).getByText("Source").nextSibling?.textContent).toBe(
      "npm, @example/loopback-chat@0.1.0",
    );
    expect(within(pkg).getByText("Integrity").nextSibling?.textContent).toBe(npm.integrity);
    expect(pkg.textContent).toContain("Installed from an npm registry");
    expect(pkg.textContent).not.toContain("folder on this computer");
  });

  it("does not count a provider bound to another digest of the same driver", () => {
    render(
      <ProviderCatalogView
        {...props({
          outsideDrivers: [listing],
          instances: [outsideInstance(`sha256:${"c".repeat(64)}`, true)],
        })}
      />,
    );
    expect(
      within(screen.getByRole("list", { name: "Outside drivers" })).getByRole("link", {
        name: "Loopback chat, not added. Open setup",
      }),
    ).toBeDefined();
  });

  describe.each(hostsSeenFromTheOtherPlatform)(
    "where its sign-in step says the key is kept on a $host host",
    (platform) => {
      seenFromWindowOn(platform.window);

      it("names the host's store when the service refused the driver's key", () => {
        renderOnHost(
          platform.host,
          <ProviderCatalogView
            {...props({
              outsideDrivers: [listing],
              instances: [outsideInstance(String(listing.driver.digest), true, true)],
              observedByInstance: new Map([
                [outsideId, { ...observed("unauthenticated"), instanceId: outsideId }],
              ]),
            })}
          />,
        );
        openSetup(/^Loopback chat, /);
        const sentence = screen.getByText(/The key is stored in/);
        expect(sentence).toHaveTextContent(
          `The key is stored in ${platform.store} and never reaches the driver.`,
        );
        expect(sentence.textContent).not.toMatch(platform.elsewhere);
      });
    },
  );
});
