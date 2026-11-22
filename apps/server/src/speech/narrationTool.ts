import {
  decodeNarrationOffer,
  SPEECH_SYNTHESIS_MAX_AUDIO_BYTES,
  type ServiceOffer,
  type ServiceOfferDecision,
  type SpeechSynthesisVoice,
  type WindowId,
} from "@octant/contracts";
import { isToolAllowedByAllowlist, type SpeechEndpointResolution } from "@octant/domain";
import type { MediaNarrationOutcome, MediaToolHostPort } from "@octant/plugin-api/media-tools";
import { NARRATE_MEDIA_TOOL_PLUGIN, NARRATE_TOOL_NAME } from "@octant/plugin-host/media-tools";
import { checkConfinedNewFileUnder, writeConfinedNewFileUnder } from "../image/generatedImageSave";
import type { ServiceOfferAnswer } from "../offers/serviceOfferDecision";
import type { ServiceOfferService } from "../offers/serviceOfferService";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { adaptMediaToolSet } from "../providers/mediaToolAdapter";
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
    const profileAllows = () =>
      isToolAllowedByAllowlist(input.toolConstraints?.() ?? [], NARRATE_TOOL_NAME);
    const thread = String(input.scopeId);
    const port: MediaToolHostPort = {
      turn: {
        mode: input.threadKind === "work-thread" ? "work" : "code",
        hasFolder: true,
        unattended: false,
        inPlan: () => input.posture() === "refuse",
        allowed: () => profileAllows() && input.allowed(),
      },
      narration: {
        isAvailable: () =>
          profileAllows() &&
          input.posture() !== "refuse" &&
          readySynthesis(input.endpoint()) !== undefined,
        narrate: async ({ text, relativePath, format, signal }): Promise<MediaNarrationOutcome> => {
          const allowed = () =>
            signal?.aborted !== true &&
            profileAllows() &&
            input.posture() !== "refuse" &&
            input.allowed();
          if (input.posture() === "refuse") {
            return { status: "refused", reason: "Plan mode cannot create audio files." };
          }
          if (!allowed()) {
            return { status: "refused", reason: "Narration is unavailable for this turn." };
          }

          const ready = readySynthesis(input.endpoint());
          if (ready === undefined) {
            return {
              status: "refused",
              reason: "Configure a text-to-speech endpoint and voice in Voice settings.",
            };
          }
          const target = destination(ready);
          const root = await input.root();
          if (root === undefined || !allowed()) {
            return { status: "refused", reason: "The turn no longer has access to this folder." };
          }
          // Pin the physical folder identity before asking so replacing the
          // directory at the same path while approval waits fails closed.
          const rootStillSame = threadWorkingDirectoryCurrent(root, root);
          if (!rootStillSame()) {
            return { status: "refused", reason: "The turn no longer has access to this folder." };
          }

          const precheck = await checkConfinedNewFileUnder({ root, relativePath });
          if (precheck.status !== "ok") return { status: "refused", reason: precheck.reason };

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
          if (posture === "refuse") {
            return { status: "refused", reason: "Plan mode cannot create audio files." };
          }
          if (!(await current(true))) {
            return {
              status: "refused",
              reason: "The folder, access or Voice destination changed.",
            };
          }

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
              ...(signal === undefined ? {} : { signal }),
              stamp: (offerId, requestedAt) =>
                decodeNarrationOffer({
                  kind: "narrate",
                  offerId,
                  requestedAt,
                  threadKind: input.threadKind,
                  scopeId: input.scopeId,
                  excerpt: makeExcerpt(text),
                  characters: text.length,
                  relativePath,
                  voice: ready.voice,
                  endpointName: ready.instance.displayName.slice(0, 120).trimEnd(),
                  modelId: ready.modelId,
                  format,
                  canRemember,
                }),
            });
            if (answer.status !== "narrate") {
              return {
                status: "refused",
                reason:
                  answer.status === "too-many-waiting"
                    ? "Too many offers are waiting."
                    : "Narration was not approved.",
              };
            }
            cardApproved = true;
            remember = canRemember && answer.rememberForThread;
          }

          if (!(await current(cardApproved))) {
            return {
              status: "refused",
              reason: "The folder, access or Voice destination changed.",
            };
          }

          const release = input.gates.synthesis.tryAcquire("shared");
          if (!release) {
            return { status: "busy", reason: "Text to speech is busy; try again shortly." };
          }
          try {
            const stillClear = await checkConfinedNewFileUnder({
              root,
              relativePath,
              expectedRootIdentity: precheck.rootIdentity,
            });
            if (stillClear.status !== "ok") return { status: "refused", reason: stillClear.reason };
            if (!(await current(cardApproved))) {
              return {
                status: "refused",
                reason: "The folder, access or Voice destination changed.",
              };
            }
            if (remember && input.posture() === "allow") {
              this.#consent.set(thread, { target, windowId: input.windowId });
            }

            const result = await input.adapter(ready).synthesize({
              text,
              modelId: ready.modelId,
              voice: ready.voice,
              format,
              ...(signal === undefined ? {} : { signal }),
            });
            if (!(await current(cardApproved))) {
              return {
                status: "refused",
                reason: "The folder, access or Voice destination changed.",
              };
            }
            if (result.status === "failed") {
              return { status: "failed", reason: result.providerFailure.message };
            }
            if (
              result.bytes.byteLength === 0 ||
              result.bytes.byteLength > SPEECH_SYNTHESIS_MAX_AUDIO_BYTES
            ) {
              return {
                status: "failed",
                reason:
                  result.bytes.byteLength === 0
                    ? "The provider returned no audio."
                    : "The synthesized audio exceeded the 10 MiB limit.",
              };
            }
            if (!matchesSpeechSynthesisFormat(result.bytes, format)) {
              return {
                status: "failed",
                reason: `The provider returned audio that does not match the requested ${format} format.`,
              };
            }

            const saved = await writeConfinedNewFileUnder({
              root,
              relativePath,
              bytes: result.bytes,
              expectedRootIdentity: precheck.rootIdentity,
              current: () =>
                rootStillSame() && allowed() && (cardApproved || input.posture() === "allow"),
            });
            if (saved.status !== "saved") {
              return saved.status === "refused"
                ? { status: "refused", reason: saved.reason }
                : { status: "failed", reason: saved.reason };
            }
            return {
              status: "saved",
              relativePath: saved.relativePath,
              bytes: result.bytes.byteLength,
            };
          } finally {
            release();
          }
        },
      },
    };
    const tools = NARRATE_MEDIA_TOOL_PLUGIN.createTools(port);
    if (tools === undefined) return undefined;
    return adaptMediaToolSet({ tools });
  }
}

function makeExcerpt(text: string): string {
  let end = Math.min(text.length, 300);
  // Keep UTF-16 surrogate pairs intact at the 300-character preview boundary.
  if (end < text.length && (text.codePointAt(end - 1) ?? 0) > 0xffff) end--;
  return text.slice(0, end).trimEnd();
}
