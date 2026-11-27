import type { ThreadMessageSteeredIntoTurn } from "@octant/contracts";
import { SentMessageText } from "../transcript/SentMessageText";
import { TurnTime } from "../transcript/TurnHeader";
import "./thread-message-queue.css";

/**
 * The person's messages the runtime took into a turn while it ran. The agent
 * read them mid-turn rather than in a turn of their own, so they sit inside
 * that turn, after its reply, and say so.
 */
export function SteeredMessages(props: {
  readonly steered: ReadonlyArray<ThreadMessageSteeredIntoTurn> | undefined;
  readonly className?: string;
}) {
  if (props.steered === undefined || props.steered.length === 0) return null;
  return (
    <>
      {props.steered.map((entry) => (
        <article
          aria-label="Your message, sent while the turn ran"
          className={props.className === undefined ? "turn-user" : `${props.className} turn-user`}
          data-steered="true"
          key={entry.messageId}
        >
          <p className="oct-meta turn-user__steered">Sent while the turn ran</p>
          <div className="bubble">
            <SentMessageText text={entry.body} trackerMentions={entry.trackerMentions} />
          </div>
          <TurnTime at={entry.steeredAt} copyValue={entry.body} />
        </article>
      ))}
    </>
  );
}
