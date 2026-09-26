import type { ChatMessagePart } from "@octant/contracts/chat";
import { resolveChatMessageParts } from "@octant/domain/chat-message-parts";
import { ChevronRight } from "lucide-react";
import { createContext, useContext, useMemo } from "react";
import { ChatRichText } from "../chat/ChatRichText";

export const StreamRepliesContext = createContext(true);

/** The same assistant prose and inline disclosures in Chat, Work, and Code. */
export function AssistantMessageBody(props: {
  readonly body: string;
  readonly streaming?: boolean;
}) {
  const streamReplies = useContext(StreamRepliesContext);
  const hidePartialAnswer = props.streaming === true && !streamReplies;
  const parts = useMemo(
    () => resolveChatMessageParts({ role: "assistant", body: props.body }),
    [props.body],
  );
  // The parts, not the raw body: the parser leaves out what a person should
  // not read, such as a reply's follow-up suggestion block.
  const prose = parts.flatMap((part) => (part.kind === "markdown" ? [part.text] : []));
  if (prose.length === parts.length)
    return hidePartialAnswer ? null : <ChatRichText body={prose.join("\n\n")} />;
  return (
    <div className="chat-transcript__parts">
      {parts.map((part, index) =>
        hidePartialAnswer && part.kind === "markdown" ? null : (
          <AssistantResponsePart key={`${part.kind}:${index}`} part={part} />
        ),
      )}
    </div>
  );
}

function AssistantResponsePart(props: { readonly part: ChatMessagePart }) {
  const part = props.part;
  if (part.kind === "tool") {
    return (
      <details className="thinking">
        <summary aria-label={`Tool · ${part.name} · ${part.status}`}>
          <ChevronRight aria-hidden="true" className="chev" size={14} strokeWidth={2} />
          <span>{`Tool · ${part.name}`}</span>
          <span>{part.status}</span>
        </summary>
        <div className="thinking-body">{part.summary}</div>
      </details>
    );
  }
  if (part.kind === "reasoning") {
    return (
      <details className="thinking">
        <summary aria-label="Thinking">
          <ChevronRight aria-hidden="true" className="chev" size={14} strokeWidth={2} />
          <span>Thinking</span>
        </summary>
        <div className="thinking-body">
          <ChatRichText body={part.text} />
        </div>
      </details>
    );
  }
  return <ChatRichText body={part.text} />;
}
