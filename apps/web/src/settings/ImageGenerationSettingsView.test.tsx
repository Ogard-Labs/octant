import type { ImageGenerationSettings } from "@octant/contracts";
import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";
import type { ShellSettings } from "@octant/contracts/shell";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ImageGenerationSettingsView } from "./ImageGenerationSettingsView";

const now = "2026-09-05T10:00:00.000Z";
const compatibleId = "00000000-0000-4000-8000-00000000c001";
const imageId = "00000000-0000-4000-8000-00000000c003";

function providerSnapshot(options: { readonly enabled?: boolean } = {}): ProviderRegistrySnapshot {
  return {
    defaults: { permissionPersistence: "current-session", version: 1 as never },
    instances: [
      {
        id: compatibleId as never,
        displayName: "Recraft",
        enabled: options.enabled ?? true,
        environmentPolicy: "inherit-host",
        version: 1 as never,
        createdAt: now as never,
        updatedAt: now as never,
        driverKind: "openai-compatible",
        configuration: {
          kind: "openai-compatible-http",
          baseUrl: "https://api.recraft.ai/v1",
          authentication: "bearer",
          protocol: "auto",
          manualModelIds: [],
        },
      },
      {
        id: imageId as never,
        displayName: "OpenAI Image",
        enabled: true,
        environmentPolicy: "inherit-host",
        version: 1 as never,
        createdAt: now as never,
        updatedAt: now as never,
        driverKind: "openai-image",
        configuration: {
          kind: "openai-image-http",
          modelAllowlist: ["gpt-image-2" as never],
          defaultModel: "gpt-image-2" as never,
        },
      },
    ],
    observedStates: [],
  };
}

describe("ImageGenerationSettingsView", () => {
  it("explains what is needed when no eligible provider is configured", () => {
    render(
      <ImageGenerationSettingsView
        onSettingsChange={vi.fn()}
        settings={{ customSources: [] }}
      />,
    );
    expect(
      screen.getByText(/Image generation needs an enabled OpenAI-compatible HTTP provider/),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Add image source" })).toBeDisabled();
  });

  it("mentions Recraft as a working example", () => {
    render(
      <ImageGenerationSettingsView
        onSettingsChange={vi.fn()}
        settings={{ customSources: [] }}
      />,
    );
    expect(screen.getByText(/Recraft/)).toBeVisible();
  });

  it("adds a custom image source through one shell settings patch", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn<(patch: Partial<ShellSettings>) => void>();
    render(
      <ImageGenerationSettingsView
        onSettingsChange={onSettingsChange}
        providerSnapshot={providerSnapshot()}
        settings={{ customSources: [] }}
      />,
    );
    const form = screen.getByRole("form", { name: "Add image source" });

    await user.click(within(form).getByRole("button", { name: "Add image source" }));
    expect(within(form).getByRole("alert").textContent).toBe("Enter a label.");
    expect(onSettingsChange).not.toHaveBeenCalled();

    await user.type(within(form).getByRole("textbox", { name: "Image source label" }), "Recraft");
    await user.type(
      within(form).getByRole("textbox", { name: "Image source model" }),
      "recraftv3",
    );
    await user.click(within(form).getByRole("button", { name: "Add image source" }));

    expect(onSettingsChange).toHaveBeenCalledWith({
      imageGeneration: {
        customSources: [
          { providerInstanceId: compatibleId, modelId: "recraftv3", label: "Recraft" },
        ],
      },
    });
  });

  it("rejects a duplicate provider and model pair before calling onSettingsChange", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn<(patch: Partial<ShellSettings>) => void>();
    const settings: ImageGenerationSettings = {
      customSources: [
        { providerInstanceId: compatibleId as never, modelId: "recraftv3" as never, label: "Recraft" },
      ],
    };
    render(
      <ImageGenerationSettingsView
        onSettingsChange={onSettingsChange}
        providerSnapshot={providerSnapshot()}
        settings={settings}
      />,
    );
    const form = screen.getByRole("form", { name: "Add image source" });
    await user.type(within(form).getByRole("textbox", { name: "Image source label" }), "Again");
    await user.type(
      within(form).getByRole("textbox", { name: "Image source model" }),
      "recraftv3",
    );
    await user.click(within(form).getByRole("button", { name: "Add image source" }));

    expect(within(form).getByRole("alert").textContent).toBe(
      "This provider and model is already a custom image source.",
    );
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("removes a custom image source", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn<(patch: Partial<ShellSettings>) => void>();
    const settings: ImageGenerationSettings = {
      customSources: [
        { providerInstanceId: compatibleId as never, modelId: "recraftv3" as never, label: "Recraft" },
      ],
    };
    render(
      <ImageGenerationSettingsView
        onSettingsChange={onSettingsChange}
        providerSnapshot={providerSnapshot()}
        settings={settings}
      />,
    );
    expect(screen.getByText('"Recraft" runs Recraft with recraftv3.')).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(onSettingsChange).toHaveBeenCalledWith({ imageGeneration: { customSources: [] } });
  });

  it("shows an unavailable status for a source whose provider is gone", () => {
    const settings: ImageGenerationSettings = {
      customSources: [
        {
          providerInstanceId: "00000000-0000-4000-8000-00000000cfff" as never,
          modelId: "recraftv3" as never,
          label: "Stale",
        },
      ],
    };
    render(
      <ImageGenerationSettingsView
        onSettingsChange={vi.fn()}
        providerSnapshot={providerSnapshot()}
        settings={settings}
      />,
    );
    expect(
      screen.getByText('"Stale" is unavailable: The chosen provider no longer exists.'),
    ).toBeVisible();
  });
});
