import type { ChatMessagePart } from "@octant/contracts/chat";
import { resolveChatMessageParts } from "@octant/domain/chat-message-parts";
import { ChevronRight } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ToggleEvent,
} from "react";
import { ChatRichText } from "../chat/ChatRichText";
import { thinkingPreviewLine, useReplyDisclosures } from "./replyDetail";
import { SelectionThreadSurface } from "./SelectionThread";

export const StreamRepliesContext = createContext(true);

// Above this length a Markdown re-parse is costly enough to slow the beat.
const LONG_ANSWER_LENGTH = 16_000;

function useStreamingBody(body: string, streaming: boolean): string {
  const [shown, setShown] = useState(body);
  const latest = useRef(body);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // A replacement or finished answer is current in this render, even before
  // the effect cancels a pending streaming beat.
  const immediate = !streaming || shown.length === 0 || !body.startsWith(shown);
  useEffect(() => {
    latest.current = body;
    if (immediate) {
      if (timer.current !== undefined) {
        clearTimeout(timer.current);
        timer.current = undefined;
      }
      setShown(body);
    } else if (body !== shown && timer.current === undefined) {
      // Do not restart on each delta: a continuous stream must still paint.
      timer.current = setTimeout(
        () => {
          timer.current = undefined;
          setShown(latest.current);
        },
        body.length >= LONG_ANSWER_LENGTH ? 100 : 50,
      );
    }
  }, [body, immediate, shown]);
  useEffect(
    () => () => {
      if (timer.current !== undefined) {
        clearTimeout(timer.current);
        timer.current = undefined;
      }
    },
    [],
  );
  return immediate ? body : shown;
}

/** The same assistant prose and inline disclosures in Chat, Work, and Code. */
export function AssistantMessageBody(props: {
  readonly body: string;
  readonly streaming?: boolean;
}) {
  const streamReplies = useContext(StreamRepliesContext);
  const hidePartialAnswer = props.streaming === true && !streamReplies;
  const body = useStreamingBody(props.body, props.streaming === true);
  const parts = useMemo(() => resolveChatMessageParts({ role: "assistant", body }), [body]);
  // The parts, not the raw body: the parser leaves out what a person should
  // not read, such as a reply's follow-up suggestion block.
  const prose = parts.flatMap((part) => (part.kind === "markdown" ? [part.text] : []));
  if (prose.length === parts.length)
    return hidePartialAnswer ? null : (
      <SelectionThreadSurface>
        <ChatRichText body={prose.join("\n\n")} />
      </SelectionThreadSurface>
    );
  return (
    <SelectionThreadSurface>
      <div className="chat-transcript__parts">
        {parts.map((part, index) =>
          hidePartialAnswer && part.kind === "markdown" ? null : (
            <AssistantResponsePart key={`${part.kind}:${index}`} part={part} />
          ),
        )}
      </div>
    </SelectionThreadSurface>
  );
}

function AssistantResponsePart(props: { readonly part: ChatMessagePart }) {
  const part = props.part;
  // Hooks run for prose parts too, so a part keeps its hook order if a
  // streaming parse turns it from one kind into another.
  const disclosures = useReplyDisclosures();
  const openByLevel =
    part.kind === "tool"
      ? disclosures.opening.toolDetail
      : part.kind === "reasoning" && disclosures.opening.thinking;
  const open = disclosures.isOpen("part", openByLevel);
  const onToggle = (event: ToggleEvent<HTMLDetailsElement>) =>
    disclosures.choose("part", event.currentTarget.open);
  if (part.kind === "tool") {
    return (
      <details className="thinking" onToggle={onToggle} open={open}>
        <summary aria-label={`Tool · ${part.name} · ${part.status}`}>
          <ChevronRight aria-hidden="true" className="chev" size={14} />
          <span>{`Tool · ${part.name}`}</span>
          <span>{part.status}</span>
        </summary>
        <div className="thinking-body">{part.summary}</div>
      </details>
    );
  }
  if (part.kind === "reasoning") {
    const preview =
      disclosures.opening.thinkingPreview && !open ? thinkingPreviewLine(part.text) : "";
    return (
      <details className="thinking" onToggle={onToggle} open={open}>
        <summary aria-label="Thinking">
          <ChevronRight aria-hidden="true" className="chev" size={14} />
          <span>Thinking</span>
          {/* Hidden from assistive technology: the summary's name stays
              "Thinking", and the same words are read from the body once it
              opens. */}
          {preview === "" ? null : (
            <span aria-hidden="true" className="thinking-preview">
              {preview}
            </span>
          )}
        </summary>
        <div className="thinking-body">
          <ChatRichText body={part.text} />
        </div>
      </details>
    );
  }
  return <ChatRichText body={part.text} />;
}
