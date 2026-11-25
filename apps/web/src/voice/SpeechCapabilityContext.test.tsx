import type { SpeechStatusResponse } from "@octant/contracts";
import { LOCAL_SPEECH_DOWNLOADING_REASON } from "@octant/domain";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpeechCapabilityProvider, useSpeechCapability } from "./SpeechCapabilityContext";
import { fakeSpeechClient, speechTestInstances, speechTestSettings } from "./speechTestSupport";

const toLocalClip = vi.hoisted(() => vi.fn());
vi.mock("./localClip", () => ({ toLocalClip }));

const converted = new Blob(["converted"]);
const recorded = new Blob(["recorded"]);

beforeEach(() => {
  toLocalClip.mockReset();
  toLocalClip.mockResolvedValue(converted);
});

function hostStatus(transcription: SpeechStatusResponse["transcription"]) {
  return vi.fn(async () => ({
    transcription,
    synthesis: {
      status: "unconfigured" as const,
      settingsTarget: { section: "voice" as const, setting: "synthesis" as never },
    },
  }));
}

const unavailable = {
  status: "unavailable" as const,
  reason: "Apple Speech works only in Octant's windows on the Mac itself.",
  settingsTarget: { section: "voice" as const, setting: "transcription" as never },
};

function Probe() {
  const speech = useSpeechCapability();
  return (
    <>
      <output>{speech.status.transcription.status}</output>
      <button onClick={() => void speech.client?.transcribe({ audio: recorded })}>send</button>
      <button onClick={speech.refresh}>refresh</button>
    </>
  );
}

function show(
  status: ReturnType<typeof hostStatus>,
  local: boolean,
): ReturnType<typeof fakeSpeechClient> {
  const fake = fakeSpeechClient();
  render(
    <SpeechCapabilityProvider
      client={{ ...fake.client, status }}
      instances={speechTestInstances()}
      settings={{
        ...speechTestSettings(),
        ...(local ? { transcriptionEngine: "apple-speech" as const } : {}),
      }}
    >
      <Probe />
    </SpeechCapabilityProvider>,
  );
  return fake;
}

describe("speech capability", () => {
  it("leaves an endpoint's clip as it was recorded and asks the host nothing", async () => {
    const status = hostStatus(unavailable);
    const { transcribe } = show(status, false);
    expect(screen.getByRole("status")).toHaveTextContent("ready");
    screen.getByText("send").click();
    expect(transcribe).toHaveBeenCalledWith({ audio: recorded });
    expect(toLocalClip).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it("offers on-device dictation only once the host says it is ready there", async () => {
    show(hostStatus({ status: "ready", engine: "apple-speech" }), true);
    expect(screen.getByRole("status")).toHaveTextContent("unavailable");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("ready"));
  });

  it("offers nothing where the host refuses, though an endpoint is still saved", async () => {
    const status = hostStatus(unavailable);
    show(status, true);
    await waitFor(() => expect(status).toHaveBeenCalled());
    expect(screen.getByRole("status")).toHaveTextContent("unavailable");
  });

  it("converts the clip before it leaves the window for the engine", async () => {
    const { transcribe } = show(hostStatus({ status: "ready", engine: "apple-speech" }), true);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("ready"));
    screen.getByText("send").click();
    await waitFor(() => expect(transcribe).toHaveBeenCalledWith({ audio: converted }));
    expect(toLocalClip).toHaveBeenCalledWith(recorded);
  });

  it("keeps the microphone when a read on focus comes back without an answer", async () => {
    const status = hostStatus({ status: "ready", engine: "apple-speech" });
    show(status, true);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("ready"));
    status.mockResolvedValue({ ...(await status()), transcription: unavailable } as never);
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(status.mock.calls.length).toBeGreaterThan(2));
    expect(screen.getByRole("status")).toHaveTextContent("ready");
  });

  it("turns the microphone on when a download finishes with Voice settings closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const status = hostStatus({
        ...unavailable,
        reason: LOCAL_SPEECH_DOWNLOADING_REASON,
      });
      show(status, true);
      await waitFor(() => expect(status).toHaveBeenCalledOnce());
      status.mockResolvedValue({
        ...(await status()),
        transcription: { status: "ready", engine: "apple-speech" },
      } as never);
      await vi.advanceTimersByTimeAsync(2_000);
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("ready"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not keep asking while the model is simply missing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const status = hostStatus({
        ...unavailable,
        reason:
          "Apple's speech model for this language is not on this Mac. Download it in Voice settings.",
      });
      show(status, true);
      await waitFor(() => expect(status).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(10_000);
      expect(status).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks the host again when the model may have arrived", async () => {
    const status = hostStatus(unavailable);
    show(status, true);
    await waitFor(() => expect(status).toHaveBeenCalledOnce());
    status.mockResolvedValue({
      ...(await status()),
      transcription: { status: "ready", engine: "apple-speech" },
    } as never);
    screen.getByText("refresh").click();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("ready"));
  });
});
