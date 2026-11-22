import { createHash } from "node:crypto";
import {
  decodeCodeRelativePath,
  decodeSpeechTranscriptionLanguage,
  decodeTranscriptionOffer,
  MAX_PROVIDER_TOOL_RESULT_BYTES,
  SPEECH_TRANSCRIPTION_MAX_AUDIO_BYTES,
  type CodeRelativePath,
  type ServiceOffer,
  type ServiceOfferDecision,
  type WindowId,
} from "@octant/contracts";
import { isToolAllowedByAllowlist, type SpeechEndpointResolution } from "@octant/domain";
import { readConfinedCodeFile } from "../code/codeConfinedFileRead";
import { liveCodeTestSourcePort } from "../code/codeDirectoryPort";
import type { ServiceOfferAnswer } from "../offers/serviceOfferDecision";
import type { ServiceOfferService } from "../offers/serviceOfferService";
import { isProtectedSecretPath } from "../process/secretGuard";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import {
  taintAppManagedToolResults,
  type TaintAppManagedToolResultsInput,
} from "../providers/appManagedToolTaint";
import type { SpeechAdapter } from "./speechAdapter";
import { sniffSpeechAudioMediaType } from "./speechAudio";
import type { SpeechGates } from "./speechGates";

type Ready = Extract<SpeechEndpointResolution, { status: "ready" }>;
type Offer = Extract<ServiceOffer, { kind: "transcribe" }>;
type Turn = Pick<Offer, "scopeId" | "threadKind"> & {
  readonly windowId: WindowId;
  readonly toolConstraints?: () => ReadonlyArray<string>;
  readonly inPlan: () => boolean;
  readonly allowed: () => boolean;
  readonly root: () => Promise<string | undefined>;
};
export type TranscriptionForTurn = (turn: Turn) => AppManagedToolSet | undefined;
const name = "octant_transcribe";
const pageSize = 32_000;

export function transcriptionDecision(_offer: Offer, decision: ServiceOfferDecision) {
  if (decision.decision === "cancel") return { outcome: { status: "cancelled" } } as const;
  if (decision.decision !== "transcribe")
    return { reason: "That answer does not fit this request." };
  return {
    outcome: { status: "transcribe", rememberForThread: decision.rememberForThread },
  } as const;
}

/** The destination is the actual address, not just the editable provider profile's id. */
function destination(ready: Ready) {
  return JSON.stringify([ready.instance.id, ready.instance.configuration.baseUrl, ready.modelId]);
}

export class ThreadTranscription {
  readonly #consent = new Map<string, { readonly target: string; readonly windowId: WindowId }>();
  readonly #pages = new Map<
    string,
    { readonly windowId: WindowId; readonly thread: string; readonly text: string }
  >();

  revokeWindow(windowId: WindowId) {
    for (const [thread, consent] of this.#consent)
      if (consent.windowId === windowId) this.#consent.delete(thread);
    for (const [key, entry] of this.#pages)
      if (entry.windowId === windowId) this.#pages.delete(key);
  }

  forget(thread: string) {
    this.#consent.delete(thread);
    for (const [key, entry] of this.#pages) if (entry.thread === thread) this.#pages.delete(key);
  }

  forTurn(
    input: Turn &
      Pick<TaintAppManagedToolResultsInput, "recordExternalContentIngestion" | "uuid"> & {
        readonly offers: Pick<ServiceOfferService<ServiceOffer, ServiceOfferAnswer>, "wait">;
        readonly gates: SpeechGates;
        readonly endpoint: () => SpeechEndpointResolution;
        readonly adapter: (ready: Ready) => Pick<SpeechAdapter, "transcribe">;
      },
  ): AppManagedToolSet | undefined {
    const profileAllows = () => isToolAllowedByAllowlist(input.toolConstraints?.() ?? [], name);
    if (!profileAllows() || input.inPlan() || input.endpoint().status !== "ready") return undefined;
    const stopped = new AbortController();
    const thread = String(input.scopeId);
    const tools: AppManagedToolSet = {
      definitions: [
        {
          name,
          description:
            "Transcribe an audio file in this thread's folder using the person's Voice endpoint. Use nextOffset to page without another provider call.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              relativePath: { type: "string" },
              language: { type: "string" },
              offset: { type: "integer", minimum: 0 },
            },
            required: ["relativePath"],
          },
        },
      ],
      close: async () => stopped.abort(),
      execute: async (call) => {
        const signal =
          call.signal === undefined
            ? stopped.signal
            : AbortSignal.any([stopped.signal, call.signal]);
        const allowed = () =>
          !signal.aborted && profileAllows() && !input.inPlan() && input.allowed();
        if (call.name !== name || !allowed())
          return refused("Transcription is unavailable for this turn.");
        const args = parseInput(call.inputJson);
        if (!args)
          return refused(
            "Name a relative audio file in this thread's folder, with an optional language and nonnegative offset.",
          );
        const ready = input.endpoint();
        if (ready.status !== "ready")
          return refused("Configure a transcription endpoint in Voice settings.");
        const target = destination(ready);
        const root = await input.root();
        if (root === undefined || !allowed())
          return refused("The turn no longer has access to this folder.");
        const current = async () => {
          const folder = await input.root();
          const now = input.endpoint();
          return (
            folder === root && allowed() && now.status === "ready" && destination(now) === target
          );
        };
        const audio = await inspectAudio(root, args.relativePath);
        if ("reason" in audio) return refused(audio.reason);
        if (!(await current())) return refused("The folder, access or Voice destination changed.");
        const key = JSON.stringify([thread, audio.digest, target, args.language]);
        const cached = this.#pages.get(key);
        if (cached !== undefined) return page(cached.text, args.offset);
        if (args.offset > 0)
          return refused(
            "This page is no longer cached. Start at offset 0 to request transcription again.",
          );
        let remember = false;
        if (this.#consent.get(thread)?.target !== target) {
          this.#consent.delete(thread);
          const answer = await input.offers.wait({
            windowId: input.windowId,
            signal,
            stamp: (offerId, requestedAt) =>
              decodeTranscriptionOffer({
                kind: "transcribe",
                offerId,
                requestedAt,
                threadKind: input.threadKind,
                scopeId: input.scopeId,
                relativePath: args.relativePath,
                sizeBytes: audio.size,
                endpointName: ready.instance.displayName.slice(0, 120).trimEnd(),
                modelId: ready.modelId,
              }),
          });
          if (answer.status !== "transcribe")
            return refused(
              answer.status === "too-many-waiting"
                ? "Too many offers are waiting."
                : "Transcription was not approved.",
            );
          remember = answer.rememberForThread;
        }
        if (!(await current())) return refused("The folder, access or Voice destination changed.");
        const release = input.gates.transcription.tryAcquire("shared");
        if (!release)
          return {
            isError: true,
            result: { status: "busy", reason: "Transcription is busy; try again shortly." },
          };
        try {
          const read = await readAudio(root, args.relativePath);
          if (read.status !== "read" || hash(read.bytes) !== audio.digest)
            return refused("The audio file changed. Request a new transcription.");
          if (!(await current()))
            return refused("The folder, access or Voice destination changed.");
          if (remember) this.#consent.set(thread, { target, windowId: input.windowId });
          const result = await input.adapter(ready).transcribe({
            audio: read.bytes,
            mediaType: audio.mediaType,
            modelId: ready.modelId,
            ...(args.language === undefined ? {} : { language: args.language }),
            signal,
          });
          if (!(await current())) return refused("The turn can no longer receive this transcript.");
          if (result.status === "failed")
            return {
              isError: true,
              result: { status: "failed", reason: result.providerFailure.message },
            };
          this.#pages.set(key, { thread, text: result.text, windowId: input.windowId });
          const oldest = this.#pages.keys().next().value;
          if (this.#pages.size > 8 && oldest !== undefined) this.#pages.delete(oldest);
          return page(result.text, 0);
        } finally {
          release();
        }
      },
    };
    return taintAppManagedToolResults({
      tools,
      threadId: thread,
      recordExternalContentIngestion: input.recordExternalContentIngestion,
      uuid: input.uuid,
    });
  }
}

function refused(reason: string) {
  return { isError: true, result: { status: "refused", reason } };
}

function page(text: string, offset: number) {
  if (offset > text.length) return refused("The offset is past the end of this transcript.");
  const resultAt = (next: number) => ({
    status: "transcribed",
    text: text.slice(offset, next),
    characters: text.length,
    truncated: next < text.length,
    ...(next < text.length ? { nextOffset: next } : {}),
  });
  let end = Math.min(text.length, offset + pageSize);
  if (Buffer.byteLength(JSON.stringify(resultAt(end))) > MAX_PROVIDER_TOOL_RESULT_BYTES) {
    let lo = offset;
    while (lo < end) {
      const mid = Math.ceil((lo + end) / 2);
      if (Buffer.byteLength(JSON.stringify(resultAt(mid))) <= MAX_PROVIDER_TOOL_RESULT_BYTES)
        lo = mid;
      else end = mid - 1;
    }
  }
  // Offsets follow JavaScript string indices; do not split a character across two tool answers.
  if (end < text.length && (text.codePointAt(end - 1) ?? 0) > 0xffff) end--;
  return { result: resultAt(end) };
}

function parseInput(json: string) {
  try {
    const raw: unknown = JSON.parse(json);
    if (
      raw === null ||
      typeof raw !== "object" ||
      !("relativePath" in raw) ||
      Object.keys(raw).some((k) => !["relativePath", "language", "offset"].includes(k))
    )
      return undefined;
    const relativePath = decodeCodeRelativePath(raw.relativePath);
    if (relativePath.length > 512 || /^[a-z][a-z0-9+.-]*:/i.test(relativePath)) return undefined;
    const offset = "offset" in raw ? raw.offset : 0;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return undefined;
    return {
      relativePath,
      offset,
      language: "language" in raw ? decodeSpeechTranscriptionLanguage(raw.language) : undefined,
    };
  } catch {
    return undefined;
  }
}

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function readAudio(canonicalRoot: string, relativePath: CodeRelativePath) {
  return readConfinedCodeFile({
    canonicalRoot,
    relativePath,
    port: liveCodeTestSourcePort,
    maximumBytes: SPEECH_TRANSCRIPTION_MAX_AUDIO_BYTES,
    allowResolved: (path) => !isProtectedSecretPath(path),
  });
}

// Retain only the measured identity, never a recording, while a card is waiting.
async function inspectAudio(root: string, path: CodeRelativePath) {
  const read = await readAudio(root, path);
  if (read.status !== "read")
    return {
      reason:
        read.reason === "too-large"
          ? "Audio exceeds 10 MiB. If ffmpeg is installed, split it into smaller parts and request each separately."
          : "The file is not readable inside the turn's folder.",
    } as const;
  const mediaType = sniffSpeechAudioMediaType(read.bytes);
  if (!mediaType)
    return {
      reason: "The file is not supported audio (WAV, WebM, Ogg, MPEG, MP4 or FLAC).",
    } as const;
  return { digest: hash(read.bytes), size: read.bytes.byteLength, mediaType } as const;
}
