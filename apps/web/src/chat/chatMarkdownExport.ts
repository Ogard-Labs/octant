import type { ChatAttempt, ChatContentBody, ChatThreadView } from "@octant/contracts/chat";
import { activeChatTurns } from "@octant/domain/chat-policy";

export interface ChatMarkdownExportInput {
  readonly view: ChatThreadView;
  /**
   * Whether the renderer is currently receiving the authoritative event stream.
   * A disconnected export can only reflect what this client last saw, which the
   * export says out loud rather than implying it is current.
   */
  readonly connectionStatus?: "connected" | "disconnected";
}

export interface ChatMarkdownExport {
  readonly markdown: string;
  /** Suggested file name for saving the export. */
  readonly fileName: string;
  /**
   * False when the export could not include everything the thread contains: a
   * response was still arriving, content was unreadable, or this client was not
   * connected to the authoritative stream. The markdown always states the same
   * facts; this flag lets the UI surface them too.
   */
  readonly complete: boolean;
}

const IN_PROGRESS_OUTCOMES = new Set(["queued", "streaming", "waiting"]);

/**
 * Renders a Chat thread as Markdown.
 *
 * The exported transcript is the active conversation: revised messages and the
 * exchanges they superseded are journaled but are not part of the conversation
 * as it now stands, so they are excluded and *counted* in the header rather
 * than dropped without a word. Every other gap — a response still arriving,
 * content the projection could not resolve, attachments that live outside the
 * transcript, a disconnected client — is stated in the export itself. An export
 * never presents a partial conversation as a whole one.
 */
export function buildChatMarkdownExport(input: ChatMarkdownExportInput): ChatMarkdownExport {
  const view = input.view;
  const contentById = new Map(
    view.contents.map((content) => [String(content.contentId), content] as const),
  );
  const attachmentById = new Map(
    view.attachments.map((attachment) => [String(attachment.id), attachment] as const),
  );
  const turns = activeChatTurns(view.turns);
  const revisedTurnCount = view.turns.length - turns.length;

  const notes: string[] = [];
  const lines: string[] = [`# ${view.thread.title}`, ""];
  lines.push(
    `- Model: ${view.thread.modelId}`,
    `- Messages: ${turns.length}`,
    `- Exported at thread revision ${view.thread.version} (event ${view.lastSequence})`,
  );
  if (view.thread.branchedFrom !== undefined) {
    const origin = view.thread.branchedFrom;
    lines.push(
      `- Branched from another thread at revision ${origin.sourceVersion}, carrying ${origin.carriedTurnCount} ${origin.carriedTurnCount === 1 ? "message" : "messages"}`,
    );
  }
  lines.push("");

  let unreadable = 0;
  let inProgress = 0;
  let omittedAttachments = 0;

  for (const turn of turns) {
    const userContent = contentById.get(String(turn.userMessageRef.contentId));
    lines.push("## You", "");
    if (userContent === undefined) {
      unreadable += 1;
      lines.push("*This message could not be read from local storage and is missing here.*", "");
    } else {
      lines.push(userContent.body.trim(), "");
    }
    if (turn.attachmentIds.length > 0) {
      omittedAttachments += turn.attachmentIds.length;
      const names = turn.attachmentIds.map(
        (id) => attachmentById.get(String(id))?.displayName ?? "unavailable attachment",
      );
      lines.push(`*Attachments (files, not included in this export): ${names.join(", ")}*`, "");
    }
    for (const attempt of turn.attempts) {
      const body = attemptBody(attempt, contentById);
      if (body === "unreadable") {
        unreadable += 1;
        lines.push(
          "## Assistant",
          "",
          "*This response could not be read from local storage and is missing here.*",
          "",
        );
        continue;
      }
      if (IN_PROGRESS_OUTCOMES.has(attempt.outcome)) {
        inProgress += 1;
        lines.push("## Assistant", "");
        if (body.length > 0) lines.push(body, "");
        lines.push(`*This response was still ${attempt.outcome} when the export was taken.*`, "");
        continue;
      }
      if (body.length === 0) {
        // A failed or cancelled attempt that produced no text is part of the
        // thread's history but not of the conversation; naming it is honest
        // and cheap, inventing content for it would not be.
        lines.push("## Assistant", "", `*No response — the attempt ${attempt.outcome}.*`, "");
        continue;
      }
      lines.push("## Assistant", "", body, "");
      if (attempt.outcome !== "completed") {
        lines.push(`*This response ${attempt.outcome} before it finished.*`, "");
      }
    }
  }

  if (turns.length === 0) lines.push("*This conversation has no messages yet.*", "");

  if (revisedTurnCount > 0) {
    notes.push(
      `${revisedTurnCount} superseded ${revisedTurnCount === 1 ? "message was" : "messages were"} revised in this thread. This export contains the conversation as it now stands; the earlier versions remain in the thread's history and are not included here.`,
    );
  }
  if (inProgress > 0) {
    notes.push(
      `${inProgress} ${inProgress === 1 ? "response was" : "responses were"} still arriving when this export was taken, so ${inProgress === 1 ? "it is" : "they are"} incomplete.`,
    );
  }
  if (unreadable > 0) {
    notes.push(
      `${unreadable} ${unreadable === 1 ? "message" : "messages"} could not be read from local storage and ${unreadable === 1 ? "is" : "are"} missing from this export.`,
    );
  }
  if (omittedAttachments > 0) {
    notes.push(
      `${omittedAttachments} ${omittedAttachments === 1 ? "attachment is" : "attachments are"} referenced by name only; their file contents are not part of this Markdown export.`,
    );
  }
  if (input.connectionStatus === "disconnected") {
    notes.push(
      "This client was not connected to the authoritative transcript when the export was taken, so newer messages may exist that it has not seen.",
    );
  }

  if (notes.length > 0) {
    lines.push("---", "", "## About this export", "");
    for (const note of notes) lines.push(`- ${note}`);
    lines.push("");
  }

  return {
    markdown: `${lines.join("\n").trimEnd()}\n`,
    fileName: `${exportFileSlug(view.thread.title)}.md`,
    // An attachment named but not carried is a gap in the export like any
    // other, so the control shows its partial warning rather than reporting an
    // unqualified success.
    complete:
      inProgress === 0 &&
      unreadable === 0 &&
      omittedAttachments === 0 &&
      input.connectionStatus !== "disconnected",
  };
}

/** The attempt's response text, `""` when it produced none, or `"unreadable"`. */
function attemptBody(
  attempt: ChatAttempt,
  contentById: ReadonlyMap<string, ChatContentBody>,
): string | "unreadable" {
  if (attempt.responseRefs.length === 0) return "";
  const contents = attempt.responseRefs.map((reference) =>
    contentById.get(String(reference.contentId)),
  );
  if (contents.some((content) => content === undefined)) return "unreadable";
  return contents
    .map((content) => content!.body)
    .join("")
    .trim();
}

function exportFileSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug.length === 0 ? "octant-chat" : slug;
}
