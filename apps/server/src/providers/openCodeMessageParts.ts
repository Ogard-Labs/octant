import type { Event } from "@opencode-ai/sdk/v2/types";

type TextEvent = { readonly kind: "text-delta" | "reasoning-delta"; readonly text: string };
type FailureEvent = {
  readonly kind: "failed";
  readonly failure: { readonly category: "protocol"; readonly message: string };
};
interface Part {
  readonly messageId: string;
  kind: "text" | "reasoning" | undefined;
  text: string;
  emitted: number;
}

/** Reconciles streamed deltas with accumulated part snapshots within one session. */
export class OpenCodeMessageParts {
  readonly #roles = new Map<string, "user" | "assistant">();
  readonly #parts = new Map<string, Part>();
  readonly #families = new Map<string, "parts" | "next">();
  #characters = 0;
  /** Where the agent's own text stands, once it has written any. */
  #agentText: { toolStepSince: boolean; endsWithNewline: boolean } | undefined;

  accept(event: Event): ReadonlyArray<TextEvent | FailureEvent> | undefined {
    if (event.type === "message.updated") {
      const info = event.properties.info;
      if (this.#roles.size >= 1024 && !this.#roles.has(info.id)) return this.#overflow();
      this.#roles.set(info.id, info.role);
      return [...this.#parts.values()]
        .filter((part) => part.messageId === info.id)
        .flatMap((part) => this.#emit(part));
    }
    if (event.type === "message.part.updated") {
      const incoming = event.properties.part;
      if (incoming.type === "tool") this.#endAgentMessage();
      if (incoming.type !== "text" && incoming.type !== "reasoning") return [];
      if (incoming.type === "text" && (incoming.synthetic === true || incoming.ignored === true))
        return [];
      if (this.#families.get(incoming.messageID) === "next") return [];
      const key = `${incoming.messageID}:${incoming.id}`;
      const previous = this.#parts.get(key);
      if (this.#parts.size >= 1024 && previous === undefined) return this.#overflow();
      this.#characters += incoming.text.length - (previous?.text.length ?? 0);
      if (this.#characters > 2_097_152) return this.#overflow();
      // Text already delivered cannot be replaced by an append-only event.
      if (
        previous !== undefined &&
        previous.emitted > 0 &&
        !incoming.text.startsWith(previous.text.slice(0, previous.emitted))
      )
        return this.#overflow();
      const part: Part = {
        messageId: incoming.messageID,
        kind: incoming.type,
        text: incoming.text,
        emitted: previous?.emitted ?? 0,
      };
      this.#parts.set(key, part);
      return this.#emit(part);
    }
    if (event.type === "message.part.delta") {
      const incoming = event.properties;
      if (incoming.field !== "text" || this.#families.get(incoming.messageID) === "next") return [];
      const key = `${incoming.messageID}:${incoming.partID}`;
      const part = this.#parts.get(key) ?? {
        messageId: incoming.messageID,
        kind: undefined,
        text: "",
        emitted: 0,
      };
      if (this.#parts.size >= 1024 && !this.#parts.has(key)) return this.#overflow();
      this.#characters += incoming.delta.length;
      if (this.#characters > 2_097_152) return this.#overflow();
      part.text += incoming.delta;
      this.#parts.set(key, part);
      return this.#emit(part);
    }
    if (event.type === "session.next.text.delta" || event.type === "session.next.reasoning.delta") {
      const id = event.properties.assistantMessageID;
      if (this.#families.get(id) === "parts") return [];
      this.#families.set(id, "next");
    }
    if (event.type.startsWith("session.next.tool.")) this.#endAgentMessage();
    return undefined;
  }

  /**
   * The agent's text as it is delivered. OpenCode puts no break between one
   * agent message and the next, and a turn's deltas are joined into one
   * transcript, so an agent's note before a tool step and its text after it
   * read as one sentence ("…the repository.Let me…"). The first text after a
   * tool step therefore opens a new paragraph, unless a line break is already
   * there. Text that continues a part already streaming is never broken.
   */
  withMessageBreak(text: string, continuesPart = false): string {
    const previous = this.#agentText;
    const separator =
      previous?.toolStepSince === true &&
      !continuesPart &&
      !previous.endsWithNewline &&
      !text.startsWith("\n")
        ? "\n\n"
        : "";
    this.#agentText = { toolStepSince: false, endsWithNewline: text.endsWith("\n") };
    return `${separator}${text}`;
  }

  #endAgentMessage(): void {
    if (this.#agentText !== undefined) this.#agentText.toolStepSince = true;
  }

  #emit(part: Part): ReadonlyArray<TextEvent> {
    if (
      this.#roles.get(part.messageId) !== "assistant" ||
      part.kind === undefined ||
      part.text.length <= part.emitted
    )
      return [];
    if (this.#families.get(part.messageId) === "next") return [];
    this.#families.set(part.messageId, "parts");
    const text = part.text.slice(part.emitted);
    const continuesPart = part.emitted > 0;
    part.emitted = part.text.length;
    return part.kind === "text"
      ? [{ kind: "text-delta", text: this.withMessageBreak(text, continuesPart) }]
      : [{ kind: "reasoning-delta", text }];
  }

  #overflow(): ReadonlyArray<FailureEvent> {
    return [
      {
        kind: "failed",
        failure: {
          category: "protocol",
          message: "Provider message parts exceeded their supported bounds.",
        },
      },
    ];
  }
}
