import { createHash } from "node:crypto";
import {
  decodeTranscriptionOffer,
  SPEECH_TRANSCRIPTION_MAX_AUDIO_BYTES,
  type CodeRelativePath,
  type ServiceOffer,
  type ServiceOfferDecision,
  type WindowId,
} from "@octant/contracts";
import { isToolAllowedByAllowlist, type SpeechEndpointResolution } from "@octant/domain";
import type { MediaToolHostPort, MediaTranscriptionOutcome } from "@octant/plugin-api/media-tools";
import {
  TRANSCRIBE_MEDIA_TOOL_PLUGIN,
  TRANSCRIBE_TOOL_NAME,
} from "@octant/plugin-host/media-tools";
import { readConfinedCodeFile } from "../code/codeConfinedFileRead";
import { liveCodeTestSourcePort } from "../code/codeDirectoryPort";
import type { ServiceOfferAnswer } from "../offers/serviceOfferDecision";
import type { ServiceOfferService } from "../offers/serviceOfferService";
import { isProtectedSecretPath } from "../process/secretGuard";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { TaintAppManagedToolResultsInput } from "../providers/appManagedToolTaint";
import { adaptMediaToolSet } from "../providers/mediaToolAdapter";
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
    const profileAllows = () =>
      isToolAllowedByAllowlist(input.toolConstraints?.() ?? [], TRANSCRIBE_TOOL_NAME);
    const thread = String(input.scopeId);
    const port: MediaToolHostPort = {
      turn: {
        mode: input.threadKind === "work-thread" ? "work" : "code",
        hasFolder: true,
        unattended: false,
        inPlan: input.inPlan,
        allowed: () => profileAllows() && input.allowed(),
      },
      transcription: {
        isAvailable: () =>
          profileAllows() && !input.inPlan() && input.endpoint().status === "ready",
        transcribe: async ({
          relativePath,
          language,
          allowFreshRequest,
          signal,
        }): Promise<MediaTranscriptionOutcome> => {
          const allowed = () =>
            signal?.aborted !== true && profileAllows() && !input.inPlan() && input.allowed();
          const ready = input.endpoint();
          if (ready.status !== "ready") {
            return {
              status: "refused",
              reason: "Configure a transcription endpoint in Voice settings.",
            };
          }
          const target = destination(ready);
          const root = await input.root();
          if (root === undefined || !allowed()) {
            return { status: "refused", reason: "The turn no longer has access to this folder." };
          }
          const current = async () => {
            const folder = await input.root();
            const now = input.endpoint();
            return (
              folder === root && allowed() && now.status === "ready" && destination(now) === target
            );
          };
          const audio = await inspectAudio(root, relativePath);
          if ("reason" in audio) return { status: "refused", reason: audio.reason };
          if (!(await current())) {
            return {
              status: "refused",
              reason: "The folder, access or Voice destination changed.",
            };
          }
          const key = JSON.stringify([thread, audio.digest, target, language]);
          const cached = this.#pages.get(key);
          if (cached !== undefined) return { status: "transcribed", text: cached.text };
          if (!allowFreshRequest) return { status: "cache-miss" };
          let remember = false;
          if (this.#consent.get(thread)?.target !== target) {
            this.#consent.delete(thread);
            const answer = await input.offers.wait({
              windowId: input.windowId,
              ...(signal === undefined ? {} : { signal }),
              stamp: (offerId, requestedAt) =>
                decodeTranscriptionOffer({
                  kind: "transcribe",
                  offerId,
                  requestedAt,
                  threadKind: input.threadKind,
                  scopeId: input.scopeId,
                  relativePath,
                  sizeBytes: audio.size,
                  endpointName: ready.instance.displayName.slice(0, 120).trimEnd(),
                  modelId: ready.modelId,
                }),
            });
            if (answer.status !== "transcribe") {
              return {
                status: "refused",
                reason:
                  answer.status === "too-many-waiting"
                    ? "Too many offers are waiting."
                    : "Transcription was not approved.",
              };
            }
            remember = answer.rememberForThread;
          }
          if (!(await current())) {
            return {
              status: "refused",
              reason: "The folder, access or Voice destination changed.",
            };
          }
          const release = input.gates.transcription.tryAcquire("shared");
          if (!release) {
            return { status: "busy", reason: "Transcription is busy; try again shortly." };
          }
          try {
            const read = await readAudio(root, relativePath);
            if (read.status !== "read" || hash(read.bytes) !== audio.digest) {
              return {
                status: "refused",
                reason: "The audio file changed. Request a new transcription.",
              };
            }
            if (!(await current())) {
              return {
                status: "refused",
                reason: "The folder, access or Voice destination changed.",
              };
            }
            if (remember) this.#consent.set(thread, { target, windowId: input.windowId });
            const result = await input.adapter(ready).transcribe({
              audio: read.bytes,
              mediaType: audio.mediaType,
              modelId: ready.modelId,
              ...(language === undefined ? {} : { language }),
              ...(signal === undefined ? {} : { signal }),
            });
            if (!(await current())) {
              return {
                status: "refused",
                reason: "The turn can no longer receive this transcript.",
              };
            }
            if (result.status === "failed") {
              return { status: "failed", reason: result.providerFailure.message };
            }
            this.#pages.set(key, { thread, text: result.text, windowId: input.windowId });
            const oldest = this.#pages.keys().next().value;
            if (this.#pages.size > 8 && oldest !== undefined) this.#pages.delete(oldest);
            return { status: "transcribed", text: result.text };
          } finally {
            release();
          }
        },
      },
    };
    const tools = TRANSCRIBE_MEDIA_TOOL_PLUGIN.createTools(port);
    if (tools === undefined) return undefined;
    return adaptMediaToolSet({
      tools,
      threadId: thread,
      recordExternalContentIngestion: input.recordExternalContentIngestion,
      uuid: input.uuid,
    });
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
