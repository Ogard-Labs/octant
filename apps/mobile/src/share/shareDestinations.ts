import {
  MOBILE_ATTACHMENT_MAX_BYTES,
  mobileAttachmentOffer,
  RESTRICTED_REMOTE_SESSION,
  type MobileAttachmentMode,
  type MobileInboxRow,
  type MobileModelOption,
  type MobileRemoteTransport,
  type RemoteSessionStanding,
} from "@octant/client-runtime";
import { presentStaleHostSecurity } from "@octant/domain";
import { MOBILE_COPY } from "../copy";
import type { MobileHostRegistration } from "../hosts/HostRegistry";
import type { MobileHostHealth } from "../session/MobileHostSessionHub";
import { SHARE_TURN_ATTACHMENT_LIMITS } from "./shareManifest";
import {
  SHARE_REFUSAL_MESSAGES,
  type ValidatedStagedAttachment,
  type ValidatedStagedShare,
} from "./shareValidation";

/**
 * Every destination the "Send to…" sheet can route shared items into.
 * Bots share the same union from the start so the bots work only supplies rows.
 */
export type ShareDestination =
  | {
      readonly kind: "new-chat";
      readonly hostId: string;
      readonly title: string;
    }
  | {
      readonly kind: "thread";
      readonly hostId: string;
      readonly mode: "chat" | "work" | "code";
      readonly threadId: string;
      readonly title: string;
      readonly projectName?: string | undefined;
      readonly row: MobileInboxRow;
    }
  | {
      readonly kind: "bot";
      readonly hostId: string;
      readonly botId: string;
      readonly title: string;
      readonly subtitle?: string | undefined;
    };

export interface ShareBotRow {
  readonly hostId: string;
  readonly botId: string;
  readonly title: string;
  readonly subtitle?: string | undefined;
}

export interface ShareHostOption {
  readonly hostId: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly disabledReason?: string | undefined;
}

export function evaluateShareHost(input: {
  readonly host: Pick<MobileHostRegistration, "hostId" | "label">;
  readonly health: MobileHostHealth | undefined;
  readonly transport: MobileRemoteTransport | undefined;
  readonly standing: RemoteSessionStanding | undefined;
}): ShareHostOption {
  const kind = input.health?.kind ?? "idle";
  const staleGate = presentStaleHostSecurity(kind);
  if (kind === "unauthorized") {
    return {
      hostId: input.host.hostId,
      label: input.host.label,
      enabled: false,
      disabledReason: MOBILE_COPY.shareComputerUnauthorized,
    };
  }
  if (kind === "stale") {
    return {
      hostId: input.host.hostId,
      label: input.host.label,
      enabled: false,
      disabledReason: MOBILE_COPY.shareComputerStale,
    };
  }
  if (!staleGate.allowProductMutations || input.transport === undefined) {
    return {
      hostId: input.host.hostId,
      label: input.host.label,
      enabled: false,
      disabledReason: MOBILE_COPY.shareComputerUnreachable,
    };
  }
  if (input.standing === RESTRICTED_REMOTE_SESSION) {
    return {
      hostId: input.host.hostId,
      label: input.host.label,
      enabled: false,
      disabledReason: MOBILE_COPY.shareComputerAccessUnconfirmed,
    };
  }
  if (input.standing?.accessLevel === "read-only") {
    return {
      hostId: input.host.hostId,
      label: input.host.label,
      enabled: false,
      disabledReason: MOBILE_COPY.shareComputerRestricted,
    };
  }
  return {
    hostId: input.host.hostId,
    label: input.host.label,
    enabled: true,
  };
}

export function evaluateShareHosts(input: {
  readonly hosts: ReadonlyArray<Pick<MobileHostRegistration, "hostId" | "label">>;
  readonly health: ReadonlyArray<MobileHostHealth>;
  readonly transportForHost: (hostId: string) => MobileRemoteTransport | undefined;
  readonly standingForHost: (hostId: string) => RemoteSessionStanding | undefined;
}): ReadonlyArray<ShareHostOption> {
  return input.hosts.map((host) =>
    evaluateShareHost({
      host,
      health: input.health.find((entry) => entry.hostId === host.hostId),
      transport: input.transportForHost(host.hostId),
      standing: input.standingForHost(host.hostId),
    }),
  );
}

/**
 * Lists destinations on one paired computer: New chat first, then threads the
 * session may send to, then any bots. Search filters across loaded titles of
 * all kinds.
 */
export function listShareDestinations(input: {
  readonly hostId: string;
  readonly rows: ReadonlyArray<MobileInboxRow>;
  readonly bots?: ReadonlyArray<ShareBotRow> | undefined;
  readonly projectName?: ((row: MobileInboxRow) => string | undefined) | undefined;
  readonly query: string;
}): ReadonlyArray<ShareDestination> {
  const all: ShareDestination[] = [
    { kind: "new-chat", hostId: input.hostId, title: MOBILE_COPY.shareNewChat },
  ];
  for (const row of input.rows) {
    if (row.hostId !== input.hostId) continue;
    const project = input.projectName?.(row);
    all.push({
      kind: "thread",
      hostId: row.hostId,
      mode: row.mode,
      threadId: row.threadId,
      title: row.title,
      ...(project === undefined ? {} : { projectName: project }),
      row,
    });
  }
  for (const bot of input.bots ?? []) {
    if (bot.hostId !== input.hostId) continue;
    all.push({
      kind: "bot",
      hostId: bot.hostId,
      botId: bot.botId,
      title: bot.title,
      ...(bot.subtitle === undefined ? {} : { subtitle: bot.subtitle }),
    });
  }
  const needle = input.query.trim().toLowerCase();
  if (needle.length === 0) return all;
  return all.filter((destination) => {
    if (destination.title.toLowerCase().includes(needle)) return true;
    if (
      destination.kind === "thread" &&
      destination.projectName !== undefined &&
      destination.projectName.toLowerCase().includes(needle)
    ) {
      return true;
    }
    if (
      destination.kind === "bot" &&
      destination.subtitle !== undefined &&
      destination.subtitle.toLowerCase().includes(needle)
    ) {
      return true;
    }
    return false;
  });
}

export type ShareDestinationMapping =
  | {
      readonly status: "ready";
      readonly text: string;
      readonly attachments: ReadonlyArray<ValidatedStagedAttachment>;
    }
  | { readonly status: "refused"; readonly reason: string };

/**
 * Maps a validated staged share onto a target thread mode (or New chat) and
 * refuses items the target cannot accept (uncleanable image, >10 MiB, empty,
 * over turn attachment limit, or a model that takes no attachments).
 */
export function mapShareForDestination(input: {
  readonly share: ValidatedStagedShare;
  readonly mode: MobileAttachmentMode;
  readonly model?: MobileModelOption | undefined;
  readonly existingPendingCount?: number | undefined;
}): ShareDestinationMapping {
  const { share, mode, model, existingPendingCount = 0 } = input;
  if (share.refusal !== undefined) {
    return { status: "refused", reason: share.refusal.message };
  }
  const limit = SHARE_TURN_ATTACHMENT_LIMITS[mode];
  if (share.attachments.length + existingPendingCount > limit) {
    return { status: "refused", reason: MOBILE_COPY.attachLimit(limit) };
  }
  for (const attachment of share.attachments) {
    if (attachment.bytes.byteLength === 0) {
      return { status: "refused", reason: SHARE_REFUSAL_MESSAGES.empty };
    }
    if (attachment.bytes.byteLength > MOBILE_ATTACHMENT_MAX_BYTES) {
      return { status: "refused", reason: SHARE_REFUSAL_MESSAGES.tooLarge };
    }
  }
  if (share.attachments.length > 0 && model !== undefined) {
    const offer = mobileAttachmentOffer(mode, model);
    if (offer.sources.length === 0) {
      return { status: "refused", reason: MOBILE_COPY.shareModelNoAttachments };
    }
    const hasImage = share.attachments.some((item) => item.kind === "image");
    if (hasImage && !offer.sources.includes("library")) {
      return { status: "refused", reason: MOBILE_COPY.shareModelNoImages };
    }
  }
  return {
    status: "ready",
    text: share.textParts.join("\n\n"),
    attachments: share.attachments,
  };
}

/** Joins shared text onto an existing composer draft without losing what the person already wrote. */
export function combineComposerWithSharedText(existingDraft: string, sharedText: string): string {
  const shared = sharedText.trim();
  if (shared.length === 0) return existingDraft;
  if (existingDraft.trim().length === 0) return shared;
  return `${existingDraft.trimEnd()}\n\n${shared}`;
}
