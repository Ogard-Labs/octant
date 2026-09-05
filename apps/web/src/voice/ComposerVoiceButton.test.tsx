import { SpeechClientFailure } from "@octant/client-runtime/speech-client";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerVoiceButton } from "./ComposerVoiceButton";
import { SpeechCapabilityProvider } from "./SpeechCapabilityContext";
import {
  fakeSpeechClient,
  FakeMediaRecorder,
  installFakeMicrophone,
  speechTestInstances,
  speechTestSettings,
  uninstallFakeMicrophone,
} from "./speechTestSupport";

afterEach(() => {
  uninstallFakeMicrophone();
});

function renderButton(options: {
  readonly client: ReturnType<typeof fakeSpeechClient>["client"] | undefined;
  readonly configured?: boolean;
  readonly onTranscript?: (transcript: string) => void;
}) {
  const onTranscript = options.onTranscript ?? vi.fn();
  render(
    <SpeechCapabilityProvider
      client={options.client}
      instances={speechTestInstances()}
      settings={options.configured === false ? {} : speechTestSettings()}
    >
      <ComposerVoiceButton onTranscript={onTranscript} />
    </SpeechCapabilityProvider>,
  );
  return { onTranscript };
}

describe("ComposerVoiceButton", () => {
  it("renders nothing until transcription is configured and the browser can record", () => {
    installFakeMicrophone();
    const { client } = fakeSpeechClient();
    renderButton({ client, configured: false });
    expect(screen.queryByRole("button", { name: "Dictate message" })).toBeNull();

    uninstallFakeMicrophone();
    renderButton({ client });
    expect(screen.queryByRole("button", { name: "Dictate message" })).toBeNull();
  });

  it("records, sends the clip for transcription, and hands the text back without sending", async () => {
    const user = userEvent.setup();
    const { stopTrack } = installFakeMicrophone();
    const { client, transcribe } = fakeSpeechClient({ transcript: "  buy milk  " });
    const onTranscript = vi.fn();
    renderButton({ client, onTranscript });

    await user.click(screen.getByRole("button", { name: "Dictate message" }));
    const stop = await screen.findByRole("button", { name: "Stop dictating" });
    expect(stop).toHaveAttribute("aria-pressed", "true");
    expect(FakeMediaRecorder.instances[0]?.state).toBe("recording");

    await user.click(stop);

    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("  buy milk  "));
    expect(transcribe).toHaveBeenCalledTimes(1);
    const sent = (transcribe.mock.calls[0] as unknown as [{ audio: Blob }])[0];
    expect(sent.audio.size).toBe(5);
    expect(stopTrack).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Dictate message" })).toBeEnabled();
  });

  it("shows the host's refusal instead of a transcript, and a denied microphone by name", async () => {
    const user = userEvent.setup();
    installFakeMicrophone();
    const { client } = fakeSpeechClient({
      transcribeFailure: new SpeechClientFailure({
        message: "The provider rate limit was reached.",
        status: 429,
        category: "rate-limited",
      }),
    });
    const onTranscript = vi.fn();
    renderButton({ client, onTranscript });

    await user.click(screen.getByRole("button", { name: "Dictate message" }));
    await user.click(await screen.findByRole("button", { name: "Stop dictating" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The provider rate limit was reached.",
    );
    expect(onTranscript).not.toHaveBeenCalled();

    uninstallFakeMicrophone();
    installFakeMicrophone({ deny: true });
    renderButton({ client: fakeSpeechClient().client });
    await user.click(screen.getAllByRole("button", { name: "Dictate message" })[1]!);
    expect(await screen.findByText("Microphone access was not allowed.")).toBeVisible();
  });
});
