import { Schema } from "effect";
import { ChatThreadId } from "./chat";
import { UtcTimestamp } from "./events";
import { ImageInputCapability, ProviderInstanceId, ProviderModelId } from "./providers";
import { SettingsDeepLink } from "./settings";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * One provider/model pair a Navigator role is pinned to. Selecting a pair
 * configures nothing about the provider itself: credentials, activation, and
 * capability honesty stay with the provider registry, and every send still
 * fails closed at execution time.
 */
export const NavigatorAssistantModelRef = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
}).annotations(strict);
export type NavigatorAssistantModelRef = typeof NavigatorAssistantModelRef.Type;

/**
 * Navigator settings section.
 *
 * `defaultProvider` is the model Navigator converses with. Absent means
 * Navigator reports itself unavailable with a settings deep link — never a
 * silent fallback to some other configured model.
 *
 * `visionReviewer` is consulted only when the default model cannot read
 * images: it reviews the image and returns text into the primary model's
 * conversation, and never becomes the conversation model.
 */
export const NavigatorAssistantSettings = Schema.Struct({
  defaultProvider: Schema.optional(NavigatorAssistantModelRef),
  visionReviewer: Schema.optional(NavigatorAssistantModelRef),
}).annotations(strict);
export type NavigatorAssistantSettings = typeof NavigatorAssistantSettings.Type;

/**
 * One message of the host-owned Navigator conversation, folded by the server
 * the way every other Navigator fact is: a renderer never reconstructs a turn.
 */
export const NavigatorAssistantTranscriptMessage = Schema.Struct({
  role: Schema.Literal("user", "assistant"),
  text: Schema.String,
  createdAt: UtcTimestamp,
}).annotations(strict);
export type NavigatorAssistantTranscriptMessage = typeof NavigatorAssistantTranscriptMessage.Type;

/**
 * Server-owned Navigator snapshot.
 *
 * `status` is honest readiness: `unconfigured` means no default model is set,
 * and `settingsTarget` names the exact Settings destination that fixes it.
 * `threadId` is the one host-owned Navigator conversation once it has been
 * lazily created; the thread stays hidden from every thread listing.
 * `transcript` is that same conversation, so every Navigator surface reads one
 * conversation rather than keeping its own; it is empty until the conversation
 * exists, which is not the same fact as Navigator being unconfigured.
 * `imageInput` reports the configured default model's image capability as the
 * host currently knows it — `unknown` is not `supported`.
 */
export const NavigatorAssistantSnapshot = Schema.Struct({
  status: Schema.Literal("ready", "unconfigured"),
  settingsTarget: SettingsDeepLink,
  threadId: Schema.NullOr(ChatThreadId),
  transcript: Schema.Array(NavigatorAssistantTranscriptMessage),
  defaultProvider: Schema.NullOr(NavigatorAssistantModelRef),
  imageInput: ImageInputCapability,
  visionReviewer: Schema.NullOr(NavigatorAssistantModelRef),
}).annotations(strict);
export type NavigatorAssistantSnapshot = typeof NavigatorAssistantSnapshot.Type;

const NavigatorAssistantPrompt = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(100_000));

/**
 * Renderer commands for the Navigator surface. `send-message` appends a user
 * turn to the host-owned Navigator conversation through the ordinary Chat
 * turn pipeline. Navigator has no mutation commands: anything that would
 * change app state must go through the existing command surfaces after the
 * user confirms it, never through this endpoint.
 */
export const NavigatorAssistantCommand = Schema.Struct({
  kind: Schema.Literal("send-message"),
  prompt: NavigatorAssistantPrompt,
}).annotations(strict);
export type NavigatorAssistantCommand = typeof NavigatorAssistantCommand.Type;

export const NavigatorAssistantCommandResult = Schema.Struct({
  kind: Schema.Literal("message-sent"),
  snapshot: NavigatorAssistantSnapshot,
}).annotations(strict);
export type NavigatorAssistantCommandResult = typeof NavigatorAssistantCommandResult.Type;

/**
 * A Navigator request the host refused. `unconfigured` carries the settings
 * deep link so the renderer can offer the exact fix instead of a dead end.
 */
export const NavigatorAssistantFailure = Schema.Struct({
  category: Schema.Literal("unconfigured", "invalid", "conflict", "unavailable"),
  message: Schema.NonEmptyTrimmedString,
  settingsTarget: Schema.optional(SettingsDeepLink),
}).annotations(strict);
export type NavigatorAssistantFailure = typeof NavigatorAssistantFailure.Type;

/**
 * The durable fact that this host bound its one Navigator conversation.
 *
 * The binding is journaled rather than held in memory or a side file because
 * losing it would strand the previous conversation: the thread stays committed
 * and hidden, and the host would mint a second one. Replaying this event
 * rebuilds the binding, so the Navigator conversation survives a restart with
 * its transcript intact. Host identity is not repeated in the payload — the
 * journal stamps `hostId` on every envelope it commits.
 */
export const NavigatorAssistantThreadBound = Schema.Struct({
  threadId: ChatThreadId,
  boundAt: UtcTimestamp,
}).annotations(strict);
export type NavigatorAssistantThreadBound = typeof NavigatorAssistantThreadBound.Type;

/** Journaled Navigator event names. Append-only wire facts; never renamed. */
export const NAVIGATOR_ASSISTANT_EVENT_NAMES = {
  threadBound: "navigator-assistant.thread-bound@1",
} as const;

export const decodeNavigatorAssistantThreadBound = Schema.decodeUnknownSync(
  NavigatorAssistantThreadBound,
);
export const decodeNavigatorAssistantModelRef = Schema.decodeUnknownSync(
  NavigatorAssistantModelRef,
);
export const decodeNavigatorAssistantSettings = Schema.decodeUnknownSync(
  NavigatorAssistantSettings,
);
export const decodeNavigatorAssistantSnapshot = Schema.decodeUnknownSync(
  NavigatorAssistantSnapshot,
);
export const decodeNavigatorAssistantCommand = Schema.decodeUnknownSync(NavigatorAssistantCommand);
export const decodeNavigatorAssistantCommandResult = Schema.decodeUnknownSync(
  NavigatorAssistantCommandResult,
);
export const decodeNavigatorAssistantFailure = Schema.decodeUnknownSync(NavigatorAssistantFailure);
