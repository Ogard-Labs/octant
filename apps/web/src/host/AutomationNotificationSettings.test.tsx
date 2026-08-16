import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AutomationNotificationDeliveryStatus } from "@octant/contracts";
import type { AutomationNotificationClient } from "@octant/client-runtime/automation-notification-client";
import { AutomationNotificationSettings } from "./AutomationNotificationSettings";

const status = (
  overrides: Partial<AutomationNotificationDeliveryStatus> = {},
): AutomationNotificationDeliveryStatus =>
  ({
    preferences: {
      enabled: false,
      waiting: true,
      approvalNeeded: true,
      failure: true,
      completion: true,
      version: 0,
      updatedAt: "2026-08-11T12:00:00.000Z",
    },
    providerDelivery: "unavailable",
    registeredDestinationCount: 0,
    deliveryEnabled: false,
    ...overrides,
  }) as AutomationNotificationDeliveryStatus;

function makeClient(
  current: AutomationNotificationDeliveryStatus = status(),
): AutomationNotificationClient {
  return {
    preferences: vi.fn(async () => current.preferences),
    status: vi.fn(async () => current),
    deliveries: vi.fn(async () => ({ status: current, receipts: [] })),
    update: vi.fn(
      async (input) =>
        ({
          ...current.preferences,
          enabled: input.enabled,
          version: (current.preferences.version + 1) as never,
          updatedAt: "2026-08-11T12:01:00.000Z" as never,
        }) as AutomationNotificationDeliveryStatus["preferences"],
    ),
  };
}

describe("AutomationNotificationSettings", () => {
  it("shows honest unavailable provider delivery and opt-in control", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(<AutomationNotificationSettings client={client} />);
    expect(await screen.findByRole("button", { name: /Enable notifications/i })).toBeTruthy();
    expect(screen.getByText(/Credentialed APNs\/FCM delivery is unavailable/i)).toBeTruthy();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(1);
    await user.click(screen.getByRole("button", { name: /Enable notifications/i }));
    expect(client.update).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, expectedVersion: 0 }),
    );
  });
});
