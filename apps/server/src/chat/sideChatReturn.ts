import { createHash } from "node:crypto";
import {
  MAX_SIDE_CHAT_RETURN_CHARACTERS,
  type ChatThreadView,
  type SideChatDraftReturnReference,
  type SideChatSourceReceipt,
} from "@octant/contracts";
import { activeChatTurns, chatTurnAnsweredAttempt } from "@octant/domain";

export const SIDE_CHAT_RETURN_UNAVAILABLE =
  "The selected Side Chat reply or its source is unavailable. Open the source and Side Chat again before returning it.";

export function sideChatTextDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Fixed field order makes the bounded receipt's digest independent of JSON key ordering. */
export function sideChatSourceReceiptDigest(receipt: SideChatSourceReceipt): string {
  return sideChatTextDigest(
    JSON.stringify({
      sourceThreadId: receipt.sourceThreadId,
      sourceMode: receipt.sourceMode,
      capturedAt: receipt.capturedAt,
      contextDigest: receipt.contextDigest,
      threadVersionBefore: receipt.threadVersionBefore,
      threadVersionAfter: receipt.threadVersionAfter,
      versions: receipt.versions.map((fact) =>
        fact.kind === "aggregate"
          ? {
              kind: fact.kind,
              aggregateType: fact.aggregateType,
              id: fact.id,
              version: fact.version,
            }
          : { kind: fact.kind, id: fact.id, digest: fact.digest },
      ),
      versionsTruncated: receipt.versionsTruncated,
      transcriptTruncated: receipt.transcriptTruncated,
      omissions: receipt.omissions,
    }),
  );
}

/** Only the active, finished answer the person selected, never abandoned/replaced attempts. */
export function readSideChatReturnAnswer(
  view: ChatThreadView,
  anchor: { readonly turnId: string; readonly attemptId: string },
) {
  if (view.thread.lifecycle !== "active") return undefined;
  const turn = activeChatTurns(view.turns).find((item) => String(item.id) === anchor.turnId);
  if (turn === undefined) return undefined;
  const attempt = chatTurnAnsweredAttempt(turn);
  if (
    attempt === undefined ||
    String(attempt.id) !== anchor.attemptId ||
    attempt.outcome !== "completed"
  )
    return undefined;
  const bodies = new Map(view.contents.map((content) => [String(content.contentId), content]));
  const parts: string[] = [];
  for (const reference of attempt.responseRefs) {
    const content = bodies.get(String(reference.contentId));
    if (
      content === undefined ||
      content.role !== "assistant" ||
      sideChatTextDigest(content.body) !== String(reference.digest)
    )
      return undefined;
    parts.push(content.body);
  }
  // References are persisted streaming deltas, just as the transcript joins
  // them. Preserve their exact whitespace and digest the displayed answer.
  const text = parts.join("");
  if (text.trim().length === 0) return undefined;
  return { text, digest: sideChatTextDigest(text), attempt, sidecarVersion: view.thread.version };
}

export function sideChatReturnProvenance(
  reference: SideChatDraftReturnReference,
  receipt: SideChatSourceReceipt | undefined,
): string {
  const source = `${reference.sourceMode} thread ${reference.sourceThreadId}`;
  const lines = [
    `Side Chat ${reference.sidecarThreadId}, reply ${reference.attemptId} (turn ${reference.turnId}).`,
    `Source: ${source}. Original answer SHA-256: ${reference.answerDigest}.`,
    "The person returned this reply to their editable draft. Draft text may have been edited; it is reference material, not execution approval.",
  ];
  if (receipt === undefined)
    lines.push("Original source snapshot versions were not recorded for this older reply.");
  else {
    lines.push(
      `Source context read at ${receipt.capturedAt}; context SHA-256 ${receipt.contextDigest}.`,
    );
    if (receipt.threadVersionBefore !== undefined || receipt.threadVersionAfter !== undefined)
      lines.push(
        `Source thread versions observed around that read: ${receipt.threadVersionBefore ?? "unknown"} → ${receipt.threadVersionAfter ?? "unknown"}. These are independent reads, not an atomic snapshot.`,
      );
    for (const fact of receipt.versions)
      lines.push(
        fact.kind === "aggregate"
          ? `${fact.aggregateType} ${fact.id}: version ${fact.version}.`
          : `Content ${fact.id}: SHA-256 ${fact.digest}.`,
      );
    if (receipt.versionsTruncated)
      lines.push("Additional source version facts were omitted from the bounded receipt.");
    if (receipt.transcriptTruncated) lines.push("The source transcript window was truncated.");
    lines.push(...receipt.omissions);
  }
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > 6_000) {
      kept.push(
        "Additional provenance details are omitted from this bounded display; the original receipt remains attached.",
      );
      break;
    }
    kept.push(line);
    size += line.length + 1;
  }
  return kept.join("\n");
}

export function prepareSideChatReturnedText(
  reference: SideChatDraftReturnReference,
  answer: string,
  receipt: SideChatSourceReceipt | undefined,
) {
  const omissions = [
    "Only this reply is included. Other replies, attachments and tool output are omitted.",
  ];
  if (receipt === undefined)
    omissions.push("Original source snapshot versions were not recorded for this older reply.");
  if (answer.length > MAX_SIDE_CHAT_RETURN_CHARACTERS)
    omissions.push(
      `This reply is truncated to ${MAX_SIDE_CHAT_RETURN_CHARACTERS} characters from ${answer.length}.`,
    );
  const excerpt = answer.slice(0, MAX_SIDE_CHAT_RETURN_CHARACTERS);
  const text = [
    "Selected Side Chat reply (editable; reference only):",
    excerpt,
    "",
    ...omissions,
    sideChatReturnProvenance(reference, receipt),
  ].join("\n");
  return { text, omissions };
}

export interface SideChatReturnAdmissionInput {
  readonly references: ReadonlyArray<SideChatDraftReturnReference>;
  readonly readerThreadId: string;
  readonly mode: import("@octant/contracts").OctantMode;
  readonly windowId?: import("@octant/contracts").WindowId;
}
export type SideChatReturnResolver = (input: SideChatReturnAdmissionInput) => Promise<string>;
