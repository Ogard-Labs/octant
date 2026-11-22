import {
  decodeCodeRelativePath,
  decodeNarrationOffer,
  decodeSpeechSynthesisFormat,
  SPEECH_SYNTHESIS_FORMATS,
  SPEECH_SYNTHESIS_MAX_AUDIO_BYTES,
  SPEECH_SYNTHESIS_MAX_TEXT_CHARACTERS,
  type CodeRelativePath,
  type ServiceOffer,
  type ServiceOfferDecision,
  type SpeechSynthesisFormat,
  type SpeechSynthesisVoice,
  type WindowId,
} from "@octant/contracts";
import {
  canonicalizeWorkRelativePath,
  isToolAllowedByAllowlist,
  type SpeechEndpointResolution,
} from "@octant/domain";
import { checkConfinedNewFileUnder, writeConfinedNewFileUnder } from "../image/generatedImageSave";
import type { ServiceOfferAnswer } from "../offers/serviceOfferDecision";
import type { ServiceOfferService } from "../offers/serviceOfferService";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { threadWorkingDirectoryCurrent } from "../threadWorkingDirectoryAuthority";
import type { SpeechAdapter } from "./speechAdapter";
import { matchesSpeechSynthesisFormat } from "./speechAudio";
import type { SpeechGates } from "./speechGates";

export type NarrationPosture = "refuse" | "ask" | "allow";
type ReadySynthesis = Extract<SpeechEndpointResolution, { status: "ready" }> & {
  readonly voice: SpeechSynthesisVoice;
};
type Offer = Extract<ServiceOffer, { kind: "narrate" }>;
type Turn = Pick<Offer, "scopeId" | "threadKind"> & {
  readonly windowId: WindowId;
  readonly toolConstraints?: () => ReadonlyArray<string>;
  readonly posture: () => NarrationPosture;
  readonly allowed: () => boolean;
  readonly root: () => Promise<string | undefined>;
};
export type NarrationForTurn = (turn: Turn) => AppManagedToolSet | undefined;

const name = "octant_narrate";
const FORMAT_EXTENSIONS: Readonly<Record<SpeechSynthesisFormat, string>> = {
  mp3: ".mp3",
  wav: ".wav",
  opus: ".ogg",
};
const TOO_LONG_REASON =
  "Split the text into parts of at most 4,096 characters and narrate each to its own file.";

export function narrationDecision(offer: Offer, decision: ServiceOfferDecision) {
  if (decision.decision === "cancel") return { outcome: { status: "cancelled" } } as const;
  if (decision.decision !== "narrate") return { reason: "That answer does not fit this request." };
  return {
    outcome: {
      status: "narrate",
      rememberForThread: offer.canRemember === false ? false : decision.rememberForThread,
    },
  } as const;
}

function readySynthesis(resolution: SpeechEndpointResolution): ReadySynthesis | undefined {
  if (resolution.status !== "ready" || resolution.voice === undefined) return undefined;
  return { ...resolution, voice: resolution.voice };
}

/** The destination includes the actual address, model and chosen voice. */
function destination(ready: ReadySynthesis) {
  return JSON.stringify([
    ready.instance.id,
    ready.instance.configuration.baseUrl,
    ready.modelId,
    ready.voice,
  ]);
}

export class ThreadNarration {
  readonly #consent = new Map<string, { readonly target: string; readonly windowId: WindowId }>();

  revokeWindow(windowId: WindowId) {
    for (const [thread, consent] of this.#consent) {
      if (String(consent.windowId) === String(windowId)) this.#consent.delete(thread);
    }
  }

  forget(thread: string) {
    this.#consent.delete(thread);
  }

  forTurn(
    input: Turn & {
      readonly offers: Pick<ServiceOfferService<ServiceOffer, ServiceOfferAnswer>, "wait">;
      readonly gates: SpeechGates;
      readonly endpoint: () => SpeechEndpointResolution;
      readonly adapter: (ready: ReadySynthesis) => Pick<SpeechAdapter, "synthesize">;
    },
  ): AppManagedToolSet | undefined {
    const profileAllows = () => isToolAllowedByAllowlist(input.toolConstraints?.() ?? [], name);
    if (
      !profileAllows() ||
      input.posture() === "refuse" ||
      readySynthesis(input.endpoint()) === undefined
    ) {
      return undefined;
    }
    const stopped = new AbortController();
    const thread = String(input.scopeId);
    return {
      definitions: [
        {
          name,
          description:
            "Turn text into a spoken audio file in this thread's folder using the person's Voice synthesis endpoint and voice. Never overwrites an existing file.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: "string" },
              relativePath: { type: "string" },
              format: { type: "string", enum: [...SPEECH_SYNTHESIS_FORMATS] },
            },
            required: ["text", "relativePath"],
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
          !signal.aborted && profileAllows() && input.posture() !== "refuse" && input.allowed();
        if (call.name !== name) return refused("Narration is unavailable for this turn.");
        if (input.posture() === "refuse") return refused("Plan mode cannot create audio files.");
        if (!allowed()) return refused("Narration is unavailable for this turn.");

        const args = parseInput(call.inputJson);
        if (!args.ok) return refused(args.reason);

        const ready = readySynthesis(input.endpoint());
        if (ready === undefined)
          return refused("Configure a text-to-speech endpoint and voice in Voice settings.");
        const target = destination(ready);
        const root = await input.root();
        if (root === undefined || !allowed())
          return refused("The turn no longer has access to this folder.");
        // Pin the physical folder identity before asking so replacing the
        // directory at the same path while approval waits fails closed.
        const rootStillSame = threadWorkingDirectoryCurrent(root, root);
        if (!rootStillSame()) return refused("The turn no longer has access to this folder.");

        const precheck = await checkConfinedNewFileUnder({ root, relativePath: args.relativePath });
        if (precheck.status !== "ok") return refused(precheck.reason);

        const current = async (cardApproved: boolean) => {
          const folder = await input.root();
          const now = readySynthesis(input.endpoint());
          return (
            folder === root &&
            rootStillSame() &&
            allowed() &&
            (cardApproved || input.posture() === "allow") &&
            now !== undefined &&
            destination(now) === target
          );
        };

        const posture = input.posture();
        if (posture === "refuse") return refused("Plan mode cannot create audio files.");
        if (!(await current(true)))
          return refused("The folder, access or Voice destination changed.");

        const remembered = this.#consent.get(thread)?.target === target;
        if (!remembered) this.#consent.delete(thread);

        let cardApproved = false;
        let remember = false;
        const canRemember = posture === "allow";
        // At Ask first (and Work Auto) the card is also the file-write confirmation,
        // so a remembered thread skips it only at Accept edits and Full access.
        if (posture === "ask" || !remembered) {
          const answer = await input.offers.wait({
            windowId: input.windowId,
            signal,
            stamp: (offerId, requestedAt) =>
              decodeNarrationOffer({
                kind: "narrate",
                offerId,
                requestedAt,
                threadKind: input.threadKind,
                scopeId: input.scopeId,
                excerpt: makeExcerpt(args.text),
                characters: args.text.length,
                relativePath: args.relativePath,
                voice: ready.voice,
                endpointName: ready.instance.displayName.slice(0, 120).trimEnd(),
                modelId: ready.modelId,
                format: args.format,
                canRemember,
              }),
          });
          if (answer.status !== "narrate") {
            return refused(
              answer.status === "too-many-waiting"
                ? "Too many offers are waiting."
                : "Narration was not approved.",
            );
          }
          cardApproved = true;
          remember = canRemember && answer.rememberForThread;
        }

        if (!(await current(cardApproved)))
          return refused("The folder, access or Voice destination changed.");

        const release = input.gates.synthesis.tryAcquire("shared");
        if (!release) {
          return {
            isError: true,
            result: { status: "busy", reason: "Text to speech is busy; try again shortly." },
          };
        }
        try {
          const stillClear = await checkConfinedNewFileUnder({
            root,
            relativePath: args.relativePath,
            expectedRootIdentity: precheck.rootIdentity,
          });
          if (stillClear.status !== "ok") return refused(stillClear.reason);
          if (!(await current(cardApproved)))
            return refused("The folder, access or Voice destination changed.");
          if (remember && input.posture() === "allow") {
            this.#consent.set(thread, { target, windowId: input.windowId });
          }

          const result = await input.adapter(ready).synthesize({
            text: args.text,
            modelId: ready.modelId,
            voice: ready.voice,
            format: args.format,
            signal,
          });
          if (!(await current(cardApproved)))
            return refused("The folder, access or Voice destination changed.");
          if (result.status === "failed") {
            return {
              isError: true,
              result: { status: "failed", reason: result.providerFailure.message },
            };
          }
          if (
            result.bytes.byteLength === 0 ||
            result.bytes.byteLength > SPEECH_SYNTHESIS_MAX_AUDIO_BYTES
          ) {
            return {
              isError: true,
              result: {
                status: "failed",
                reason:
                  result.bytes.byteLength === 0
                    ? "The provider returned no audio."
                    : "The synthesized audio exceeded the 10 MiB limit.",
              },
            };
          }
          if (!matchesSpeechSynthesisFormat(result.bytes, args.format)) {
            return {
              isError: true,
              result: {
                status: "failed",
                reason: `The provider returned audio that does not match the requested ${args.format} format.`,
              },
            };
          }

          const saved = await writeConfinedNewFileUnder({
            root,
            relativePath: args.relativePath,
            bytes: result.bytes,
            expectedRootIdentity: precheck.rootIdentity,
            current: () =>
              rootStillSame() && allowed() && (cardApproved || input.posture() === "allow"),
          });
          if (saved.status !== "saved") {
            return saved.status === "refused"
              ? refused(saved.reason)
              : { isError: true, result: { status: "failed", reason: saved.reason } };
          }
          return {
            result: {
              status: "saved",
              relativePath: saved.relativePath,
              bytes: result.bytes.byteLength,
            },
          };
        } finally {
          release();
        }
      },
    };
  }
}

function refused(reason: string) {
  return { isError: true, result: { status: "refused", reason } };
}

function makeExcerpt(text: string): string {
  let end = Math.min(text.length, 300);
  // Keep UTF-16 surrogate pairs intact at the 300-character preview boundary.
  if (end < text.length && (text.codePointAt(end - 1) ?? 0) > 0xffff) end--;
  return text.slice(0, end).trimEnd();
}

type ParsedInput =
  | {
      readonly ok: true;
      readonly text: string;
      readonly relativePath: CodeRelativePath;
      readonly format: SpeechSynthesisFormat;
    }
  | { readonly ok: false; readonly reason: string };

function parseInput(json: string): ParsedInput {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, reason: "Provide text and a relativePath inside this thread's folder." };
  }
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    !("text" in raw) ||
    !("relativePath" in raw) ||
    Object.keys(raw).some((key) => !["text", "relativePath", "format"].includes(key))
  ) {
    return {
      ok: false,
      reason: "Provide text, a relativePath inside this thread's folder, and an optional format.",
    };
  }
  if (typeof raw.text !== "string") return { ok: false, reason: "Provide text to narrate." };
  if (raw.text.length > SPEECH_SYNTHESIS_MAX_TEXT_CHARACTERS) {
    return { ok: false, reason: TOO_LONG_REASON };
  }
  const text = raw.text.trim();
  if (text.length === 0) return { ok: false, reason: "Provide text to narrate." };

  let format: SpeechSynthesisFormat = "mp3";
  if ("format" in raw && raw.format !== undefined) {
    try {
      format = decodeSpeechSynthesisFormat(raw.format);
    } catch {
      return { ok: false, reason: "Format must be mp3, wav, or opus." };
    }
  }

  if (typeof raw.relativePath !== "string" || /^[a-z][a-z0-9+.-]*:/i.test(raw.relativePath)) {
    return { ok: false, reason: "The save path is outside the folder." };
  }
  let relativePath: CodeRelativePath;
  try {
    relativePath = decodeCodeRelativePath(canonicalizeWorkRelativePath(raw.relativePath));
  } catch {
    return { ok: false, reason: "The save path is outside the folder." };
  }
  if (relativePath.length > 512) return { ok: false, reason: "The save path is too long." };

  const expectedExtension = FORMAT_EXTENSIONS[format];
  if (!relativePath.toLowerCase().endsWith(expectedExtension)) {
    return {
      ok: false,
      reason: `Format ${format} requires a ${expectedExtension} file extension.`,
    };
  }
  return { ok: true, text, relativePath, format };
}
