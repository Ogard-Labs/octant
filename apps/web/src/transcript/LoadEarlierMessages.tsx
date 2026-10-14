import { OctantButton } from "../ui/base/OctantButton";
import "./load-earlier-messages.css";

export type LoadEarlierMessagesState = "idle" | "loading" | "failed" | "none-left";

/**
 * The row above a thread that opened on its newest messages. It keeps one
 * height in every state: it sits above the rows the reader is looking at, so a
 * row that grew or vanished while a page loaded would move them.
 */
export function LoadEarlierMessages(props: {
  readonly state: LoadEarlierMessagesState;
  readonly onLoad: () => void;
}) {
  if (props.state === "none-left") {
    return (
      <div className="load-earlier-messages" data-load-earlier="" data-state={props.state}>
        <span className="oct-meta load-earlier-messages__note">No earlier messages</span>
      </div>
    );
  }
  if (props.state === "failed") {
    return (
      <div className="load-earlier-messages" data-load-earlier="" data-state={props.state}>
        <span className="oct-meta load-earlier-messages__note">
          Earlier messages could not be loaded.
        </span>
        <OctantButton onClick={props.onLoad} size="sm" type="button" variant="ghost">
          Try again
        </OctantButton>
      </div>
    );
  }
  const loading = props.state === "loading";
  return (
    <div className="load-earlier-messages" data-load-earlier="" data-state={props.state}>
      {/* Still focusable while loading, so a keyboard reader keeps their place. */}
      <OctantButton
        aria-busy={loading ? true : undefined}
        disabled={loading}
        focusableWhenDisabled
        onClick={props.onLoad}
        size="sm"
        type="button"
        variant="ghost"
      >
        {loading ? "Loading earlier messages" : "Load earlier messages"}
      </OctantButton>
    </div>
  );
}
