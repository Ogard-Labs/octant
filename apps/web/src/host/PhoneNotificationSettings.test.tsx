import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { HubAdministrationBridge, HubAdministrationOperation } from "../shell/hostBridge";
import { PhoneNotificationSettings } from "./PhoneNotificationSettings";

const off = {
  enabled: false,
  environment: "production",
  ios: "not-stored",
  android: "not-stored",
};

function makeHub(
  responses: Partial<
    Record<HubAdministrationOperation, { readonly status: number; readonly body: unknown }>
  >,
) {
  const calls: Array<{ readonly operation: HubAdministrationOperation; readonly body: unknown }> =
    [];
  const hub: HubAdministrationBridge = {
    hubAdministrationRequest: async (operation, body) => {
      calls.push({ operation, body });
      return (
        responses[operation] ?? {
          status: 200,
          body: { pushSender: off },
        }
      );
    },
  };
  return { hub, calls };
}

describe("PhoneNotificationSettings", () => {
  it("starts off on any host, turns on direct sending, and shows only whether credentials are stored", async () => {
    const user = userEvent.setup();
    const { hub, calls } = makeHub({
      "push-sender-status": { status: 200, body: { pushSender: { ...off, ios: "stored" } } },
      "direct-push": { status: 200, body: { status: "changed" } },
      "direct-push-credential-remove": { status: 200, body: { status: "changed" } },
    });
    render(<PhoneNotificationSettings hub={hub} />);

    const toggle = await screen.findByRole("switch", { name: "Phone notifications" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/^Stored: the \.p8 key/)).toBeTruthy();
    expect(screen.getByText(/^Not stored: the service-account JSON/)).toBeTruthy();

    await user.click(toggle);
    await waitFor(() =>
      expect(calls.find((call) => call.operation === "direct-push")?.body).toEqual({
        enabled: true,
      }),
    );

    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(
        calls.find((call) => call.operation === "direct-push-credential-remove")?.body,
      ).toEqual({ platform: "ios" }),
    );
  });

  it("sends a Google service account once, clears the field before the reply, and shows a refusal plainly", async () => {
    const user = userEvent.setup();
    const { hub, calls } = makeHub({
      "push-sender-status": { status: 200, body: { pushSender: off } },
      "direct-push-credential": {
        status: 409,
        body: { status: "refused", reason: "invalid-credential" },
      },
    });
    render(<PhoneNotificationSettings hub={hub} />);

    const field = await screen.findByLabelText("Service account (JSON)");
    await user.type(field, "bad-account");
    await user.click(screen.getByRole("button", { name: "Store service account" }));

    await waitFor(() =>
      expect(calls.find((call) => call.operation === "direct-push-credential")?.body).toEqual({
        platform: "android",
        serviceAccount: "bad-account",
      }),
    );
    expect((field as HTMLTextAreaElement).value).toBe("");
    expect(await screen.findByText(/not a key Apple or Google issues/)).toBeTruthy();
  });

  it("shows a host-only note when opened from a paired browser without the local desktop bridge", () => {
    render(<PhoneNotificationSettings />);
    expect(screen.getByText(/set up on the host machine/i)).toBeTruthy();
  });
});
