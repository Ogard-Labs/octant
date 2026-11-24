import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeMediaRecorder, uninstallFakeMicrophone } from "./speechTestSupport";
import { useVoiceRecorder } from "./voiceRecorder";

afterEach(() => {
  uninstallFakeMicrophone();
});

/** A microphone whose permission prompt only settles when the test says so. */
function installDeferredMicrophone() {
  FakeMediaRecorder.instances = [];
  const stopTrack = vi.fn();
  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  let grant: () => void = () => undefined;
  const granted = new Promise<void>((resolve) => {
    grant = resolve;
  });
  const getUserMedia = vi.fn(async () => {
    await granted;
    return stream;
  });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  return { getUserMedia, stopTrack, grant: () => grant() };
}

function installMicrophone() {
  FakeMediaRecorder.instances = [];
  const stopTrack = vi.fn();
  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  return { getUserMedia, stopTrack };
}

describe("useVoiceRecorder", () => {
  it("opens one microphone when a second start arrives while permission is pending", async () => {
    const { getUserMedia, grant } = installDeferredMicrophone();
    const { result } = renderHook(() => useVoiceRecorder());

    await act(async () => {
      const first = result.current.start();
      const second = result.current.start();
      grant();
      await Promise.all([first, second]);
    });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(result.current.state.kind).toBe("recording");
  });

  it("releases a microphone that arrives after the recorder was cancelled", async () => {
    const { stopTrack, grant } = installDeferredMicrophone();
    const { result } = renderHook(() => useVoiceRecorder());

    await act(async () => {
      const pending = result.current.start();
      result.current.cancel();
      grant();
      await pending;
    });

    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(result.current.state.kind).toBe("idle");
  });

  it("hands the same clip to both callers when stop is pressed twice", async () => {
    installMicrophone();
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });

    let clips: ReadonlyArray<unknown> = [];
    await act(async () => {
      clips = await Promise.all([result.current.stop(), result.current.stop()]);
    });

    expect(clips[0]).toBeDefined();
    expect(clips[1]).toBe(clips[0]);
    expect(result.current.state.kind).toBe("idle");
  });
});

describe("useVoiceRecorder with a chosen microphone", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("records from the chosen microphone", async () => {
    const { getUserMedia } = installMicrophone();
    localStorage.setItem("octant.voice-microphone.v1", "usb-headset");
    const { result } = renderHook(() => useVoiceRecorder());

    await act(async () => {
      await result.current.start();
    });

    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(getUserMedia.mock.calls[0]).toEqual([
      expect.objectContaining({
        audio: expect.objectContaining({ deviceId: { exact: "usb-headset" } }),
      }),
    ]);
    expect(result.current.state.kind).toBe("recording");
  });

  it("falls back to the system default when the chosen microphone is gone", async () => {
    const { getUserMedia } = installMicrophone();
    getUserMedia.mockImplementationOnce(async () => {
      const error = new Error("gone");
      error.name = "OverconstrainedError";
      throw error;
    });
    localStorage.setItem("octant.voice-microphone.v1", "unplugged");
    const { result } = renderHook(() => useVoiceRecorder());

    await act(async () => {
      await result.current.start();
    });

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    const second = getUserMedia.mock.calls[1] as unknown as [MediaStreamConstraints];
    expect(second[0].audio).not.toHaveProperty("deviceId");
    expect(result.current.state.kind).toBe("recording");
  });
});
