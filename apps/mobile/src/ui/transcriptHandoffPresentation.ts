import type { MobileModelOption } from "@octant/client-runtime";
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
  selection: MobileProviderSelection,
): {
  readonly modelLabel: string;
  readonly providerName?: string;
  readonly driverKind?: string;
  readonly fullLabel: string;
} {
  const instanceId = String(selection.providerInstanceId);
  const modelId = String(selection.modelId);
  const exact = options.find(
    (candidate) =>
      String(candidate.providerInstanceId) === instanceId && String(candidate.modelId) === modelId,
  );
  const providerOption =
    exact ?? options.find((candidate) => String(candidate.providerInstanceId) === instanceId);
  const modelLabel = exact?.label ?? modelId;
  const providerName = providerOption?.detail;
  const driverKind = providerOption?.driverKind;
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
): string {
  const label = (selection: MobileProviderSelection) => providerMeta(options, selection).fullLabel;
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
}): MobileTranscriptHandoffEntry | undefined {
  const from =
    input.previous ??
    (input.handoff !== undefined &&
    "previousProviderInstanceId" in input.handoff &&
    "previousModelId" in input.handoff
      ? {
          providerInstanceId: input.handoff.previousProviderInstanceId,
          modelId: input.handoff.previousModelId,
        }
      : undefined);
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

  let kind: MobileTranscriptHandoffKind | undefined;
  if (
    providerChanged ||
    reason === "provider-switch" ||
    reason === "account-move" ||
    reason === "account-move-native-session"
  ) {
    kind = "context-handoff";
  } else if (modelChanged) {
    kind = "model-switch";
  } else if (reason === "fork" || reason === "fork-native-session") {
    kind = "fork";
  } else if (reason === "branch") {
    kind = "branch";
  } else if (reason === "rewind" || reason === "rewind-native-session") {
    kind = "rewind";
  }

  if (kind === undefined) return undefined;
  const heading = HEADING_FOR_KIND[kind];
  const disclosure =
    input.handoff === undefined
      ? undefined
      : formatMobileHandoffDisclosure(input.handoff, input.modelOptions);

  if (from === undefined || to === undefined || (!providerChanged && !modelChanged)) {
    return {
      kind,
      heading,
      accessibleLabel: heading,
      ...(disclosure === undefined ? {} : { disclosure }),
    };
  }

  const fromMeta = providerMeta(input.modelOptions, from);
  const toMeta = providerMeta(input.modelOptions, to);
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

  const accessibleLabel =
    kind === "model-switch"
      ? `${heading} from ${fromLabel} to ${toLabel}`
      : `${heading} from ${fromMeta.fullLabel} to ${toMeta.fullLabel}`;

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

/**
 * Places each Chat handoff or switch boundary on the message content id it opens:
 * turn-to-turn transitions ahead of the turn's user message, and within-turn
 * retry transitions ahead of that attempt's first reply.
 */
export function mobileChatHandoffsByContentId(
  view: ChatThreadView,
  modelOptions: ReadonlyArray<MobileModelOption>,
): ReadonlyMap<string, MobileTranscriptHandoffEntry> {
  const byContentId = new Map<string, MobileTranscriptHandoffEntry>();
  const turns = activeChatTurns(view.turns);
  let previousTurnAttempt: ChatThreadView["turns"][number]["attempts"][number] | undefined;

  for (const turn of turns) {
    const firstAttempt = turn.attempts[0];
    if (firstAttempt !== undefined) {
      const turnEntry = resolveMobileTranscriptHandoff({
        previous: previousTurnAttempt,
        current: firstAttempt,
        handoff: firstAttempt.handoff,
        modelOptions,
      });
      if (turnEntry !== undefined) {
        byContentId.set(String(turn.userMessageRef.contentId), turnEntry);
      }
    }
    for (let index = 1; index < turn.attempts.length; index += 1) {
      const previousAttempt = turn.attempts[index - 1];
      const attempt = turn.attempts[index];
      if (previousAttempt === undefined || attempt === undefined) continue;
      const attemptEntry = resolveMobileTranscriptHandoff({
        previous: previousAttempt,
        current: attempt,
        handoff: attempt.handoff,
        modelOptions,
      });
      const anchor = attempt.responseRefs[0]?.contentId;
      if (attemptEntry !== undefined && anchor !== undefined) {
        byContentId.set(String(anchor), attemptEntry);
      }
    }
    const latest = turn.attempts.at(-1);
    if (latest !== undefined) previousTurnAttempt = latest;
  }

  return byContentId;
}
