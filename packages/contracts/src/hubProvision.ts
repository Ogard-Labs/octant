import { Schema } from "effect";
import { AppReleaseRing, AppUpdateFeed } from "./appUpdates";
import { AutomationThreadMode, AutomationTrigger } from "./automation";
import { UtcTimestamp } from "./events";
import { ExtensionContentDigest } from "./extensionIdentity";
import { ExtensionCatalogEntryId, ExtensionCatalogId } from "./extensions";
import { HubMemberId } from "./hubAndSpokes";
import { OctantMode } from "./modes";
import {
  OpenAiCompatibleProtocol,
  PermissionPersistence,
  ProviderExecutionPolicy,
  ProviderModelId,
  AnthropicCompatibleProtocol,
} from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Text that looks like a credential: a provider key prefix, a bearer header, or
 * a private-key block. An offer is configuration and carries no secret, so the
 * schema refuses such text in every free-text field. It is a floor under the
 * strict field lists, not the main defence: the main defence is that no offer
 * has a field a secret could occupy.
 */
const SECRET_SHAPE =
  /(?:\bsk-[A-Za-z0-9_-]{16,}|\bsk-ant-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{16,})/;

export function looksLikeSecret(text: string): boolean {
  return SECRET_SHAPE.test(text);
}

const offeredText = (maxLength: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(maxLength),
    Schema.filter((value) => !looksLikeSecret(value), {
      message: () => "An offer carries no secret.",
    }),
  );

/**
 * An endpoint address the offer may name: https, a host, and nothing a key
 * could ride in (no user, password, query, or fragment).
 */
export const OfferedEndpointUrl = Schema.String.pipe(
  Schema.maxLength(2_048),
  Schema.filter(
    (value) => {
      try {
        const parsed = new URL(value);
        return (
          parsed.protocol === "https:" &&
          parsed.hostname !== "" &&
          parsed.username === "" &&
          parsed.password === "" &&
          parsed.search === "" &&
          parsed.hash === ""
        );
      } catch {
        return false;
      }
    },
    { message: () => "An offered endpoint is an https address with no credentials in it." },
  ),
);

/** One offer the hub made; the spoke's proposal and the hub's record share its id. */
export const HubOfferId = Schema.UUID.pipe(Schema.brand("HubOfferId"));
export type HubOfferId = typeof HubOfferId.Type;

export const HUB_OFFER_KINDS = [
  "update-channel",
  "plugin",
  "agent-profile",
  "model-endpoint",
  "routine",
] as const;
export const HubOfferKind = Schema.Literal(...HUB_OFFER_KINDS);
export type HubOfferKind = typeof HubOfferKind.Type;

/**
 * The kinds a spoke's person may let apply without asking (decision H5). A
 * routine and an endpoint row always ask.
 */
export const HUB_AUTO_APPLY_KINDS = ["update-channel", "plugin", "agent-profile"] as const;
export const HubAutoApplyKind = Schema.Literal(...HUB_AUTO_APPLY_KINDS);
export type HubAutoApplyKind = typeof HubAutoApplyKind.Type;

/**
 * Follow a release ring. `mirror` says the hub also serves a copy of the
 * signed feed document; the spoke fetches it and checks the feed's own
 * signature, which is the trust root, never the hub.
 */
export const UpdateChannelOffer = Schema.Struct({
  kind: Schema.Literal("update-channel"),
  channel: AppReleaseRing,
  mirror: Schema.optional(Schema.Literal(true)),
}).annotations(strict);
export type UpdateChannelOffer = typeof UpdateChannelOffer.Type;

/** A package from the catalog the spoke already lists, by reference; its bytes come the ordinary way. */
export const PluginOffer = Schema.Struct({
  kind: Schema.Literal("plugin"),
  catalogId: ExtensionCatalogId,
  entryId: ExtensionCatalogEntryId,
  expectedDigest: ExtensionContentDigest,
}).annotations(strict);
export type PluginOffer = typeof PluginOffer.Type;

/** A profile without an id, a scope, or a secret: the spoke makes the id and owns the scope. */
export const AgentProfileOffer = Schema.Struct({
  kind: Schema.Literal("agent-profile"),
  displayName: offeredText(255),
  description: Schema.optional(offeredText(2_048)),
  // Smaller than a profile a person writes: an offer travels in one member-link body.
  instructions: Schema.optional(offeredText(16_384)),
  approvedSkillIds: Schema.Array(offeredText(128)).pipe(Schema.maxItems(64)),
  toolConstraints: Schema.Array(offeredText(128)).pipe(Schema.maxItems(64)),
  modelConstraints: Schema.Array(ProviderModelId).pipe(Schema.maxItems(64)),
  defaultExecutionPolicy: ProviderExecutionPolicy,
  defaultPermissionPersistence: PermissionPersistence,
  compatibleModes: Schema.Array(OctantMode).pipe(Schema.maxItems(8)),
}).annotations(strict);
export type AgentProfileOffer = typeof AgentProfileOffer.Type;

const manualModelIds = Schema.Array(ProviderModelId).pipe(
  Schema.maxItems(64),
  Schema.filter((ids) => new Set(ids).size === ids.length, {
    message: () => "Model ids do not repeat.",
  }),
);

/**
 * A model endpoint row. It has no key field and no way to name a header, so
 * there is nowhere for a secret to ride; `authentication: "key"` says the row
 * will want a key the person adds on the spoke, and `"none"` that it takes none.
 */
export const ModelEndpointOffer = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("model-endpoint"),
    family: Schema.Literal("openai-compatible"),
    displayName: offeredText(255),
    baseUrl: OfferedEndpointUrl,
    protocol: OpenAiCompatibleProtocol,
    authentication: Schema.Literal("key", "none"),
    manualModelIds,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("model-endpoint"),
    family: Schema.Literal("anthropic-compatible"),
    displayName: offeredText(255),
    baseUrl: OfferedEndpointUrl,
    protocol: AnthropicCompatibleProtocol,
    authentication: Schema.Literal("key", "none"),
    manualModelIds,
  }).annotations(strict),
);
export type ModelEndpointOffer = typeof ModelEndpointOffer.Type;

/**
 * A routine's name, task, and schedule. It names no Project, host, profile, or
 * authority: the spoke binds it to a Project of its own choosing and gives it
 * its own ceiling when its person applies it.
 */
export const RoutineOffer = Schema.Struct({
  kind: Schema.Literal("routine"),
  displayName: offeredText(160),
  taskPrompt: offeredText(16_384),
  mode: AutomationThreadMode,
  trigger: AutomationTrigger,
}).annotations(strict);
export type RoutineOffer = typeof RoutineOffer.Type;

export const HubOfferBody = Schema.Union(
  UpdateChannelOffer,
  PluginOffer,
  AgentProfileOffer,
  ModelEndpointOffer,
  RoutineOffer,
);
export type HubOfferBody = typeof HubOfferBody.Type;
export const decodeHubOfferBody = Schema.decodeUnknownSync(HubOfferBody);

/** What the hub sends a spoke: the offer, with the id both sides keep it under. */
export const HubOfferDelivery = Schema.Struct({
  offerId: HubOfferId,
  offer: HubOfferBody,
}).annotations(strict);
export type HubOfferDelivery = typeof HubOfferDelivery.Type;
export const decodeHubOfferDelivery = Schema.decodeUnknownSync(HubOfferDelivery);

/** What the spoke asks the hub for when an update-channel offer says it has a mirror. */
export const HubMirrorRequest = Schema.Struct({ offerId: HubOfferId }).annotations(strict);
export type HubMirrorRequest = typeof HubMirrorRequest.Type;
export const decodeHubMirrorRequest = Schema.decodeUnknownSync(HubMirrorRequest);

/**
 * Why an offer, a proposal, or an apply came to nothing. The journal keeps this
 * word, never an offer's text.
 */
export const HubProvisionReason = Schema.Literal(
  "provision-service-off",
  "hub-role-off",
  "provision-not-granted",
  "kind-unsupported",
  "channel-not-allowed",
  "widens-authority",
  "proposals-full",
  "duplicate",
  "malformed",
  "expired",
  "unknown-offer",
  "needs-person",
  "mirror-unreachable",
  "mirror-untrusted",
  "mirror-unverifiable",
  "apply-failed",
  "answer-refused",
);
export type HubProvisionReason = typeof HubProvisionReason.Type;

export const HubProvisionMode = Schema.Literal("manual", "auto");
export type HubProvisionMode = typeof HubProvisionMode.Type;

/** How the hub's last attempt to hand one spoke one offer ended. */
export const HubOfferDeliveryResult = Schema.Literal("proposed", "refused", "unreachable");
export type HubOfferDeliveryResult = typeof HubOfferDeliveryResult.Type;

/** The person on the hub turning the offer switch on or off. */
export const HubProvisionSwitchRequest = Schema.Struct({ enabled: Schema.Boolean }).annotations(
  strict,
);
export type HubProvisionSwitchRequest = typeof HubProvisionSwitchRequest.Type;
export const decodeHubProvisionSwitchRequest = Schema.decodeUnknownSync(HubProvisionSwitchRequest);

/** The person on the hub making an offer; `memberIds` names the spokes, and absent means every spoke. */
export const HubOfferRequest = Schema.Struct({
  offer: HubOfferBody,
  /** The signed update feed document to mirror; only for an update-channel offer that says `mirror`. */
  mirrorFeed: Schema.optional(AppUpdateFeed),
  memberIds: Schema.optional(Schema.Array(HubMemberId).pipe(Schema.maxItems(256))),
}).annotations(strict);
export type HubOfferRequest = typeof HubOfferRequest.Type;
export const decodeHubOfferRequest = Schema.decodeUnknownSync(HubOfferRequest);

export const HubOfferWithdrawRequest = Schema.Struct({ offerId: HubOfferId }).annotations(strict);
export type HubOfferWithdrawRequest = typeof HubOfferWithdrawRequest.Type;
export const decodeHubOfferWithdrawRequest = Schema.decodeUnknownSync(HubOfferWithdrawRequest);

/** The person on a spoke applying or dismissing one proposal. A routine names the Project it binds to. */
export const HubProposalDecisionRequest = Schema.Struct({
  offerId: HubOfferId,
  projectId: Schema.optional(Schema.UUID),
}).annotations(strict);
export type HubProposalDecisionRequest = typeof HubProposalDecisionRequest.Type;
export const decodeHubProposalDecisionRequest = Schema.decodeUnknownSync(
  HubProposalDecisionRequest,
);

export const HubAutoApplyRequest = Schema.Struct({
  kind: HubAutoApplyKind,
  enabled: Schema.Boolean,
}).annotations(strict);
export type HubAutoApplyRequest = typeof HubAutoApplyRequest.Type;
export const decodeHubAutoApplyRequest = Schema.decodeUnknownSync(HubAutoApplyRequest);

/** A proposal as Settings shows it. */
export const HubProposalView = Schema.Struct({
  offerId: HubOfferId,
  offer: HubOfferBody,
  receivedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
}).annotations(strict);
export type HubProposalView = typeof HubProposalView.Type;
