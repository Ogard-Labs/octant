import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";
import type { ShellSettings } from "@octant/contracts/shell";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VoiceSettingsView } from "./VoiceSettingsView";

const now = "2026-09-05T10:00:00.000Z";
const compatibleId = "00000000-0000-4000-8000-00000000c001";
const imageId = "00000000-0000-4000-8000-00000000c003";
const groqId = "00000000-0000-4000-8000-00000000c004";

function providerSnapshot(
  options: { readonly enabled?: boolean; readonly withGroq?: boolean } = {},
): ProviderRegistrySnapshot {
  const groq = {
    id: groqId as never,
    displayName: "Groq",
    enabled: true,
    environmentPolicy: "inherit-host" as const,
    version: 1 as never,
    createdAt: now as never,
    updatedAt: now as never,
    driverKind: "openai-compatible" as const,
    configuration: {
      kind: "openai-compatible-http" as const,
      baseUrl: "https://api.groq.com/openai/v1",
      authentication: "bearer" as const,
      protocol: "chat-completions" as const,
      manualModelIds: [],
    },
  };
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
      ...(options.withGroq === true ? [groq] : []),
    ],
    // Groq lists its models; the OpenAI endpoint has not been checked yet, so
    // its preset's known transcription model stands in.
    observedStates:
      options.withGroq === true
        ? [
            {
              instanceId: groqId,
              models: [{ id: "llama-3.3-70b" }, { id: "whisper-large-v3" }],
            } as never,
          ]
        : [],
  };
}

function transcriptionRow(): HTMLElement {
  return screen.getByLabelText("Transcribe with setting");
}

describe("VoiceSettingsView", () => {
  it("explains how to add a provider when no voice endpoint is configured", async () => {
    const onOpenModelEndpoints = vi.fn();
    render(
      <VoiceSettingsView
        onOpenModelEndpoints={onOpenModelEndpoints}
        onSettingsChange={vi.fn()}
        settings={{}}
      />,
    );
    expect(screen.getByText("No endpoint for voice yet")).toBeVisible();
    expect(
      screen.getByText(
        "Voice runs on an OpenAI-compatible endpoint. An OpenAI API or Mistral key can transcribe; add one under Octant Harness › Model endpoints.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Transcribe with" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open Model endpoints" }));
    expect(onOpenModelEndpoints).toHaveBeenCalledOnce();
  });

  it("lists every endpoint that can transcribe and saves the one picked without a save button", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn<(patch: Partial<ShellSettings>) => void>();
    render(
      <VoiceSettingsView
        onSettingsChange={onSettingsChange}
        providerSnapshot={providerSnapshot({ withGroq: true })}
        settings={{}}
      />,
    );
    const menu = screen.getByRole("combobox", { name: "Transcribe with" });
    expect(menu.textContent).toContain("Off");
    expect(within(transcriptionRow()).getByRole("status").textContent).toBe(
      "Transcription is off, so microphone controls stay hidden.",
    );

    await user.click(menu);
    const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(options).toEqual([
      "Off",
      "gpt-4o-mini-transcribe on OpenAI",
      "whisper-large-v3 on Groq",
      "Other model…",
    ]);
    await user.click(screen.getByRole("option", { name: "whisper-large-v3 on Groq" }));

    expect(onSettingsChange).toHaveBeenCalledWith({
      voice: { transcription: { providerInstanceId: groqId, modelId: "whisper-large-v3" } },
    });
    expect(screen.queryByRole("button", { name: /Save transcription/ })).toBeNull();
  });

  it("turning transcription off clears the setting and keeps speech", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn<(patch: Partial<ShellSettings>) => void>();
    const synthesis = {
      providerInstanceId: compatibleId as never,
      modelId: "gpt-4o-mini-tts" as never,
      voice: "coral" as never,
    };
    render(
      <VoiceSettingsView
        onSettingsChange={onSettingsChange}
        providerSnapshot={providerSnapshot()}
        settings={{
          transcription: {
            providerInstanceId: compatibleId as never,
            modelId: "gpt-4o-mini-transcribe" as never,
          },
          synthesis,
        }}
      />,
    );
    const menu = screen.getByRole("combobox", { name: "Transcribe with" });
    expect(menu.textContent).toContain("gpt-4o-mini-transcribe on OpenAI");

    await user.click(menu);
    await user.click(await screen.findByRole("option", { name: "Off" }));
    expect(onSettingsChange).toHaveBeenCalledWith({ voice: { synthesis } });
  });

  it("keeps a typed model id reachable under Other model and names a saved one no endpoint lists", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn<(patch: Partial<ShellSettings>) => void>();
    const { rerender } = render(
      <VoiceSettingsView
        onSettingsChange={onSettingsChange}
        providerSnapshot={providerSnapshot()}
        settings={{}}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "Transcribe with" }));
    await user.click(await screen.findByRole("option", { name: "Other model…" }));

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
    const saved = { providerInstanceId: compatibleId, modelId: "whisper-1" };
    expect(onSettingsChange).toHaveBeenCalledWith({ voice: { transcription: saved } });

    rerender(
      <VoiceSettingsView
        onSettingsChange={onSettingsChange}
        providerSnapshot={providerSnapshot()}
        settings={{ transcription: saved as never }}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Transcribe with" }).textContent).toContain(
      "whisper-1 on OpenAI",
    );
    expect(within(transcriptionRow()).getByRole("status").textContent).toBe(
      "Transcription runs on OpenAI with whisper-1.",
    );
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
    expect(within(transcriptionRow()).getByRole("status").textContent).toBe(
      "Transcription is unavailable: The chosen provider is disabled.",
    );

    await user.click(screen.getByRole("combobox", { name: "Transcribe with" }));
    await user.click(await screen.findByRole("option", { name: "Off" }));
    expect(onSettingsChange).toHaveBeenCalledWith({ voice: {} });
  });

  it("saves the dictation language, and Automatic removes it", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn<(patch: Partial<ShellSettings>) => void>();
    const { rerender } = render(
      <VoiceSettingsView
        onSettingsChange={onSettingsChange}
        providerSnapshot={providerSnapshot()}
        settings={{}}
      />,
    );
    const menu = screen.getByRole("combobox", { name: "Dictation language" });
    expect(menu.textContent).toContain("Automatic");
    await user.click(menu);
    await user.click(await screen.findByRole("option", { name: "Swedish" }));
    expect(onSettingsChange).toHaveBeenLastCalledWith({ voice: { language: "sv" } });

    rerender(
      <VoiceSettingsView
        onSettingsChange={onSettingsChange}
        providerSnapshot={providerSnapshot()}
        settings={{ language: "sv" }}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "Dictation language" }));
    await user.click(await screen.findByRole("option", { name: "Automatic" }));
    expect(onSettingsChange).toHaveBeenLastCalledWith({ voice: {} });
  });

  it("adds comma-separated terms to the dictionary and removes one", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn<(patch: Partial<ShellSettings>) => void>();
    const { rerender } = render(
      <VoiceSettingsView
        onSettingsChange={onSettingsChange}
        providerSnapshot={providerSnapshot()}
        settings={{}}
      />,
    );
    const field = screen.getByRole("textbox", { name: "Words to add" });
    await user.type(field, "Octant, OAuth,octant");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      voice: { dictionary: ["Octant", "OAuth"] },
    });
    expect(field).toHaveValue("");

    rerender(
      <VoiceSettingsView
        onSettingsChange={onSettingsChange}
        providerSnapshot={providerSnapshot()}
        settings={{ dictionary: ["Octant", "OAuth"] }}
      />,
    );
    await user.type(screen.getByRole("textbox", { name: "Words to add" }), "oauth");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert").textContent).toBe(
      "Those terms are already in your dictionary.",
    );

    await user.click(screen.getByRole("button", { name: "Remove OAuth" }));
    expect(onSettingsChange).toHaveBeenLastCalledWith({ voice: { dictionary: ["Octant"] } });
  });
});
