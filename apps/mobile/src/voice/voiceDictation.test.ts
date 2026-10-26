import { REMOTE_TRANSCRIPTION_MAX_CLIP_MS } from "@octant/domain";
import type { MobileTranscriptionResult } from "@octant/client-runtime";
import { describe, expect, it, vi } from "vitest";
import { appendTranscript, VoiceDictation, type VoiceDictationView } from "./voiceDictation";
import {
  createUnavailableVoiceRecorderPort,
  type MobileVoiceRecorderPort,
  type RecordedVoiceClip,
} from "./voiceRecorderPort";

const clip: RecordedVoiceClip = {
  audio: Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]),
  mediaType: "audio/mp4",
};

function fixture(
  options: {
    readonly transcribe?: (clip: RecordedVoiceClip) => Promise<MobileTranscriptionResult>;
    readonly recorder?: Partial<MobileVoiceRecorderPort>;
  } = {},
) {
  const events: string[] = [];
  const recorder: MobileVoiceRecorderPort = {
    available: true,
    start: vi.fn(async () => {
      events.push("start");
      return { status: "recording" as const };
    }),
    stop: vi.fn(async () => {
      events.push("stop");
      return { status: "recorded" as const, clip };
    }),
    discard: vi.fn(async () => {
      events.push("discard");
    }),
    ...options.recorder,
  };
  const transcribe = vi.fn(async (sent: RecordedVoiceClip) => {
    events.push("transcribe");
    return options.transcribe === undefined
      ? ({ status: "transcribed", text: "  ship the fix  " } as const)
      : options.transcribe(sent);
  });
  let draft = "Please";
  const appendToDraft = vi.fn((text: string) => {
    draft = appendTranscript(draft, text);
  });
  const views: VoiceDictationView[] = [];
  const notices: Array<string | undefined> = [];
  let fireTimer: (() => void) | undefined;
  let timerMs: number | undefined;
  const dictation = new VoiceDictation({
    recorder,
    transcribe,
    appendToDraft,
    onChange: (view, notice) => {
      views.push(view);
      notices.push(notice);
    },
    startTimer: (ms, fire) => {
      timerMs = ms;
      fireTimer = fire;
      return () => {
        fireTimer = undefined;
      };
    },
  });
  return {
    dictation,
    recorder,
    transcribe,
    appendToDraft,
    events,
    views,
    notices,
    draft: () => draft,
    timer: () => ({ ms: timerMs, fire: fireTimer }),
  };
}

describe("dictation on the phone", () => {
  it("offers the microphone only while the host is ready and the phone can record", () => {
    const { dictation } = fixture();
    expect(dictation.view()).toEqual({ kind: "hidden" });
    dictation.setReady(true);
    expect(dictation.view()).toEqual({ kind: "idle" });
    dictation.setReady(false);
    expect(dictation.view()).toEqual({ kind: "hidden" });

    const noRecorder = fixture({ recorder: createUnavailableVoiceRecorderPort() });
    noRecorder.dictation.setReady(true);
    expect(noRecorder.dictation.view()).toEqual({ kind: "hidden" });
  });

  it("appends the transcript to the draft without sending it, then discards the audio", async () => {
    const run = fixture();
    run.dictation.setReady(true);
    await run.dictation.press();
    expect(run.dictation.view()).toEqual({ kind: "recording" });
    await run.dictation.press();

    expect(run.transcribe).toHaveBeenCalledWith(clip);
    expect(run.draft()).toBe("Please ship the fix");
    expect(run.events).toEqual(["start", "stop", "transcribe", "discard"]);
    expect(run.dictation.view()).toEqual({ kind: "idle" });
    expect(run.views.map((view) => view.kind)).toEqual([
      "idle",
      "recording",
      "transcribing",
      "idle",
    ]);
  });

  it("keeps the draft, says why, and discards the audio when the host refuses the clip", async () => {
    const run = fixture({
      transcribe: async () => ({
        status: "refused",
        category: "rate-limited",
        message: "This device has used its voice allowance for now. Try again later.",
        retryAfterMs: 12 * 60_000 - 1,
      }),
    });
    run.dictation.setReady(true);
    await run.dictation.press();
    await run.dictation.press();

    expect(run.appendToDraft).not.toHaveBeenCalled();
    expect(run.draft()).toBe("Please");
    expect(run.events.at(-1)).toBe("discard");
    expect(run.notices.at(-1)).toBe(
      "This device has used its voice allowance for now. Try again later. You can dictate again in about 12 minutes.",
    );
  });

  it("discards the audio when the upload itself throws", async () => {
    const run = fixture({
      transcribe: async () => {
        throw new Error("socket closed");
      },
    });
    run.dictation.setReady(true);
    await run.dictation.press();
    await run.dictation.press();
    expect(run.events.at(-1)).toBe("discard");
    expect(run.dictation.view()).toEqual({ kind: "idle" });
    expect(run.notices.at(-1)).toBe("Could not transcribe the recording.");
  });

  it("stops a clip on its own at sixty seconds and transcribes what it heard", async () => {
    const run = fixture();
    run.dictation.setReady(true);
    await run.dictation.press();
    expect(run.timer().ms).toBe(REMOTE_TRANSCRIPTION_MAX_CLIP_MS);
    run.timer().fire?.();
    await vi.waitFor(() => expect(run.dictation.view()).toEqual({ kind: "idle" }));
    expect(run.events).toEqual(["start", "stop", "transcribe", "discard"]);
  });

  it("drops a recording unsent when the app leaves the foreground or the host stops being ready", async () => {
    const backgrounded = fixture();
    backgrounded.dictation.setReady(true);
    await backgrounded.dictation.press();
    await backgrounded.dictation.cancel();
    expect(backgrounded.events).toEqual(["start", "discard"]);
    expect(backgrounded.transcribe).not.toHaveBeenCalled();
    expect(backgrounded.timer().fire).toBeUndefined();
    expect(backgrounded.dictation.view()).toEqual({ kind: "idle" });

    const hostChanged = fixture();
    hostChanged.dictation.setReady(true);
    await hostChanged.dictation.press();
    hostChanged.dictation.setReady(false);
    await vi.waitFor(() => expect(hostChanged.events).toEqual(["start", "discard"]));
    expect(hostChanged.dictation.view()).toEqual({ kind: "hidden" });
  });

  it("drops a recording that started after the app had already left the foreground", async () => {
    let started: (value: { readonly status: "recording" }) => void = () => undefined;
    const run = fixture({
      recorder: {
        start: () =>
          new Promise((resolve) => {
            started = resolve;
          }),
      },
    });
    run.dictation.setReady(true);
    const pressing = run.dictation.press();
    await run.dictation.cancel();
    started({ status: "recording" });
    await pressing;
    expect(run.recorder.discard).toHaveBeenCalled();
    expect(run.transcribe).not.toHaveBeenCalled();
    expect(run.dictation.view()).toEqual({ kind: "idle" });
  });

  it("names a denied microphone instead of recording", async () => {
    const run = fixture({ recorder: { start: async () => ({ status: "denied" }) } });
    run.dictation.setReady(true);
    await run.dictation.press();
    expect(run.dictation.view()).toEqual({ kind: "idle" });
    expect(run.notices.at(-1)).toBe("Allow microphone access in Settings to dictate.");
  });
});

describe("appending a transcript", () => {
  it("joins the words to the draft with one space and ignores silence", () => {
    expect(appendTranscript("", "  Hello there ")).toBe("Hello there");
    expect(appendTranscript("Hi", "there")).toBe("Hi there");
    expect(appendTranscript("Hi\n", "there")).toBe("Hi\nthere");
    expect(appendTranscript("Hi", "   ")).toBe("Hi");
  });
});
