import type {
  AggregateVersion,
  DiscoveryCandidate,
  DiscoverySnapshot,
  ProviderInstance,
  ProviderInstanceId,
  ProviderObservedState,
  UtcTimestamp,
} from "@octant/contracts";
import { createCodexProvider } from "@octant/domain";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

  it("says Amazon Bedrock cannot be added in Settings yet and offers no Add endpoint for it", () => {
    render(<ProviderCatalogView {...props()} />);
    openSetup(/^Amazon Bedrock, /);
    expect(
      screen.getByText(/cannot add Amazon Bedrock with your organization's single sign-on yet/),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Open Model endpoints" })).toBeNull();
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
    expect(screen.getByText(/stored in the system keychain, never in the catalog/)).toBeDefined();
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
      "Runs its own agent loop under its own sandbox, which Full access turns off. Octant does not confine it",
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
    expect(document.activeElement?.getAttribute("data-catalog-kind")).toBe("codex");
    openSetup(/^Claude Code, /);
    fireEvent.keyDown(screen.getByRole("heading", { level: 1, name: "Claude Code" }), {
      key: "Escape",
    });
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });
});
