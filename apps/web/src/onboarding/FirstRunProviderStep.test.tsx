import type { ProviderInstance, ProviderInstanceId } from "@octant/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FirstRunProviderStep, type FirstRunProviderStepProps } from "./FirstRunProviderStep";
import { summarizeFirstRunReadiness } from "./firstRunReadinessModel";

const instanceId = "11111111-1111-4111-8111-111111111111" as ProviderInstanceId;
const instance = {
  id: instanceId,
  displayName: "Ollama",
  driverKind: "ollama",
  enabled: true,
} as ProviderInstance;

function mount(overrides: Partial<FirstRunProviderStepProps> = {}) {
  const props: FirstRunProviderStepProps = {
    readiness: summarizeFirstRunReadiness({
      providerStatus: "ready",
      instances: [instance],
      observedByInstance: new Map(),
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
      }),
    });

    expect(screen.getByRole("status")).toHaveTextContent("No provider is configured");
    expect(screen.queryByText(/No provider is ready, so Chat cannot answer yet/)).toBeNull();
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

    await user.click(screen.getByRole("button", { name: "Check this Mac again" }));
    expect(props.onRescan).toHaveBeenCalledOnce();
  });

  it("does not offer a second scan while one is running", () => {
    mount({ scanning: true });

    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
  });
});
