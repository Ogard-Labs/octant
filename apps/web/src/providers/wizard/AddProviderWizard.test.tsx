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
  it("adds a Claude gateway account, offering this computer's gateway address without applying it", async () => {
    const user = userEvent.setup();
    const onCreateClaude = vi.fn(async () => true);
    wizard({
      onCreateClaude,
      discoverySnapshot: {
        hostId: "local",
        candidates: [{ driverKind: "claude", binaryPath: "/usr/local/bin/claude" }],
        scannedAt: "2026-11-18T00:00:00.000Z",
        scanDurationMs: 1,
        status: "completed",
        claudeHostGateway: {
          baseUrl: "https://gateway.example.com/anthropic",
          tokenVariable: true,
        },
      },
    } as unknown as Partial<AddProviderWizardProps>);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("radio", { name: /Gateway/ }));

    const address = screen.getByLabelText("Gateway address");
    expect(address).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Enter the gateway's address.")).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Use the address from this computer's environment" }),
    );
    expect(address).toHaveValue("https://gateway.example.com/anthropic");
    expect(screen.getByText(/This computer also sets a gateway token/)).toBeVisible();
    await user.type(screen.getByLabelText("Gateway token"), "gateway-token-typed-here");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Add Claude" }));

    expect(onCreateClaude).toHaveBeenCalledTimes(1);
    const [, configuration, credential] = onCreateClaude.mock.calls[0] as unknown as [
      string,
      { readonly authentication: string; readonly gatewayBaseUrl?: string },
      { readonly value: string },
    ];
    expect(configuration).toMatchObject({
      authentication: "gateway",
      gatewayBaseUrl: "https://gateway.example.com/anthropic",
    });
    expect(credential.value).toBe("gateway-token-typed-here");
  });

  it("does not keep an Anthropic API key typed before switching to Gateway as the gateway's token", async () => {
    const user = userEvent.setup();
    wizard();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("radio", { name: /Anthropic API key/ }));
    await user.type(screen.getByLabelText("Anthropic API key"), "sk-ant-meant-for-anthropic");
    await user.click(screen.getByRole("radio", { name: /Gateway/ }));
    expect(screen.getByLabelText("Gateway token")).toHaveValue("");
  });

  it("refuses a public gateway address over plain HTTP before the account is added", async () => {
    const user = userEvent.setup();
    wizard();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("radio", { name: /Gateway/ }));
    expect(
      screen.queryByRole("button", { name: "Use the address from this computer's environment" }),
    ).toBeNull();
    await user.type(screen.getByLabelText("Gateway address"), "http://gateway.example.com");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/A gateway on a public address must use HTTPS/)).toBeVisible();
  });

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
