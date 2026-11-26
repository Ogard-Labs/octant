import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";
import type { ShellSettings } from "@octant/contracts/shell";
import type { SpeechLocalEngineStatus, VoiceSettings } from "@octant/contracts";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SpeechCapabilityProvider } from "../voice/SpeechCapabilityContext";
import { fakeSpeechClient } from "../voice/speechTestSupport";
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

describe("Apple Speech in Voice settings", () => {
  const endpoint = {
    providerInstanceId: compatibleId as never,
    modelId: "gpt-4o-mini-transcribe" as never,
  };

  async function show(
    settings: VoiceSettings,
    engine: SpeechLocalEngineStatus,
    options: { readonly withEndpoint?: boolean } = {},
  ) {
    const onSettingsChange = vi.fn<(patch: Partial<ShellSettings>) => void>();
    const localEngine = vi.fn(async () => engine);
    const downloadLocalModel = vi.fn(
      async (): Promise<SpeechLocalEngineStatus> => ({
        status: "downloading",
        language: "fr-FR" as never,
        fraction: 0,
      }),
    );
    const status = vi.fn(async () => {
      throw new Error("not under test");
    });
    render(
      <SpeechCapabilityProvider
        client={{ ...fakeSpeechClient().client, status, localEngine, downloadLocalModel }}
        instances={[]}
        settings={settings}
      >
        <VoiceSettingsView
          onSettingsChange={onSettingsChange}
          settings={settings}
          {...(options.withEndpoint === false ? {} : { providerSnapshot: providerSnapshot() })}
        />
      </SpeechCapabilityProvider>,
    );
    await act(async () => undefined);
    return { onSettingsChange, localEngine, downloadLocalModel, status };
  }

  const pick = async (name: string) => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Transcribe with" }));
    await user.click(await screen.findByRole("option", { name }));
  };
  const said = () => within(transcriptionRow()).getByRole("status").textContent;

  it("is offered beside the endpoints and keeps the saved one when it is picked", async () => {
    const { onSettingsChange, downloadLocalModel } = await show(
      { transcription: endpoint, language: "no" },
      { status: "ready", language: "nb-NO" as never },
    );
    await pick("Apple Speech on this Mac");
    expect(onSettingsChange).toHaveBeenCalledWith({
      voice: { transcription: endpoint, language: "no", transcriptionEngine: "apple-speech" },
    });
    expect(downloadLocalModel).not.toHaveBeenCalled();
  });

  it("is offered to a person with no endpoint at all", async () => {
    const { onSettingsChange } = await show(
      {},
      { status: "ready", language: "nb-NO" as never },
      { withEndpoint: false },
    );
    await pick("Apple Speech on this Mac");
    expect(onSettingsChange).toHaveBeenCalledWith({
      voice: { transcriptionEngine: "apple-speech" },
    });
    expect(screen.getByText("No endpoint for reading aloud yet")).toBeVisible();
  });

  it("is not offered where it cannot run", async () => {
    await show(
      { transcription: endpoint },
      { status: "unsupported", reason: "Apple Speech needs a Mac with macOS 26 or later." },
    );
    await userEvent.click(screen.getByRole("combobox", { name: "Transcribe with" }));
    expect(
      (await screen.findAllByRole("option")).map((option) => option.textContent),
    ).not.toContain("Apple Speech on this Mac");
  });

  it("says it is checking until the host answers, not that it failed", async () => {
    const onSettingsChange = vi.fn();
    const client = {
      ...fakeSpeechClient().client,
      status: () => new Promise<never>(() => undefined),
      localEngine: () => new Promise<never>(() => undefined),
    };
    render(
      <SpeechCapabilityProvider
        client={client}
        instances={[]}
        settings={{ transcriptionEngine: "apple-speech" }}
      >
        <VoiceSettingsView
          onSettingsChange={onSettingsChange}
          settings={{ transcriptionEngine: "apple-speech" }}
        />
      </SpeechCapabilityProvider>,
    );
    expect(said()).toBe("Checking Apple Speech on this Mac…");
  });

  it("says why it cannot run where settings already name it", async () => {
    await show(
      { transcriptionEngine: "apple-speech" },
      { status: "unsupported", reason: "Apple Speech needs a Mac with macOS 26 or later." },
    );
    expect(said()).toBe("Apple Speech needs a Mac with macOS 26 or later.");
  });

  it("says speech stays on the Mac, and who cannot dictate meanwhile", async () => {
    await show(
      { transcription: endpoint, transcriptionEngine: "apple-speech", language: "no" },
      { status: "ready", language: "nb-NO" as never },
    );
    expect(said()).toMatch(/Norwegian/);
    expect(said()).toMatch(/no recording leaves it/);
    expect(said()).toMatch(/Paired phones and browsers/);
  });

  it("goes back to the saved endpoint, or off, on request", async () => {
    const settings = { transcription: endpoint, transcriptionEngine: "apple-speech" as const };
    const { onSettingsChange } = await show(settings, {
      status: "ready",
      language: "nb-NO" as never,
    });
    await pick("gpt-4o-mini-transcribe on OpenAI");
    expect(onSettingsChange).toHaveBeenLastCalledWith({ voice: { transcription: endpoint } });
    await pick("Off");
    expect(onSettingsChange).toHaveBeenLastCalledWith({ voice: {} });
  });

  it("goes back to a saved model no endpoint lists", async () => {
    const typed = { ...endpoint, modelId: "my-whisper" as never };
    const { onSettingsChange } = await show(
      { transcription: typed, transcriptionEngine: "apple-speech" },
      { status: "ready", language: "nb-NO" as never },
    );
    await pick("my-whisper on OpenAI");
    expect(onSettingsChange).toHaveBeenLastCalledWith({ voice: { transcription: typed } });
  });

  it("downloads the model only when asked, and shows how far it has come", async () => {
    const { localEngine, downloadLocalModel } = await show(
      { transcriptionEngine: "apple-speech", language: "fr" },
      { status: "not-downloaded", language: "fr-FR" as never },
    );
    expect(said()).toMatch(/French.*not on this Mac/);
    expect(said()).toMatch(/from Apple/);
    expect(downloadLocalModel).not.toHaveBeenCalled();
    localEngine.mockResolvedValue({
      status: "downloading",
      language: "fr-FR" as never,
      fraction: 0.42,
    });
    await userEvent.click(screen.getByRole("button", { name: "Download model" }));
    expect(downloadLocalModel).toHaveBeenCalledWith("fr");
    expect(screen.queryByRole("button", { name: "Download model" })).toBeNull();
    expect(await screen.findByText(/42%/, {}, { timeout: 3_000 })).toBeVisible();
  });

  it("tells the composers once the model has arrived", async () => {
    const { localEngine, status } = await show(
      { transcriptionEngine: "apple-speech", language: "fr" },
      { status: "downloading", language: "fr-FR" as never, fraction: 0.9 },
    );
    const before = status.mock.calls.length;
    localEngine.mockResolvedValue({ status: "ready", language: "fr-FR" as never });
    expect(await screen.findByText(/no recording leaves it/, {}, { timeout: 3_000 })).toBeVisible();
    expect(status.mock.calls.length).toBeGreaterThan(before);
  });

  it("says a download failed and offers it again", async () => {
    const { downloadLocalModel } = await show(
      { transcriptionEngine: "apple-speech" },
      { status: "download-failed", language: "nb-NO" as never },
    );
    expect(said()).toMatch(/could not be downloaded/);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(downloadLocalModel).toHaveBeenCalledWith(undefined);
  });

  it("names the language problem without offering a download", async () => {
    await show(
      { transcriptionEngine: "apple-speech", language: "uk" },
      { status: "unsupported-language" },
    );
    expect(said()).toMatch(/no on-device model/);
    expect(screen.queryByRole("button", { name: "Download model" })).toBeNull();
  });
});
