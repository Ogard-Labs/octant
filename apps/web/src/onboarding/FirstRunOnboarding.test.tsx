import type { ProviderInstance, ProviderInstanceId } from "@octant/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FirstRunOnboarding, type FirstRunOnboardingProps } from "./FirstRunOnboarding";
import { summarizeFirstRunReadiness } from "./firstRunReadinessModel";
import {
  useFirstRunOnboardingController,
  type FirstRunOnboardingController,
} from "./useFirstRunOnboardingController";

const instanceId = "11111111-1111-4111-8111-111111111111" as ProviderInstanceId;
const instance = {
  id: instanceId,
  displayName: "Ollama",
  driverKind: "ollama",
  enabled: true,
} as ProviderInstance;

function controller(
  overrides: Partial<FirstRunOnboardingController> = {},
): FirstRunOnboardingController {
  return {
    visible: true,
    submitting: undefined,
    blockedMessage: undefined,
    complete: vi.fn(),
    skip: vi.fn(),
    defer: vi.fn(),
    ...overrides,
  };
}

function readinessFixture() {
  return summarizeFirstRunReadiness({
    providerStatus: "ready",
    instances: [instance],
    observedByInstance: new Map(),
  });
}

function mount(overrides: Partial<FirstRunOnboardingProps> = {}) {
  const props: FirstRunOnboardingProps = {
    controller: controller(),
    readiness: readinessFixture(),
    onOpenProviderSettings: vi.fn(),
    onRescan: vi.fn(),
    scanning: false,
    ...overrides,
  };
  render(<FirstRunOnboarding {...props} />);
  return props;
}

describe("FirstRunOnboarding", () => {
  it("stays out of the way once the host has recorded an answer", () => {
    mount({ controller: controller({ visible: false }) });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("states each provider's status in words and never implies an unverified provider works", () => {
    mount();

    expect(screen.getByRole("dialog", { name: "Welcome to Octant" })).toBeVisible();
    const providers = within(screen.getByRole("list"));
    expect(providers.getByText("Ollama")).toBeVisible();
    expect(providers.getByText("Not checked")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("No provider is ready yet");
    expect(screen.getByText(/No provider is ready, so Chat cannot answer yet/)).toBeVisible();
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
    expect(screen.getByText(/No provider is ready, so Chat cannot answer yet/)).toBeVisible();
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

  it("drives setup, completion, and skipping from the keyboard", async () => {
    const user = userEvent.setup();
    const props = mount();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Set up a provider" })).toHaveFocus(),
    );
    await user.keyboard("{Enter}");
    expect(props.onOpenProviderSettings).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Check this Mac again" }));
    expect(props.onRescan).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Continue to Chat" }));
    expect(props.controller.complete).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(props.controller.skip).toHaveBeenCalledOnce();
  });

  it("releases the modal when it sends the user to provider settings", async () => {
    const user = userEvent.setup();
    const onOpenProviderSettings = vi.fn();
    const resolve = vi.fn(async () => {});

    function Harness() {
      const live = useFirstRunOnboardingController({
        onboarding: "pending",
        shellStatus: "ready",
        resolve,
      });
      return (
        <FirstRunOnboarding
          controller={live}
          onOpenProviderSettings={onOpenProviderSettings}
          onRescan={vi.fn()}
          readiness={readinessFixture()}
          scanning={false}
        />
      );
    }
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Set up a provider" }));

    expect(onOpenProviderSettings).toHaveBeenCalledOnce();
    // The dialog is modal, so leaving it open traps focus over the provider
    // settings this very action opened.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Deferring answers nothing on the user's behalf: the host still reports
    // first run as pending, so backing out of Settings does not lose it.
    expect(resolve).not.toHaveBeenCalled();
    // Focus is released to a live element rather than stranded on the removed
    // dialog (`SHELL-03`).
    expect(document.activeElement?.isConnected).toBe(true);
  });

  it("records the same durable skip when the dialog is dismissed", async () => {
    const user = userEvent.setup();
    const props = mount();

    await user.keyboard("{Escape}");

    expect(props.controller.skip).toHaveBeenCalledOnce();
  });

  it("blocks answering while the host cannot record it and says so", () => {
    mount({
      controller: controller({ blockedMessage: "Octant cannot reach the host right now." }),
    });

    expect(screen.getByRole("alert")).toHaveTextContent("cannot reach the host");
    expect(screen.getByRole("button", { name: "Continue to Chat" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeDisabled();
  });

  it("shows which answer is in flight without offering a second one", () => {
    mount({ controller: controller({ submitting: "completed" }) });

    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeDisabled();
  });
});
