import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RemotePushGatewaySettingsV1 } from "@octant/contracts/remote-push-notifications";
import { describe, expect, it, vi } from "vitest";
import { PhoneNotificationSettings } from "./PhoneNotificationSettings";

const off: RemotePushGatewaySettingsV1 = {
  kind: "remote-push-gateway-settings",
  enabled: false,
  gatewayUrl: "https://push.octant.sh",
  version: 0,
};

function makeClient(current = off) {
  return {
    pushGateway: vi.fn(async () => current),
    setPushGateway: vi.fn(async (input: { enabled: boolean; gatewayUrl: string }) => ({
      ...current,
      enabled: input.enabled,
      gatewayUrl: input.gatewayUrl,
      version: current.version + 1,
    })),
  };
}

describe("PhoneNotificationSettings", () => {
  it("starts off, names the gateway, and turns on from the version it read", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(<PhoneNotificationSettings client={client} />);

    const toggle = await screen.findByRole("switch", { name: "Phone notifications" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/Notifications go through https:\/\/push\.octant\.sh/)).toBeTruthy();

    await user.click(toggle);
    expect(client.setPushGateway).toHaveBeenCalledWith({
      enabled: true,
      gatewayUrl: "https://push.octant.sh",
      expectedVersion: 0,
    });
  });

  it("refuses a plain http gateway off this computer without sending it", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(<PhoneNotificationSettings client={client} />);

    const address = await screen.findByLabelText("Push gateway");
    await user.clear(address);
    await user.type(address, "http://push.example.test");
    await user.click(screen.getByRole("button", { name: "Save address" }));

    expect(await screen.findByText(/must be an https address/)).toBeTruthy();
    expect(client.setPushGateway).not.toHaveBeenCalled();
  });
});
