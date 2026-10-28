import type { DiscoverySnapshot, ProviderInstance, ProviderInstanceId } from "@octant/contracts";
import { render, screen, within } from "@testing-library/react";
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
} as ProviderInstance;

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

describe("FirstRunProviderStep", () => {
  it("says first run enables a detected Claude Code or Codex CLI and leaves other CLIs off", () => {
    mount();

    expect(screen.getByText(/If Claude Code or Codex CLI is already installed/)).toBeVisible();
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
