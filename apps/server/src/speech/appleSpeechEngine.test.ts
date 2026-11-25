import { EventEmitter } from "node:events";
import { SPEECH_TRANSCRIPT_MAX_CHARACTERS } from "@octant/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appleSpeechOffered,
  createAppleSpeechEngine,
  type SpeechHelperChild,
} from "./appleSpeechEngine";

interface SentRequest {
  readonly header: Record<string, unknown>;
  readonly audio: Buffer;
}

class FakeHelper extends EventEmitter implements SpeechHelperChild {
  readonly stdout = new EventEmitter();
  readonly received: Array<Buffer> = [];
  readonly kill = vi.fn((_signal: "SIGKILL") => {
    queueMicrotask(() => this.emit("close"));
  });
  readonly stdin = Object.assign(new EventEmitter(), {
    write: (chunk: Uint8Array) => {
      this.received.push(Buffer.from(chunk));
    },
    end: vi.fn(),
  });

  get request(): SentRequest {
    const bytes = Buffer.concat(this.received);
    const length = bytes.readUInt32BE(0);
    return {
      header: JSON.parse(bytes.subarray(4, 4 + length).toString("utf8")),
      audio: bytes.subarray(4 + length),
    };
  }

  say(...events: ReadonlyArray<Record<string, unknown>>) {
    for (const event of events) this.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
  }
}

function setup(options: { readonly release?: string; readonly platform?: NodeJS.Platform } = {}) {
  const helpers: Array<FakeHelper> = [];
  const spawn = vi.fn(() => {
    const helper = new FakeHelper();
    helpers.push(helper);
    return helper;
  });
  const engine = createAppleSpeechEngine({
    helperPath: "/Applications/Octant.app/Contents/Resources/native/octant-speech-helper",
    platform: options.platform ?? "darwin",
    release: options.release ?? "25.0.0",
    spawn,
  });
  const helper = (index: number): FakeHelper => {
    const found = helpers[index];
    if (found === undefined) throw new Error(`no helper ${String(index)} was started`);
    return found;
  };
  return { engine, spawn, helper, helpers };
}

const pcm = Uint8Array.from([1, 2, 3, 4]);

afterEach(() => {
  vi.useRealTimers();
});

describe("on-device speech engine", () => {
  it.each([
    ["an earlier macOS", { release: "24.6.0" }],
    ["Linux", { platform: "linux" as const, release: "26.1.0" }],
    ["Windows", { platform: "win32" as const, release: "26.0.0" }],
  ])("is unsupported on %s and starts nothing there", async (_name, options) => {
    const { engine, spawn } = setup(options);
    expect(await engine.status("en")).toEqual({
      status: "unsupported",
      reason: "Apple Speech needs a Mac with macOS 26 or later.",
    });
    expect((await engine.download("en")).status).toBe("unsupported");
    expect((await engine.transcribe({ pcm })).status).toBe("unavailable");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("is offered, and its download named, only with the helper on macOS 26 or later", () => {
    const helperPath = "/Applications/Octant.app/Contents/Resources/native/octant-speech-helper";
    expect(appleSpeechOffered({ helperPath, platform: "darwin", release: "25.0.0" })).toBe(true);
    expect(appleSpeechOffered({ helperPath, platform: "darwin", release: "24.6.0" })).toBe(false);
    expect(appleSpeechOffered({ helperPath, platform: "linux", release: "26.0.0" })).toBe(false);
    expect(appleSpeechOffered({ platform: "darwin", release: "26.0.0" })).toBe(false);
  });

  it("is unsupported on a Mac host that was not started by the desktop app", async () => {
    const engine = createAppleSpeechEngine({ platform: "darwin", release: "26.0.0" });
    expect((await engine.status()).status).toBe("unsupported");
  });

  it("sends the clip, language and dictionary on standard input and returns the text", async () => {
    const { engine, helper } = setup();
    const result = engine.transcribe({
      pcm,
      language: "no",
      dictionary: ["Octant" as never, "worktree" as never],
    });
    expect(helper(0).request).toEqual({
      header: {
        protocolVersion: 1,
        operation: "transcribe",
        language: "no",
        contextualStrings: ["Octant", "worktree"],
        audioBytes: 4,
      },
      audio: Buffer.from(pcm),
    });
    // The helper stops when its input closes, so it stays open until the answer.
    expect(helper(0).stdin.end).not.toHaveBeenCalled();
    helper(0).say({ event: "transcript", text: "  hei  " });
    expect(await result).toEqual({ status: "completed", text: "hei" });
    expect(helper(0).stdin.end).toHaveBeenCalled();
  });

  it("names no language when none is chosen, so the Mac's own is used", async () => {
    const { engine, helper } = setup();
    void engine.transcribe({ pcm });
    expect(helper(0).request.header).not.toHaveProperty("language");
  });

  it("keeps two dictations apart", async () => {
    const { engine, helper } = setup();
    const first = engine.transcribe({ pcm });
    const second = engine.transcribe({ pcm });
    helper(1).say({ event: "transcript", text: "two" });
    helper(0).say({ event: "transcript", text: "one" });
    expect(await first).toEqual({ status: "completed", text: "one" });
    expect(await second).toEqual({ status: "completed", text: "two" });
  });

  it("reads an answer that arrives in pieces", async () => {
    const { engine, helper } = setup();
    const result = engine.transcribe({ pcm });
    const line = Buffer.from(`${JSON.stringify({ event: "transcript", text: "blåbær" })}\n`);
    const split = line.indexOf(0xc3) + 1;
    helper(0).stdout.emit("data", line.subarray(0, split));
    helper(0).stdout.emit("data", line.subarray(split));
    expect(await result).toEqual({ status: "completed", text: "blåbær" });
  });

  it("stops the helper when the person cancels", async () => {
    const { engine, helper } = setup();
    const cancel = new AbortController();
    const result = engine.transcribe({ pcm, signal: cancel.signal });
    cancel.abort();
    expect(await result).toMatchObject({
      status: "failed",
      providerFailure: { category: "interrupted" },
    });
    expect(helper(0).kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("starts nothing for a dictation that is already cancelled", async () => {
    const { engine, spawn } = setup();
    expect(await engine.transcribe({ pcm, signal: AbortSignal.abort() })).toMatchObject({
      providerFailure: { category: "interrupted" },
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each<[string, (helper: FakeHelper) => void]>([
    ["crashes", (helper) => helper.emit("close")],
    ["cannot be started", (helper) => helper.emit("error", new Error("ENOENT"))],
    ["closes its input", (helper) => helper.stdin.emit("error", new Error("EPIPE"))],
    ["answers something unreadable", (helper) => helper.stdout.emit("data", Buffer.from("no\n"))],
    ["answers an unknown event", (helper) => helper.say({ event: "audio" })],
    ["answers without end", (helper) => helper.stdout.emit("data", Buffer.alloc(1_100_000, 0x61))],
    ["refuses for its own reason", (helper) => helper.say({ event: "refused", code: "failed" })],
  ])("fails only that dictation when the helper %s", async (_name, act) => {
    const { engine, helper } = setup();
    const result = engine.transcribe({ pcm });
    act(helper(0));
    expect(await result).toEqual({
      status: "failed",
      providerFailure: {
        category: "provider-failed",
        message: "Apple Speech could not transcribe this recording. Try again.",
      },
    });
    const next = engine.transcribe({ pcm });
    helper(1).say({ event: "transcript", text: "again" });
    expect(await next).toEqual({ status: "completed", text: "again" });
  });

  it("stops a helper that never answers", async () => {
    vi.useFakeTimers();
    const { engine, helper } = setup();
    const result = engine.transcribe({ pcm });
    await vi.advanceTimersByTimeAsync(110_000);
    expect((await result).status).toBe("failed");
    expect(helper(0).kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("says the model is gone when it was removed since it was last ready", async () => {
    const { engine, helper } = setup();
    const result = engine.transcribe({ pcm, language: "fr" });
    helper(0).say({ event: "refused", code: "not-installed" });
    await vi.waitFor(() => expect(helper(1).request.header.operation).toBe("status"));
    helper(1).say({ event: "status", state: "absent", language: "fr-FR" });
    expect(await result).toEqual({
      status: "unavailable",
      engine: { status: "not-downloaded", language: "fr-FR" },
    });
  });

  it("bounds the text it returns", async () => {
    const { engine, helper } = setup();
    const result = engine.transcribe({ pcm });
    helper(0).say({ event: "transcript", text: "a".repeat(SPEECH_TRANSCRIPT_MAX_CHARACTERS + 1) });
    expect(await result).toMatchObject({
      text: "a".repeat(SPEECH_TRANSCRIPT_MAX_CHARACTERS),
    });
  });

  it("starts no helper after the host stops, and stops those running", async () => {
    const { engine, helper, spawn } = setup();
    const result = engine.transcribe({ pcm });
    engine.dispose();
    expect((await result).status).toBe("failed");
    expect(helper(0).kill).toHaveBeenCalledWith("SIGKILL");
    expect((await engine.transcribe({ pcm })).status).toBe("failed");
    expect(spawn).toHaveBeenCalledOnce();
  });
});

describe("on-device speech model", () => {
  it.each([
    [
      { event: "status", state: "installed", language: "nb-NO" },
      { status: "ready", language: "nb-NO" },
    ],
    [
      { event: "status", state: "absent", language: "fr-FR" },
      { status: "not-downloaded", language: "fr-FR" },
    ],
    [
      { event: "status", state: "unsupported-language", language: "fr-FR" },
      { status: "unsupported-language" },
    ],
    [{ event: "refused", code: "unsupported-language" }, { status: "unsupported-language" }],
    [{ event: "refused", code: "malformed" }, { status: "failed" }],
    [{ event: "status", state: "absent", language: "not a tag" }, { status: "failed" }],
  ])("reads %o as %o", async (event, expected) => {
    const { engine, helper } = setup();
    const status = engine.status("fr");
    helper(0).say(event);
    expect(await status).toEqual(expected);
  });

  it("asks the helper once for several windows reading at the same time", async () => {
    const { engine, helper, spawn } = setup();
    const both = [engine.status("no"), engine.status("no")];
    helper(0).say({ event: "status", state: "installed", language: "nb-NO" });
    await Promise.all(both);
    expect(spawn).toHaveBeenCalledOnce();
  });

  async function downloading() {
    const made = setup();
    const started = made.engine.download("fr");
    made.helper(0).say({ event: "status", state: "absent", language: "fr-FR" });
    expect(await started).toEqual({ status: "downloading", language: "fr-FR", fraction: 0 });
    return made;
  }

  it("shows how far a download has come, then that the model is here", async () => {
    const { engine, helper, spawn } = await downloading();
    expect(helper(1).request.header).toEqual({
      protocolVersion: 1,
      operation: "download",
      language: "fr",
    });
    helper(1).say({ event: "progress", fraction: 0.4 });
    expect(await engine.status("fr")).toEqual({
      status: "downloading",
      language: "fr-FR",
      fraction: 0.4,
    });
    expect(spawn).toHaveBeenCalledTimes(2);
    helper(1).say({ event: "downloaded", language: "fr-FR" });
    await Promise.resolve();
    const after = engine.status("fr");
    await vi.waitFor(() => helper(2));
    helper(2).say({ event: "status", state: "installed", language: "fr-FR" });
    expect(await after).toEqual({ status: "ready", language: "fr-FR" });
  });

  it("keeps saying a download failed until it is tried again", async () => {
    const { engine, helper } = await downloading();
    helper(1).emit("close");
    await Promise.resolve();
    const failed = engine.status("fr");
    helper(2).say({ event: "status", state: "absent", language: "fr-FR" });
    expect(await failed).toEqual({ status: "download-failed", language: "fr-FR" });
    const again = engine.download("fr");
    helper(3).say({ event: "status", state: "absent", language: "fr-FR" });
    expect((await again).status).toBe("downloading");
  });

  it("fetches once when asked twice", async () => {
    const { engine, helpers } = setup();
    const both = [engine.download("fr"), engine.download("fr")];
    helpers[0]?.say({ event: "status", state: "absent", language: "fr-FR" });
    expect((await Promise.all(both)).map(({ status }) => status)).toEqual([
      "downloading",
      "downloading",
    ]);
    expect(helpers).toHaveLength(2);
  });

  it("fetches nothing for a model that is already here", async () => {
    const { engine, helper, spawn } = setup();
    const started = engine.download("no");
    helper(0).say({ event: "status", state: "installed", language: "nb-NO" });
    expect((await started).status).toBe("ready");
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("gives up a download for a language the person moved on from", async () => {
    const { engine, helper } = await downloading();
    const other = engine.download("de");
    helper(2).say({ event: "status", state: "absent", language: "de-DE" });
    expect((await other).status).toBe("downloading");
    expect(helper(1).kill).toHaveBeenCalledWith("SIGKILL");
  });
});
