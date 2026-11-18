import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AddProviderWizard, type AddProviderWizardProps } from "./AddProviderWizard";

function wizard(overrides: Partial<AddProviderWizardProps> = {}) {
  const created = vi.fn(async () => true);
  const props = {
    busy: false,
    credentialManagementAvailable: true,
    instances: [],
    observedByInstance: {},
    probingIds: new Set<string>(),
    onCreate: created,
    onCreateClaude: created,
    onCreateAcpAgent: created,
    onProbe: vi.fn(),
    providerTypes: ["claude", "fx"],
    discoverySnapshot: undefined,
    onClose: vi.fn(),
    ...overrides,
  } as unknown as AddProviderWizardProps;
  return render(<AddProviderWizard {...props} />);
}

describe("AddProviderWizard", () => {
  it("does not carry a key typed for one provider over to another chosen after Back", async () => {
    const user = userEvent.setup();
    wizard();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("radio", { name: /Anthropic API key/ }));
    await user.type(screen.getByLabelText("Anthropic API key"), "sk-ant-meant-for-claude");

    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("radio", { name: /fx/ }));
    await user.click(screen.getByRole("button", { name: "Next" }));

    // fx signs in only with its own key, so a key left in the field would be
    // stored against fx and handed to its runtime.
    expect(screen.getByLabelText("Vercel AI Gateway API key")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Vercel AI Gateway API key is required.")).toBeVisible();
  });
});
