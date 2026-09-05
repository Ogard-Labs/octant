import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";
import type { ShellSettings } from "@octant/contracts/shell";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VoiceSettingsView } from "./VoiceSettingsView";

const now = "2026-09-05T10:00:00.000Z";
const compatibleId = "00000000-0000-4000-8000-00000000c001";
const imageId = "00000000-0000-4000-8000-00000000c003";

function providerSnapshot(options: { readonly enabled?: boolean } = {}): ProviderRegistrySnapshot {
  return {
    defaults: { permissionPersistence: "current-session", version: 1 as never },
    instances: [
      {
        id: compatibleId as never,
        displayName: "OpenAI",
        enabled: options.enabled ?? true,
        environmentPolicy: "inherit-host",
        version: 1 as never,
        createdAt: now as never,
        updatedAt: now as never,
        driverKind: "openai-compatible",
        configuration: {
          kind: "openai-compatible-http",
          baseUrl: "https://api.openai.com/v1",
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

describe("VoiceSettingsView", () => {
  it("offers only OpenAI-compatible providers and explains when none is enabled", () => {
    render(<VoiceSettingsView onSettingsChange={vi.fn()} settings={{}} />);
    expect(
      screen.getByText(/Voice needs an enabled OpenAI-compatible HTTP provider/),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Save transcription endpoint" })).toBeDisabled();
  });

  it("persists a transcription endpoint through one shell settings patch", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn<(patch: Partial<ShellSettings>) => void>();
    render(
      <VoiceSettingsView
        onSettingsChange={onSettingsChange}
        providerSnapshot={providerSnapshot()}
        settings={{}}
      />,
    );
    const form = screen.getByRole("form", { name: "Transcription endpoint" });
    expect(within(form).queryByText("OpenAI Image")).toBeNull();

    await user.click(within(form).getByRole("button", { name: "Save transcription endpoint" }));
    expect(within(form).getByRole("alert").textContent).toBe("Enter a model ID.");
    expect(onSettingsChange).not.toHaveBeenCalled();

    await user.type(
      within(form).getByRole("textbox", { name: "Transcription model" }),
      "whisper-1",
    );
    await user.click(within(form).getByRole("button", { name: "Save transcription endpoint" }));

    expect(onSettingsChange).toHaveBeenCalledWith({
      voice: {
        transcription: { providerInstanceId: compatibleId, modelId: "whisper-1" },
      },
    });
  });

  it("requires a voice for speech and keeps the other direction untouched", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn<(patch: Partial<ShellSettings>) => void>();
    const transcription = {
      providerInstanceId: compatibleId as never,
      modelId: "whisper-1" as never,
    };
    render(
      <VoiceSettingsView
        onSettingsChange={onSettingsChange}
        providerSnapshot={providerSnapshot()}
        settings={{ transcription }}
      />,
    );
    const form = screen.getByRole("form", { name: "Speech endpoint" });
    await user.type(within(form).getByRole("textbox", { name: "Speech model" }), "gpt-4o-mini-tts");
    await user.click(within(form).getByRole("button", { name: "Save speech endpoint" }));
    expect(within(form).getByRole("alert").textContent).toBe("Enter a voice.");

    await user.type(within(form).getByRole("textbox", { name: "Speech voice" }), "coral");
    await user.click(within(form).getByRole("button", { name: "Save speech endpoint" }));

    expect(onSettingsChange).toHaveBeenCalledWith({
      voice: {
        transcription,
        synthesis: { providerInstanceId: compatibleId, modelId: "gpt-4o-mini-tts", voice: "coral" },
      },
    });
  });

  it("shows what the host will do, including a chosen provider that is now disabled", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn<(patch: Partial<ShellSettings>) => void>();
    const transcription = {
      providerInstanceId: compatibleId as never,
      modelId: "whisper-1" as never,
    };
    render(
      <VoiceSettingsView
        onSettingsChange={onSettingsChange}
        providerSnapshot={providerSnapshot({ enabled: false })}
        settings={{ transcription }}
      />,
    );
    const form = screen.getByRole("form", { name: "Transcription endpoint" });
    expect(within(form).getByRole("status").textContent).toBe(
      "Transcription is unavailable: The chosen provider is disabled.",
    );

    await user.click(within(form).getByRole("button", { name: "Clear transcription endpoint" }));
    expect(onSettingsChange).toHaveBeenCalledWith({ voice: {} });
  });
});
