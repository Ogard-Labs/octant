import type {
  DiscoverySnapshot,
  ProviderInstance,
  ProviderInstanceId,
  ProviderObservedState,
} from "@octant/contracts";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostPlatformContext } from "../platform";
import { FirstRunProviderStep, type FirstRunProviderStepProps } from "./FirstRunProviderStep";
import { summarizeFirstRunReadiness } from "./firstRunReadinessModel";

const instanceId = "11111111-1111-4111-8111-111111111111" as ProviderInstanceId;
const instance = {
  id: instanceId,
  displayName: "Ollama",
  driverKind: "ollama",
  enabled: true,
  configuration: {},
} as unknown as ProviderInstance;

// A scan that ran to completion: only then may the surface claim the host has
// no provider on it.
const searchedThisMac = {
  scanning: false,
  snapshot: { status: "completed", candidates: [] } as unknown as DiscoverySnapshot,
} as const;

function mount(overrides: Partial<FirstRunProviderStepProps> = {}) {
  const props: FirstRunProviderStepProps = {
    readiness: summarizeFirstRunReadiness({
      providerStatus: "ready",
      instances: [instance],
      observedByInstance: new Map(),
      discovery: searchedThisMac,
    }),
    onOpenProviderSettings: vi.fn(),
    onRescan: vi.fn(),
    scanning: false,
    ...overrides,
  };
  render(<FirstRunProviderStep {...props} />);
  return props;
}

const AT = "2026-08-15T10:00:00.000Z";

/** A command-line provider as the host records one, found or not by the scan. */
function cli(index: number, displayName: string, enabled: boolean): ProviderInstance {
  return {
    id: `00000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}` as ProviderInstanceId,
    displayName,
    driverKind: `driver-${String(index)}`,
    enabled,
    configuration: { binaryPath: `/opt/bin/tool-${String(index)}` },
  } as unknown as ProviderInstance;
}

/** A finished scan that searched every provider's folder and found the named ones. */
function readinessFor(
  instances: ReadonlyArray<ProviderInstance>,
  found: ReadonlyArray<ProviderInstance>,
  ready: ReadonlyArray<ProviderInstance>,
) {
  return summarizeFirstRunReadiness({
    providerStatus: "ready",
    instances,
    observedByInstance: new Map(
      ready.map((provider) => [
        provider.id,
        {
          instanceId: provider.id,
          readiness: "ready",
          processState: "running",
          models: [{ id: "model", displayName: "Model" }],
          capabilities: {},
          observedAt: AT,
        } as unknown as ProviderObservedState,
      ]),
    ),
    discovery: {
      scanning: false,
      snapshot: {
        status: "completed",
        candidates: found.map((provider) => ({
          driverKind: provider.driverKind,
          binaryPath: `/opt/bin/tool-${provider.driverKind.slice("driver-".length)}`,
        })),
        searchedDirectories: instances.map((provider) => ({
          driverKind: provider.driverKind,
          directories: ["/opt/bin"],
        })),
      } as unknown as DiscoverySnapshot,
    },
  });
}

// Registry order puts the providers that work last, as a host that recorded
// them in scan order can.
const missing = [3, 4, 5, 6, 7, 8].map((index) => cli(index, `Tool ${String(index)}`, false));
const installedOff = [cli(2, "OpenCode", false), cli(9, "Pi", false)];
const claude = cli(1, "Claude Code", true);
const many = [...missing, ...installedOff, claude];
const manyReadiness = readinessFor(many, [claude, ...installedOff], [claude]);

function rows() {
  return within(screen.getByRole("list")).getAllByRole("listitem");
}

/** A row as it reads: the glyph is decoration, hidden from assistive technology. */
function reading(element: Element | null | undefined) {
  const copy = element?.cloneNode(true) as Element | undefined;
  for (const hidden of copy?.querySelectorAll('[aria-hidden="true"]') ?? []) hidden.remove();
  return copy?.textContent;
}

function rowNames() {
  return rows().map((row) => reading(row.querySelector(".setrow-label")));
}

describe("FirstRunProviderStep", () => {
  it("the provider step names the ready provider and lists it first", () => {
    mount({ readiness: manyReadiness });

    expect(screen.getByRole("status")).toHaveTextContent("Claude Code is ready");
    expect(rowNames().slice(0, 3)).toEqual(["Claude Code", "OpenCode", "Pi"]);
  });

  it("names every ready provider in the summary", () => {
    const codex = cli(2, "Codex", true);
    mount({ readiness: readinessFor([claude, codex], [claude, codex], [claude, codex]) });

    expect(screen.getByRole("status")).toHaveTextContent(
      "2 providers are ready: Claude Code and Codex",
    );
  });

  it("a row says its state once, and the switch carries it in its name", () => {
    mount({ readiness: manyReadiness, onSetProviderEnabled: vi.fn() });

    expect(rows().slice(0, 4).map(reading)).toEqual([
      "Claude CodeReady",
      "OpenCodeInstalled · off",
      "PiInstalled · off",
      "Tool 3Not installed",
    ]);
    expect(screen.getByRole("switch", { name: "Enable Claude Code, Ready" })).toBeChecked();
    expect(
      screen.getByRole("switch", { name: "Enable OpenCode, Installed · off" }),
    ).not.toBeChecked();
    expect(document.body.textContent).not.toMatch(/Disabled|Enabled|Turned off for this host/);
  });

  it("providers past the first five fold behind Show N more", async () => {
    const user = userEvent.setup();
    mount({ readiness: manyReadiness });

    expect(rowNames()).toEqual(["Claude Code", "OpenCode", "Pi", "Tool 3", "Tool 4"]);
    const more = screen.getByRole("button", { name: "Show 4 more" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await user.click(more);

    expect(rowNames()).toHaveLength(9);
    expect(screen.getByRole("button", { name: "Show fewer" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("keeps rows where they are once the person has used a switch", async () => {
    const user = userEvent.setup();
    const onSetProviderEnabled = vi.fn();
    const props: FirstRunProviderStepProps = {
      readiness: manyReadiness,
      onOpenProviderSettings: vi.fn(),
      onRescan: vi.fn(),
      onSetProviderEnabled,
      scanning: false,
    };
    const view = render(<FirstRunProviderStep {...props} />);

    await user.click(screen.getByRole("switch", { name: "Enable OpenCode, Installed · off" }));
    // The host answers: OpenCode is on and not yet checked, which on a fresh
    // list would sort it behind the providers that are only turned off.
    const enabled = many.map((provider) =>
      provider.displayName === "OpenCode" ? { ...provider, enabled: true } : provider,
    );
    view.rerender(
      <FirstRunProviderStep
        {...props}
        readiness={readinessFor(enabled, [claude, ...installedOff], [claude])}
      />,
    );

    expect(rowNames().slice(0, 3)).toEqual(["Claude Code", "OpenCode", "Pi"]);
    expect(screen.getByRole("switch", { name: "Enable OpenCode, Not checked" })).toHaveFocus();
  });

  it("opens with one sentence and keeps what first run enables behind More", () => {
    mount();

    expect(
      screen.getByText(
        "Choose the AI providers Octant uses. You can change this later in Settings.",
      ),
    ).toBeVisible();
    expect(screen.getByText(/If Claude Code or Codex is already installed/)).not.toBeVisible();
    fireEvent.click(screen.getByText("More"));

    expect(screen.getByText(/If Claude Code or Codex is already installed/)).toBeVisible();
    expect(screen.getByText(/you can turn it off later/)).toBeVisible();
    expect(screen.getByText(/Other detected CLIs stay off until you enable them/)).toBeVisible();
  });

  it("states each provider's status in words and never implies an unverified provider works", () => {
    mount();

    const providers = within(screen.getByRole("list"));
    expect(providers.getByText("Ollama")).toBeVisible();
    expect(providers.getByText("Not checked")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("No provider is ready yet");
    expect(screen.queryByText(/No provider is ready, so Chat cannot answer yet/)).toBeNull();
  });

  it("reports an unreachable registry without claiming anything is ready", () => {
    mount({
      readiness: summarizeFirstRunReadiness({
        providerStatus: "disconnected",
        instances: [],
        observedByInstance: new Map(),
        discovery: searchedThisMac,
      }),
    });

    expect(screen.getByRole("status")).toHaveTextContent("Provider readiness is unavailable");
    expect(screen.getByRole("status")).toHaveTextContent("Nothing is assumed ready.");
    // An unreachable registry is an unknown, not a negative: claiming no
    // provider is ready would contradict the status directly above (`BOOT-02`).
    expect(screen.queryByText(/Chat cannot answer yet/)).toBeNull();
    expect(screen.getByRole("note")).toHaveTextContent(
      /cannot reach its own provider registry, so it cannot say whether Chat can answer/,
    );
  });

  it("says readiness is still unknown rather than unavailable while the host is checking", () => {
    mount({
      readiness: summarizeFirstRunReadiness({
        providerStatus: "loading",
        instances: [instance],
        observedByInstance: new Map(),
        discovery: searchedThisMac,
      }),
    });

    expect(screen.getByRole("status")).toHaveTextContent("Checking provider readiness");
    expect(screen.queryByText(/Chat cannot answer yet/)).toBeNull();
    expect(screen.getByRole("note")).toHaveTextContent(/still checking/);
  });

  it("still says Chat cannot answer when no provider is configured", () => {
    mount({
      readiness: summarizeFirstRunReadiness({
        providerStatus: "ready",
        instances: [],
        observedByInstance: new Map(),
        discovery: searchedThisMac,
      }),
    });

    expect(screen.getByRole("status")).toHaveTextContent("No provider is configured");
    expect(screen.queryByText(/No provider is ready, so Chat cannot answer yet/)).toBeNull();
  });

  it("does not tell a first-run user nothing is configured while the host is still being scanned", () => {
    mount({
      readiness: summarizeFirstRunReadiness({
        providerStatus: "ready",
        instances: [],
        observedByInstance: new Map(),
        discovery: { scanning: true },
      }),
      scanning: true,
    });

    const status = screen.getByRole("status");
    // No host platform is known here, so the copy uses the neutral name.
    expect(status).toHaveTextContent("Octant has not finished checking this computer");
    expect(status).not.toHaveTextContent("No provider is configured");
    expect(status).toHaveAttribute("data-overall", "checking");
  });

  it("surfaces an incomplete scan as an actionable alert", () => {
    mount({
      discoveryNotice: {
        tone: "attention",
        message: "The scan for installed providers was cancelled.",
        retryable: true,
      },
    });

    expect(screen.getByRole("alert")).toHaveTextContent("was cancelled");
  });

  it("offers setup and a rescan", async () => {
    const user = userEvent.setup();
    const props = mount();

    await user.click(screen.getByRole("button", { name: "Set up a provider" }));
    expect(props.onOpenProviderSettings).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Check this computer again" }));
    expect(props.onRescan).toHaveBeenCalledOnce();
  });

  it("does not offer a second scan while one is running", () => {
    mount({ scanning: true });

    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
  });
});

// Each host is seen from a window on the other platform, so copy that read the
// window's platform instead of the host's would name the wrong computer.
const HOSTS = [
  { hostPlatform: "linux", window: "MacIntel", computer: "this computer", elsewhere: /this Mac/ },
  {
    hostPlatform: "darwin",
    window: "Linux x86_64",
    computer: "this Mac",
    elsewhere: /this computer/,
  },
] as const;

describe.each(HOSTS)("FirstRunProviderStep on a $hostPlatform host", (host) => {
  beforeEach(() => {
    Object.defineProperty(window.navigator, "platform", { value: host.window, configurable: true });
  });
  afterEach(() => Reflect.deleteProperty(window.navigator, "platform"));

  it("says Octant runs on the host's computer and offers to check that computer again", () => {
    render(
      <HostPlatformContext.Provider value={host.hostPlatform}>
        <FirstRunProviderStep
          onOpenProviderSettings={vi.fn()}
          onRescan={vi.fn()}
          readiness={summarizeFirstRunReadiness({
            providerStatus: "ready",
            instances: [],
            observedByInstance: new Map(),
            discovery: { scanning: false },
            hostPlatform: host.hostPlatform,
          })}
          scanning={false}
        />
      </HostPlatformContext.Provider>,
    );

    expect(screen.getByText(/^Octant runs on/)).toHaveTextContent(
      `Octant runs on ${host.computer} and talks to the AI providers you choose.`,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      `Octant has not finished checking ${host.computer}`,
    );
    expect(screen.getByRole("button", { name: `Check ${host.computer} again` })).toBeVisible();
    expect(document.body.textContent).not.toMatch(host.elsewhere);
  });
});
