import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MicrophoneTest } from "./MicrophoneTest";
import { SpeechCapabilityProvider } from "./SpeechCapabilityContext";
import {
  fakeSpeechClient,
  installFakeMicrophone,
  speechTestInstances,
  speechTestSettings,
  uninstallFakeMicrophone,
} from "./speechTestSupport";

describe("MicrophoneTest", () => {
  // jsdom has no object URLs; playback only needs one to point the player at.
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:test-recording");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    uninstallFakeMicrophone();
  });

  it("records a test clip and plays it back without calling the host", async () => {
    const user = userEvent.setup();
    const microphone = installFakeMicrophone();
    const { client, transcribe } = fakeSpeechClient();
    render(
      <SpeechCapabilityProvider client={client} instances={[]} settings={{}}>
        <MicrophoneTest />
      </SpeechCapabilityProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Record" }));
    await user.click(await screen.findByRole("button", { name: "Stop" }));

    expect(await screen.findByLabelText("Test recording")).toHaveAttribute(
      "src",
      "blob:test-recording",
    );
    expect(microphone.stopTrack).toHaveBeenCalled();
    // Transcription is not configured, so the clip has nowhere to go.
    expect(screen.queryByRole("button", { name: "Transcribe it" })).toBeNull();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("sends the test clip to the host only when asked, and shows what it heard", async () => {
    const user = userEvent.setup();
    installFakeMicrophone();
    const { client, transcribe } = fakeSpeechClient({ transcript: "testing one two" });
    render(
      <SpeechCapabilityProvider
        client={client}
        instances={speechTestInstances()}
        settings={speechTestSettings()}
      >
        <MicrophoneTest />
      </SpeechCapabilityProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Record" }));
    await user.click(await screen.findByRole("button", { name: "Stop" }));
    await screen.findByLabelText("Test recording");
    expect(transcribe).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Transcribe it" }));
    expect(transcribe).toHaveBeenCalledOnce();
    expect((await screen.findByRole("status")).textContent).toBe("Heard: “testing one two”");
  });

  it("says why when the microphone is refused", async () => {
    const user = userEvent.setup();
    installFakeMicrophone({ deny: true });
    render(<MicrophoneTest />);

    await user.click(screen.getByRole("button", { name: "Record" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Microphone access was not allowed.",
    );
  });
});
