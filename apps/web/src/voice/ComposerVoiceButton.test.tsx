import { SpeechClientFailure } from "@octant/client-runtime/speech-client";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerVoiceButton } from "./ComposerVoiceButton";
import { ThreadComposer } from "../composer/ThreadComposer";
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

  it("says a failed dictation in the composer's notice card, in full, and not beside the microphone in the box", async () => {
    const user = userEvent.setup();
    installFakeMicrophone();
    const failure =
      "The transcription provider could not be reached, so nothing was written into the prompt this time.";
    const { client } = fakeSpeechClient({
      transcribeFailure: new SpeechClientFailure({
        message: failure,
        status: 502,
        category: "unavailable",
      }),
    });
    const { container } = render(
      <SpeechCapabilityProvider
        client={client}
        instances={speechTestInstances()}
        settings={speechTestSettings()}
      >
        <ThreadComposer
          input={<textarea aria-label="Message" className="composer-input" />}
          row={{
            dictate: <ComposerVoiceButton onTranscript={vi.fn()} />,
            actions: { kind: "send", send: { ariaLabel: "Send", onSend: vi.fn() } },
          }}
        />
      </SpeechCapabilityProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Dictate message" }));
    await user.click(await screen.findByRole("button", { name: "Stop dictating" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(failure);
    expect(alert.closest(".composer-notices")).not.toBeNull();
    expect(container.querySelector(".thread-composer__surface")).not.toContainElement(alert);
    expect(container.querySelector(".composer-voice__error")).toBeNull();
    // Dictating again clears it.
    await user.click(screen.getByRole("button", { name: "Dictate message" }));
    await waitFor(() => expect(container.querySelector(".composer-notices")).toBeEmptyDOMElement());
  });
});

describe("the Dictate shortcut", () => {
  const dictateChord = { key: "M", metaKey: true, shiftKey: true };

  function renderComposer(options: { readonly configured?: boolean } = {}) {
    const { client, transcribe } = fakeSpeechClient({ transcript: "from the keyboard" });
    const onTranscript = vi.fn();
    render(
      <SpeechCapabilityProvider
        client={client}
        instances={speechTestInstances()}
        settings={options.configured === false ? {} : speechTestSettings()}
      >
        <div>
          <textarea aria-label="Message" />
          <ComposerVoiceButton onTranscript={onTranscript} />
        </div>
        <div>
          <textarea aria-label="Other message" />
        </div>
      </SpeechCapabilityProvider>,
    );
    return { onTranscript, transcribe };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a tap on the dictation shortcut starts and a second tap stops", async () => {
    const { getUserMedia } = installFakeMicrophone();
    const { onTranscript } = renderComposer();
    screen.getByRole("textbox", { name: "Message" }).focus();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);

    fireEvent.keyDown(window, dictateChord);
    now.mockReturnValue(1_050);
    fireEvent.keyUp(window, dictateChord);
    await screen.findByRole("button", { name: "Stop dictating" });
    expect(getUserMedia).toHaveBeenCalledOnce();

    now.mockReturnValue(5_000);
    fireEvent.keyDown(window, dictateChord);
    fireEvent.keyUp(window, dictateChord);
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("from the keyboard"));
  });

  it("holding the shortcut records until it is released", async () => {
    installFakeMicrophone();
    const { onTranscript } = renderComposer();
    screen.getByRole("textbox", { name: "Message" }).focus();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);

    fireEvent.keyDown(window, dictateChord);
    await screen.findByRole("button", { name: "Stop dictating" });
    expect(onTranscript).not.toHaveBeenCalled();

    // Letting go of Command ends the hold, as macOS may never report the letter's release.
    now.mockReturnValue(2_500);
    fireEvent.keyUp(window, { key: "Meta", shiftKey: true });
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("from the keyboard"));
  });

  it("a hold let go while the microphone is still starting stops once it starts", async () => {
    installFakeMicrophone();
    let grant: () => void = () => undefined;
    const granted = new Promise<void>((resolve) => {
      grant = resolve;
    });
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => {
          await granted;
          return stream;
        }),
      },
    });
    const { onTranscript } = renderComposer();
    screen.getByRole("textbox", { name: "Message" }).focus();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);

    fireEvent.keyDown(window, dictateChord);
    await screen.findByRole("button", { name: "Starting microphone…" });
    now.mockReturnValue(2_000);
    fireEvent.keyUp(window, dictateChord);

    grant();
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("from the keyboard"));
    expect(screen.queryByRole("button", { name: "Stop dictating" })).toBeNull();
  });

  it("the shortcut does nothing while transcription is not ready", () => {
    const { getUserMedia } = installFakeMicrophone();
    renderComposer({ configured: false });
    screen.getByRole("textbox", { name: "Message" }).focus();

    fireEvent.keyDown(window, dictateChord);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("leaves a composer without focus alone", () => {
    const { getUserMedia } = installFakeMicrophone();
    renderComposer();
    screen.getByRole("textbox", { name: "Other message" }).focus();

    fireEvent.keyDown(window, dictateChord);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("does not start from the composer's own buttons, only its text field", () => {
    const { getUserMedia } = installFakeMicrophone();
    renderComposer();
    screen.getByRole("button", { name: "Dictate message" }).focus();

    fireEvent.keyDown(window, dictateChord);
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
