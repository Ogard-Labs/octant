import type {
  CanvasPublicLinkSettings,
  CanvasPublicLinkSettingsResult,
} from "@octant/contracts/canvas-public-share";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PUBLIC_LINK_FACT, PublicLinkSettings } from "./PublicLinkSettings";

function settings(overrides: Record<string, unknown> = {}): CanvasPublicLinkSettings {
  return {
    kind: "canvas-public-link-settings",
    enabled: false,
    serviceUrl: "https://canvas.octant.sh",
    version: 0,
    ...overrides,
  } as unknown as CanvasPublicLinkSettings;
}

function client(
  initial: CanvasPublicLinkSettings,
  answer?: (command: unknown) => CanvasPublicLinkSettingsResult,
) {
  const set = vi.fn(async (command: unknown): Promise<CanvasPublicLinkSettingsResult> => {
    if (answer !== undefined) return answer(command);
    return { kind: "canvas-public-link-settings", settings: initial };
  });
  return {
    set,
    fake: {
      publicLinkSettings: vi.fn(async () => initial),
      setPublicLinkSettings: set as never,
    },
  };
}

describe("PublicLinkSettings", () => {
  it("starts off and says the service can read what is published", async () => {
    const { fake } = client(settings());
    render(<PublicLinkSettings client={fake} />);

    expect(await screen.findByRole("switch", { name: "Public links" })).not.toBeChecked();
    expect(screen.getByText(PUBLIC_LINK_FACT)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Service address" })).toHaveValue(
      "https://canvas.octant.sh",
    );
  });

  it("turns public links on from the version the person read", async () => {
    const user = userEvent.setup();
    const { fake, set } = client(settings({ version: 3 }), () => ({
      kind: "canvas-public-link-settings",
      settings: settings({ enabled: true, version: 4 }),
    }));
    render(<PublicLinkSettings client={fake} />);

    await user.click(await screen.findByRole("switch", { name: "Public links" }));

    expect(set).toHaveBeenCalledWith({
      schemaVersion: 1,
      kind: "set-canvas-public-link-settings",
      enabled: true,
      serviceUrl: "https://canvas.octant.sh",
      expectedVersion: 3,
    });
    await waitFor(() => expect(screen.getByRole("switch", { name: "Public links" })).toBeChecked());
  });

  it("shows the host's refusal inline and leaves the switch where it was", async () => {
    const user = userEvent.setup();
    const { fake } = client(settings(), () => ({
      kind: "canvas-public-link-settings-refused",
      reason: "unauthorized",
      message: "Only the host machine can change this.",
    }));
    render(<PublicLinkSettings client={fake} />);

    await user.click(await screen.findByRole("switch", { name: "Public links" }));

    expect(await screen.findByText("Only the host machine can change this.")).toBeVisible();
    expect(screen.getByRole("switch", { name: "Public links" })).not.toBeChecked();
  });

  it("refuses a service address that is not https before sending anything", async () => {
    const user = userEvent.setup();
    const { fake, set } = client(settings());
    render(<PublicLinkSettings client={fake} />);

    const field = await screen.findByRole("textbox", { name: "Service address" });
    await user.clear(field);
    await user.type(field, "http://example.com");
    await user.click(screen.getByRole("button", { name: "Save address" }));

    expect(set).not.toHaveBeenCalled();
    expect(await screen.findByText(/must be an https address/)).toBeVisible();
  });

  it("saves a self-hosted service address", async () => {
    const user = userEvent.setup();
    const { fake, set } = client(settings(), () => ({
      kind: "canvas-public-link-settings",
      settings: settings({ serviceUrl: "https://links.example.com", version: 1 }),
    }));
    render(<PublicLinkSettings client={fake} />);

    const field = await screen.findByRole("textbox", { name: "Service address" });
    await user.clear(field);
    await user.type(field, "https://links.example.com");
    await user.click(screen.getByRole("button", { name: "Save address" }));

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ serviceUrl: "https://links.example.com", enabled: false }),
    );
  });
});
