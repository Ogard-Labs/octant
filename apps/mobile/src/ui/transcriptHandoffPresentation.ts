import type { MobileModelOption, MobileProviderDirectoryEntry } from "@octant/client-runtime";
import type {
  AccountMoveTextHandoffCause,
  ChatAttemptHandoff,
  ChatThreadView,
  CodeConversationTurnHandoff,
  WorkTurnHandoff,
} from "@octant/contracts";
import { activeChatTurns } from "@octant/domain/chat-policy";

export interface MobileProviderSelection {
  readonly providerInstanceId: unknown;
  readonly modelId: unknown;
}

export type MobileTranscriptHandoffKind =
  | "context-handoff"
  | "model-switch"
  | "fork"
  | "branch"
  | "rewind";

export interface MobileHandoffEndpoint {
  readonly label: string;
  readonly fullLabel: string;
  readonly monogram?: string;
  readonly driverKind?: string;
}

export interface MobileTranscriptHandoffEntry {
  readonly kind: MobileTranscriptHandoffKind;
  readonly heading: string;
  readonly accessibleLabel: string;
  readonly route?: {
    readonly from: MobileHandoffEndpoint;
    readonly to: MobileHandoffEndpoint;
    readonly showToMark: boolean;
  };
  readonly disclosure?: string;
}

export type MobileRecordedHandoff =
  | ChatAttemptHandoff
  | WorkTurnHandoff
  | CodeConversationTurnHandoff;

export type MobileChatTranscriptAnnotation =
  | { readonly kind: "handoff"; readonly entry: MobileTranscriptHandoffEntry }
  | { readonly kind: "described-images"; readonly text: string };

export interface MobileChatTranscriptAnnotations {
  readonly beforeContentId: ReadonlyMap<string, ReadonlyArray<MobileChatTranscriptAnnotation>>;
  readonly afterContentId: ReadonlyMap<string, ReadonlyArray<MobileChatTranscriptAnnotation>>;
  readonly trailing: ReadonlyArray<MobileChatTranscriptAnnotation>;
}

const HEADING_FOR_KIND: Readonly<Record<MobileTranscriptHandoffKind, string>> = {
  "context-handoff": "Context handoff",
  "model-switch": "Model switch",
  fork: "Forked context",
  branch: "Branched context",
  rewind: "Rewound context",
};

function count(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}

function monogram(displayName: string): string {
  const words = displayName.trim().split(/\s+/);
  const first = words[0]?.[0] ?? "?";
  const second = words[1]?.[0] ?? "";
  return `${first}${second}`.toUpperCase();
}

function providerMeta(
  options: ReadonlyArray<MobileModelOption>,
  directory: ReadonlyArray<MobileProviderDirectoryEntry>,
  selection: MobileProviderSelection,
): {
  readonly modelLabel: string;
  readonly providerName?: string;
  readonly driverKind?: string;
  readonly fullLabel: string;
} {
  const instanceId = String(selection.providerInstanceId);
  const modelId = String(selection.modelId);
  // Check the full directory first so disabled or unready historical accounts
  // keep their display names instead of falling back to raw instance IDs.
  const directoryEntry = directory.find(
    (candidate) => String(candidate.providerInstanceId) === instanceId,
  );
  const directoryModel = directoryEntry?.models.find(
    (candidate) => String(candidate.modelId) === modelId,
  );
  const exactOption = options.find(
    (candidate) =>
      String(candidate.providerInstanceId) === instanceId && String(candidate.modelId) === modelId,
  );
  const providerOption =
    exactOption ?? options.find((candidate) => String(candidate.providerInstanceId) === instanceId);
  const modelLabel = directoryModel?.displayName ?? exactOption?.label ?? modelId;
  const providerName = directoryEntry?.displayName ?? providerOption?.detail;
  const driverKind = directoryEntry?.driverKind ?? providerOption?.driverKind;
  const fullLabel =
    providerName === undefined
      ? `${instanceId} — ${modelLabel}`
      : `${providerName} — ${modelLabel}`;
  return {
    modelLabel,
    ...(providerName === undefined ? {} : { providerName }),
    ...(driverKind === undefined ? {} : { driverKind }),
    fullLabel,
  };
}

interface HandoffOmissions {
  readonly earlierMessages: number;
  readonly missingBodies: number;
  readonly oversizedBodies: number;
  readonly emptyBodies: number;
  readonly unfinishedReplies: number;
  readonly attachments: number;
  readonly truncatedMessages: number;
  readonly truncatedCharacters: number;
  readonly sourceTruncatedMessages: number;
}

function omissionsDisclosure(omissions: HandoffOmissions): string {
  const left = [
    omissions.earlierMessages > 0
      ? count(omissions.earlierMessages, "earlier message", "earlier messages")
      : undefined,
    omissions.missingBodies > 0
      ? `${count(omissions.missingBodies, "message", "messages")} no longer stored`
      : undefined,
    omissions.oversizedBodies > 0
      ? `${count(omissions.oversizedBodies, "message", "messages")} too large to read`
      : undefined,
    omissions.emptyBodies > 0
      ? count(omissions.emptyBodies, "empty message", "empty messages")
      : undefined,
    omissions.unfinishedReplies > 0
      ? count(omissions.unfinishedReplies, "unfinished reply", "unfinished replies")
      : undefined,
    omissions.attachments > 0
      ? count(omissions.attachments, "attachment", "attachments")
      : undefined,
  ].filter((part): part is string => part !== undefined);
  return [
    left.length === 0 ? "" : ` Left out: ${left.join(", ")}.`,
    omissions.truncatedMessages > 0
      ? ` ${count(omissions.truncatedMessages, "message was", "messages were")} shortened by ${count(omissions.truncatedCharacters, "character", "characters")}.`
      : "",
    omissions.sourceTruncatedMessages > 0
      ? ` ${count(omissions.sourceTruncatedMessages, "message was", "messages were")} already cut short when recorded.`
      : "",
  ].join("");
}

function accountMoveTextCauseDisclosure(cause: AccountMoveTextHandoffCause | undefined): string {
  switch (cause) {
    case undefined:
      return "";
    case "provider-cannot-carry":
      return " This provider's session cannot be copied to another account.";
    case "account-unavailable":
      return " The previous account is no longer set up, so its session could not be copied.";
    case "session-not-copied":
      return " The previous account's session could not be copied safely.";
    case "session-not-adopted":
      return " The new account could not continue the copied session.";
  }
}

/**
 * Formats the host's recorded handoff disclosure using the same wording as
 * desktop and web transcripts so the phone reports omissions and taint honestly.
 */
export function formatMobileHandoffDisclosure(
  handoff: MobileRecordedHandoff,
  options: ReadonlyArray<MobileModelOption>,
  directory: ReadonlyArray<MobileProviderDirectoryEntry> = [],
): string {
  const label = (selection: MobileProviderSelection) =>
    providerMeta(options, directory, selection).fullLabel;
  switch (handoff.reason) {
    case "provider-switch": {
      const inherited = "inherited" in handoff ? handoff.inherited : undefined;
      const cause = "accountMoveTextCause" in handoff ? handoff.accountMoveTextCause : undefined;
      return [
        `Handed over ${count(handoff.messages, "recent message", "recent messages")} from ${label({
          providerInstanceId: handoff.previousProviderInstanceId,
          modelId: handoff.previousModelId,
        })} as text.`,
        inherited === undefined
          ? ""
          : ` ${count(inherited.messages, "of them comes", "of them come")} from the conversation this was forked from, up to the reply it was forked from.`,
        omissionsDisclosure(handoff.omissions),
        handoff.externalContentIngested ? " This thread has taken in outside content." : "",
        inherited?.externalContentIngested === true
          ? " The thread it was forked from has taken in outside content."
          : "",
        " Hidden reasoning, tool activity and the previous session did not transfer.",
        accountMoveTextCauseDisclosure(cause),
      ].join("");
    }
    case "account-move":
    case "account-move-native-session":
      return `Moved from ${label({
        providerInstanceId: handoff.previousProviderInstanceId,
        modelId: handoff.previousModelId,
      })}. The provider's own session was copied into this account and continued, with its messages and tool activity.`;
    case "fork": {
      const sourceTaint = "forkedFrom" in handoff;
      return [
        `Forked with ${count(handoff.messages, "recent message", "recent messages")} of the source conversation as text, up to the reply it was forked from.`,
        omissionsDisclosure(handoff.omissions),
        handoff.externalContentIngested
          ? sourceTaint
            ? " The source thread has taken in outside content."
            : " This thread has taken in outside content."
          : "",
        " Hidden reasoning, tool activity, the source's session and its later replies did not transfer.",
      ].join("");
    }
    case "fork-native-session":
      return "Forked by continuing the source's own session up to the reply it was forked from, with its messages and tool activity. The source's later replies did not transfer.";
    case "branch":
      return [
        `Branched with ${count(handoff.messages, "recent message", "recent messages")} of the original conversation as text, up to the reply it was branched from.`,
        omissionsDisclosure(handoff.omissions),
        handoff.externalContentIngested ? " The original thread has taken in outside content." : "",
        " Hidden reasoning, tool activity, the original session and its later replies did not transfer.",
      ].join("");
    case "rewind": {
      const inherited = "inherited" in handoff ? handoff.inherited : undefined;
      return [
        `After the rewind, a fresh session started with ${count(handoff.messages, "recent message", "recent messages")} of the kept conversation as text.`,
        inherited === undefined
          ? ""
          : ` ${count(inherited.messages, "of them comes", "of them come")} from the conversation this was forked from, up to the reply it was forked from.`,
        omissionsDisclosure(handoff.omissions),
        handoff.externalContentIngested ? " This thread has taken in outside content." : "",
        " The removed turns, hidden reasoning, tool activity and the previous session did not transfer.",
      ].join("");
    }
    case "rewind-native-session":
      return "After the rewind, the provider continued its own session cut back to the last kept reply, with its messages and tool activity. The removed turns did not transfer.";
  }
}

/**
 * Classifies a boundary between turns or attempts for the phone's Chat, Work,
 * and Code transcripts, mirroring desktop `resolveTranscriptHandoff`.
 */
export function resolveMobileTranscriptHandoff(input: {
  readonly previous?: MobileProviderSelection | undefined;
  readonly current?: MobileProviderSelection | undefined;
  readonly handoff?: MobileRecordedHandoff | undefined;
  readonly modelOptions: ReadonlyArray<MobileModelOption>;
  readonly providerDirectory?: ReadonlyArray<MobileProviderDirectoryEntry> | undefined;
}): MobileTranscriptHandoffEntry | undefined {
  const directory = input.providerDirectory ?? [];
  // Prefer a recorded source pair over the adjacent selection so repeated
  // handoffs after a stopped turn still show the true origin.
  const recordedFrom =
    input.handoff !== undefined &&
    "previousProviderInstanceId" in input.handoff &&
    "previousModelId" in input.handoff
      ? {
          providerInstanceId: input.handoff.previousProviderInstanceId,
          modelId: input.handoff.previousModelId,
        }
      : undefined;
  const from = recordedFrom ?? input.previous;
  const to = input.current;
  const providerChanged =
    from !== undefined &&
    to !== undefined &&
    String(from.providerInstanceId) !== String(to.providerInstanceId);
  const modelChanged =
    from !== undefined &&
    to !== undefined &&
    String(from.providerInstanceId) === String(to.providerInstanceId) &&
    String(from.modelId) !== String(to.modelId);
  const reason = input.handoff?.reason;

  // Explicit recorded reasons take precedence over inferred endpoint changes so
  // a text fork, branch, or rewind onto another model never reads as a model switch.
  let kind: MobileTranscriptHandoffKind | undefined;
  if (
    reason === "provider-switch" ||
    reason === "account-move" ||
    reason === "account-move-native-session"
  ) {
    kind = "context-handoff";
  } else if (reason === "fork" || reason === "fork-native-session") {
    kind = "fork";
  } else if (reason === "branch") {
    kind = "branch";
  } else if (reason === "rewind" || reason === "rewind-native-session") {
    kind = "rewind";
  } else if (providerChanged) {
    kind = "context-handoff";
  } else if (modelChanged) {
    kind = "model-switch";
  }

  if (kind === undefined) return undefined;
  const heading = HEADING_FOR_KIND[kind];
  const disclosure =
    input.handoff === undefined
      ? undefined
      : formatMobileHandoffDisclosure(input.handoff, input.modelOptions, directory);

  if (from === undefined || to === undefined || (!providerChanged && !modelChanged)) {
    return {
      kind,
      heading,
      accessibleLabel: heading,
      ...(disclosure === undefined ? {} : { disclosure }),
    };
  }

  const fromMeta = providerMeta(input.modelOptions, directory, from);
  const toMeta = providerMeta(input.modelOptions, directory, to);
  const differentInstance = String(from.providerInstanceId) !== String(to.providerInstanceId);
  const disambiguateAccount = differentInstance && fromMeta.modelLabel === toMeta.modelLabel;
  const fromLabel =
    disambiguateAccount && fromMeta.providerName !== undefined
      ? `${fromMeta.providerName} · ${fromMeta.modelLabel}`
      : fromMeta.modelLabel;
  const toLabel =
    disambiguateAccount && toMeta.providerName !== undefined
      ? `${toMeta.providerName} · ${toMeta.modelLabel}`
      : toMeta.modelLabel;

  const accessibleLabel = differentInstance
    ? `${heading} from ${fromMeta.fullLabel} to ${toMeta.fullLabel}`
    : `${heading} from ${fromLabel} to ${toLabel}`;

  return {
    kind,
    heading,
    accessibleLabel,
    route: {
      from: {
        label: fromLabel,
        fullLabel: fromMeta.fullLabel,
        ...(fromMeta.providerName === undefined
          ? {}
          : { monogram: monogram(fromMeta.providerName) }),
        ...(fromMeta.driverKind === undefined ? {} : { driverKind: fromMeta.driverKind }),
      },
      to: {
        label: toLabel,
        fullLabel: toMeta.fullLabel,
        ...(toMeta.providerName === undefined ? {} : { monogram: monogram(toMeta.providerName) }),
        ...(toMeta.driverKind === undefined ? {} : { driverKind: toMeta.driverKind }),
      },
      showToMark: differentInstance,
    },
    ...(disclosure === undefined ? {} : { disclosure }),
  };
}

function appendAnnotation(
  map: Map<string, MobileChatTranscriptAnnotation[]>,
  key: string,
  annotation: MobileChatTranscriptAnnotation,
): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, [annotation]);
    return;
  }
  existing.push(annotation);
}

/**
 * Places each Chat handoff divider and Sees images attribution note in strict
 * attempt order: turn-to-turn transitions ahead of the turn's user message,
 * reply-bearing retries and image notes ahead of that attempt's first reply,
 * and replyless attempts immediately after the preceding visible message in the
 * same turn so earlier image attributions never cross a later retry's handoff.
 */
export function mobileChatTranscriptAnnotations(
  view: ChatThreadView,
  modelOptions: ReadonlyArray<MobileModelOption>,
  providerDirectory: ReadonlyArray<MobileProviderDirectoryEntry> = [],
  shownContentIds?: ReadonlySet<string>,
): MobileChatTranscriptAnnotations {
  const beforeContentId = new Map<string, MobileChatTranscriptAnnotation[]>();
  const afterContentId = new Map<string, MobileChatTranscriptAnnotation[]>();
  const trailing: MobileChatTranscriptAnnotation[] = [];
  const visibleIds =
    shownContentIds ?? new Set(view.contents.map((content) => String(content.contentId)));
  const placeForAttempt = (
    firstVisibleReply: string | undefined,
    lastVisibleAnchor: string | undefined,
    item: MobileChatTranscriptAnnotation,
  ) => {
    if (firstVisibleReply !== undefined) {
      appendAnnotation(beforeContentId, firstVisibleReply, item);
    } else if (lastVisibleAnchor !== undefined) {
      appendAnnotation(afterContentId, lastVisibleAnchor, item);
    } else {
      trailing.push(item);
    }
  };
  const turns = activeChatTurns(view.turns);
  let previousTurnAttempt: ChatThreadView["turns"][number]["attempts"][number] | undefined;

  for (const turn of turns) {
    const userContentId = String(turn.userMessageRef.contentId);
    let lastVisibleAnchor: string | undefined = visibleIds.has(userContentId)
      ? userContentId
      : undefined;

    for (let index = 0; index < turn.attempts.length; index += 1) {
      const attempt = turn.attempts[index];
      if (attempt === undefined) continue;
      const firstVisibleReply = attempt.responseRefs
        .map((ref) => String(ref.contentId))
        .find((id) => visibleIds.has(id));
      const handoffEntry = resolveMobileTranscriptHandoff({
        previous: index === 0 ? previousTurnAttempt : turn.attempts[index - 1],
        current: attempt,
        handoff: attempt.handoff,
        modelOptions,
        providerDirectory,
      });
      if (handoffEntry !== undefined) {
        if (index === 0) {
          if (visibleIds.has(userContentId)) {
            appendAnnotation(beforeContentId, userContentId, {
              kind: "handoff",
              entry: handoffEntry,
            });
          } else {
            trailing.push({ kind: "handoff", entry: handoffEntry });
          }
        } else {
          placeForAttempt(firstVisibleReply, lastVisibleAnchor, {
            kind: "handoff",
            entry: handoffEntry,
          });
        }
      }
      if (attempt.describedImages !== undefined && attempt.describedImages.length > 0) {
        const text = attempt.describedImages
          .map(
            (image) =>
              `${image.name} described by ${image.describedBy.model} (${image.describedBy.provider})`,
          )
          .join(" · ");
        placeForAttempt(firstVisibleReply, lastVisibleAnchor, {
          kind: "described-images",
          text,
        });
      }
      for (const ref of attempt.responseRefs) {
        const id = String(ref.contentId);
        if (visibleIds.has(id)) lastVisibleAnchor = id;
      }
      if (attempt.researchRef !== undefined) {
        const researchId = String(attempt.researchRef.contentId);
        if (visibleIds.has(researchId)) lastVisibleAnchor = researchId;
      }
    }

    const latest = turn.attempts.at(-1);
    if (latest !== undefined) previousTurnAttempt = latest;
  }

  return { beforeContentId, afterContentId, trailing };
}
