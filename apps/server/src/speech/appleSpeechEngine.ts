import { spawn as spawnChild } from "node:child_process";
import { release as osRelease } from "node:os";
import {
  decodeSpeechLocalEngineStatus,
  SPEECH_TRANSCRIPT_MAX_CHARACTERS,
  type ProviderFailure,
  type SpeechLocalEngineStatus,
  type SpeechTranscriptionLanguage,
  type VoiceDictionaryTerm,
} from "@octant/contracts";

/** macOS 26 is Darwin 25, the first system with Apple's on-device dictation API. */
const FIRST_SUPPORTED_DARWIN = 25;
const STATUS_TIMEOUT_MS = 15_000;
// Two minutes of speech took 35 seconds on an 18-core Mac in November 2026.
const TRANSCRIPTION_TIMEOUT_MS = 110_000;
const DOWNLOAD_TIMEOUT_MS = 1_800_000;
const MAXIMUM_ANSWER_BYTES = 1_048_576;

export type LocalTranscriptionResult =
  | { readonly status: "completed"; readonly text: string }
  | { readonly status: "unavailable"; readonly engine: SpeechLocalEngineStatus }
  | { readonly status: "failed"; readonly providerFailure: ProviderFailure };

export interface LocalTranscriptionRequest {
  /** 16 kHz mono 16-bit PCM, already bounded by the route. */
  readonly pcm: Uint8Array;
  readonly language?: SpeechTranscriptionLanguage;
  readonly dictionary?: ReadonlyArray<VoiceDictionaryTerm>;
  readonly signal?: AbortSignal;
}

export interface AppleSpeechEngine {
  readonly status: (language?: SpeechTranscriptionLanguage) => Promise<SpeechLocalEngineStatus>;
  /** Starts fetching the model and answers at once; `status` follows it. */
  readonly download: (language?: SpeechTranscriptionLanguage) => Promise<SpeechLocalEngineStatus>;
  readonly transcribe: (request: LocalTranscriptionRequest) => Promise<LocalTranscriptionResult>;
  /** Stops every helper; nothing runs past the host. */
  readonly dispose: () => void;
}

/** The part of a child process this module uses, so a test can stand one in. */
export interface SpeechHelperChild {
  readonly stdin: {
    write(chunk: Uint8Array): unknown;
    end(): unknown;
    on(event: "error", listener: () => void): unknown;
  };
  readonly stdout: { on(event: "data", listener: (chunk: Uint8Array) => void): unknown };
  on(event: "error" | "close", listener: () => void): unknown;
  kill(signal: "SIGKILL"): unknown;
}

export interface AppleSpeechEngineOptions {
  /** Absent on a host that was not started by the macOS desktop app. */
  readonly helperPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly release?: string;
  readonly spawn?: (helperPath: string) => SpeechHelperChild;
}

interface HelperRequest {
  readonly operation: "status" | "download" | "transcribe";
  readonly language?: SpeechTranscriptionLanguage;
  readonly contextualStrings?: ReadonlyArray<string>;
  readonly audioBytes?: number;
}

type HelperAnswer =
  | { readonly kind: "status"; readonly state: string; readonly language: string }
  | { readonly kind: "downloaded" }
  | { readonly kind: "transcript"; readonly text: string }
  | { readonly kind: "refused"; readonly code: string }
  | { readonly kind: "interrupted" }
  | { readonly kind: "failed" };

interface Download {
  readonly key: string;
  readonly cancel: AbortController;
  status: SpeechLocalEngineStatus;
}

/**
 * Speech to text on this Mac, through Apple's on-device dictation model.
 *
 * Each request runs one short-lived helper that reads everything from its
 * standard input. The clip and the transcript exist only in memory, in this
 * process and the helper's, and neither is logged; the helper's standard error
 * is not read. A helper that crashes, stalls or answers something unreadable
 * fails that one request. It exits when its standard input closes, so one
 * cannot outlive a host that stopped or crashed.
 */
export function createAppleSpeechEngine(options: AppleSpeechEngineOptions = {}): AppleSpeechEngine {
  const platform = options.platform ?? process.platform;
  const release = options.release ?? osRelease();
  const spawn = options.spawn ?? spawnHelper;
  const running = new Set<SpeechHelperChild>();
  const asking = new Map<string, Promise<SpeechLocalEngineStatus>>();
  let download: Download | undefined;
  let disposed = false;

  function unsupported(): SpeechLocalEngineStatus | undefined {
    if (platform !== "darwin" || Number(release.split(".")[0]) < FIRST_SUPPORTED_DARWIN) {
      return {
        status: "unsupported",
        reason: "Apple Speech needs a Mac with macOS 26 or later.",
      };
    }
    if (options.helperPath === undefined) {
      return {
        status: "unsupported",
        reason: "Apple Speech comes with the Octant app for Mac, and this host runs without it.",
      };
    }
    return undefined;
  }

  function run(
    request: HelperRequest,
    limits: {
      readonly timeoutMs: number;
      readonly audio?: Uint8Array;
      readonly signal?: AbortSignal;
      readonly onProgress?: (fraction: number) => void;
    },
  ): Promise<HelperAnswer> {
    const helperPath = options.helperPath;
    if (helperPath === undefined || disposed) return Promise.resolve({ kind: "failed" });
    if (limits.signal?.aborted === true) return Promise.resolve({ kind: "interrupted" });
    return new Promise((resolve) => {
      let child: SpeechHelperChild;
      try {
        child = spawn(helperPath);
      } catch {
        resolve({ kind: "failed" });
        return;
      }
      running.add(child);
      let buffered = Buffer.alloc(0);
      let settled = false;
      const settle = (answer: HelperAnswer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        limits.signal?.removeEventListener("abort", abort);
        child.stdin.end();
        child.kill("SIGKILL");
        resolve(answer);
      };
      const abort = () => settle({ kind: "interrupted" });
      const timer = setTimeout(() => settle({ kind: "failed" }), limits.timeoutMs);
      limits.signal?.addEventListener("abort", abort, { once: true });
      child.on("error", () => {
        running.delete(child);
        settle({ kind: "failed" });
      });
      child.on("close", () => {
        running.delete(child);
        settle({ kind: "failed" });
      });
      child.stdin.on("error", () => settle({ kind: "failed" }));
      child.stdout.on("data", (chunk) => {
        if (settled) return;
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.byteLength > MAXIMUM_ANSWER_BYTES) {
          settle({ kind: "failed" });
          return;
        }
        for (;;) {
          const end = buffered.indexOf(0x0a);
          if (end === -1) return;
          const event = readEvent(buffered.subarray(0, end));
          buffered = buffered.subarray(end + 1);
          if (event === undefined) {
            settle({ kind: "failed" });
            return;
          }
          if (event.kind !== "progress") {
            settle(event);
            return;
          }
          limits.onProgress?.(event.fraction);
        }
      });
      const header = Buffer.from(JSON.stringify({ protocolVersion: 1, ...request }));
      const length = Buffer.alloc(4);
      length.writeUInt32BE(header.byteLength);
      child.stdin.write(Buffer.concat([length, header]));
      if (limits.audio !== undefined) child.stdin.write(limits.audio);
    });
  }

  async function ask(language: SpeechTranscriptionLanguage | undefined) {
    const answer = await run(
      { operation: "status", ...(language === undefined ? {} : { language }) },
      { timeoutMs: STATUS_TIMEOUT_MS },
    );
    return readStatus(answer);
  }

  async function status(language?: SpeechTranscriptionLanguage): Promise<SpeechLocalEngineStatus> {
    const refused = unsupported();
    if (refused !== undefined) return refused;
    const key = language ?? "";
    if (download?.key === key && download.status.status === "downloading") return download.status;
    let pending = asking.get(key);
    if (pending === undefined) {
      pending = ask(language).finally(() => asking.delete(key));
      asking.set(key, pending);
    }
    const asked = await pending;
    // A failed download stays said until the model is here or it is retried.
    return download?.key === key && asked.status === "not-downloaded" ? download.status : asked;
  }

  async function startDownload(
    language?: SpeechTranscriptionLanguage,
  ): Promise<SpeechLocalEngineStatus> {
    const key = language ?? "";
    const before = await status(language);
    if (before.status !== "not-downloaded" && before.status !== "download-failed") return before;
    // Asked twice while the first was finding out; one download serves both.
    if (download?.key === key && download.status.status === "downloading") return download.status;
    // The person changed language while one was on its way: theirs is the one wanted.
    download?.cancel.abort();
    const started: Download = {
      key,
      cancel: new AbortController(),
      status: { status: "downloading", language: before.language, fraction: 0 },
    };
    download = started;
    void run(
      { operation: "download", ...(language === undefined ? {} : { language }) },
      {
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        signal: started.cancel.signal,
        onProgress: (fraction) => {
          started.status = { status: "downloading", language: before.language, fraction };
        },
      },
    ).then((answer) => {
      if (download !== started) return;
      if (answer.kind === "downloaded") download = undefined;
      else started.status = { status: "download-failed", language: before.language };
    });
    return started.status;
  }

  return {
    status,
    download: startDownload,
    transcribe: async (request) => {
      const refused = unsupported();
      if (refused !== undefined) return { status: "unavailable", engine: refused };
      const answer = await run(
        {
          operation: "transcribe",
          ...(request.language === undefined ? {} : { language: request.language }),
          contextualStrings: request.dictionary ?? [],
          audioBytes: request.pcm.byteLength,
        },
        {
          timeoutMs: TRANSCRIPTION_TIMEOUT_MS,
          audio: request.pcm,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        },
      );
      if (answer.kind === "transcript") {
        return {
          status: "completed",
          text: answer.text.trim().slice(0, SPEECH_TRANSCRIPT_MAX_CHARACTERS),
        };
      }
      if (answer.kind === "interrupted") {
        return {
          status: "failed",
          providerFailure: { category: "interrupted", message: "The dictation was cancelled." },
        };
      }
      // The model can be gone, or the language changed, since it was last ready.
      if (
        answer.kind === "refused" &&
        (answer.code === "not-installed" || answer.code === "unsupported-language")
      ) {
        const engine = await status(request.language);
        if (engine.status !== "ready") return { status: "unavailable", engine };
      }
      return {
        status: "failed",
        providerFailure: {
          category: "provider-failed",
          message: "Apple Speech could not transcribe this recording. Try again.",
        },
      };
    },
    dispose: () => {
      disposed = true;
      download?.cancel.abort();
      for (const child of running) child.kill("SIGKILL");
    },
  };
}

function spawnHelper(helperPath: string): SpeechHelperChild {
  // The helper needs the person's language preferences, which live under
  // their home; nothing else in the host's environment is its business.
  const { HOME, TMPDIR, USER } = process.env;
  return spawnChild(helperPath, [], {
    stdio: ["pipe", "pipe", "ignore"],
    env: {
      ...(HOME === undefined ? {} : { HOME }),
      ...(TMPDIR === undefined ? {} : { TMPDIR }),
      ...(USER === undefined ? {} : { USER }),
    },
  });
}

function readStatus(answer: HelperAnswer): SpeechLocalEngineStatus {
  if (answer.kind === "refused" && answer.code === "unsupported-language")
    return { status: "unsupported-language" };
  if (answer.kind !== "status") return { status: "failed" };
  if (answer.state === "unsupported-language") return { status: "unsupported-language" };
  try {
    return decodeSpeechLocalEngineStatus({
      status: answer.state === "installed" ? "ready" : "not-downloaded",
      language: answer.language,
    });
  } catch {
    return { status: "failed" };
  }
}

function readEvent(
  line: Uint8Array,
): HelperAnswer | { readonly kind: "progress"; readonly fraction: number } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(line).toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || !("event" in value)) return undefined;
  switch (value.event) {
    case "progress": {
      const fraction = "fraction" in value ? value.fraction : undefined;
      return typeof fraction === "number" && Number.isFinite(fraction)
        ? { kind: "progress", fraction: Math.min(1, Math.max(0, fraction)) }
        : undefined;
    }
    case "status":
      return "state" in value &&
        typeof value.state === "string" &&
        "language" in value &&
        typeof value.language === "string"
        ? { kind: "status", state: value.state, language: value.language }
        : undefined;
    case "downloaded":
      return { kind: "downloaded" };
    case "transcript":
      return "text" in value && typeof value.text === "string"
        ? { kind: "transcript", text: value.text }
        : undefined;
    case "refused":
      return "code" in value && typeof value.code === "string"
        ? { kind: "refused", code: value.code }
        : undefined;
    default:
      return undefined;
  }
}
