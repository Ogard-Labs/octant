import type { AppleSimulatorLiveFrame } from "@octant/domain";
import { canOfferAppleSimulatorFrameInput } from "@octant/domain";
import { useId, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

export type AppleSimulatorFrameInputIntent =
  | { readonly kind: "tap"; readonly point: { readonly x: number; readonly y: number } }
  | { readonly kind: "type-text"; readonly text: string }
  | { readonly kind: "key-press"; readonly key: string };

export interface AppleSimulatorLiveFrameProps {
  readonly frame: AppleSimulatorLiveFrame;
  readonly screenUrl?: string;
  /**
   * When true and the frame is live, tap/type/key controls are offered. Remote
   * and headless clients leave this false so the surface stays read-only.
   */
  readonly inputEnabled?: boolean;
  readonly onInput?: (intent: AppleSimulatorFrameInputIntent) => void;
  readonly busy?: boolean;
}

export function AppleSimulatorLiveFrameView(props: AppleSimulatorLiveFrameProps) {
  const { frame } = props;
  const liveScreen =
    frame.status === "live" && frame.screen.kind === "screenshot"
      ? frame.screen.reference
      : undefined;
  const staleScreen =
    frame.status === "stale-after-restart" ? frame.lastScreen?.reference : undefined;
  const evidence = liveScreen ?? staleScreen;
  const offerInput =
    props.inputEnabled === true &&
    props.onInput !== undefined &&
    canOfferAppleSimulatorFrameInput(frame);
  return (
    <figure
      aria-label="iOS Simulator live frame"
      className={`apple-simulator-frame apple-simulator-frame--${frame.status}`}
      data-status={frame.status}
    >
      <figcaption>{frame.title}</figcaption>
      {frame.status === "live" && props.screenUrl !== undefined ? (
        <LiveScreen
          busy={props.busy === true}
          name={frame.name}
          offerInput={offerInput}
          {...(props.onInput === undefined ? {} : { onInput: props.onInput })}
          screenUrl={props.screenUrl}
        />
      ) : frame.status === "live" && frame.screen.kind === "screenshot" ? (
        <p>The destination is live. The captured screen is not available in this frame.</p>
      ) : (
        <p>{frame.message}</p>
      )}
      {evidence === undefined ? null : (
        <p>
          Evidence <code>{evidence}</code>
        </p>
      )}
      {offerInput ? (
        <FrameInputControls busy={props.busy === true} onInput={props.onInput!} />
      ) : null}
    </figure>
  );
}

function LiveScreen(props: {
  readonly name: string;
  readonly screenUrl: string;
  readonly offerInput: boolean;
  readonly onInput?: (intent: AppleSimulatorFrameInputIntent) => void;
  readonly busy: boolean;
}) {
  return (
    // The screen is a coordinate hit region: taps translate to Simulator
    // device points, so the Octant button recipe (fixed height, padding)
    // cannot host it without distorting the mapped geometry.
    /* ui-boundary-exception: specialized-editor-surface */
    <button
      aria-label={
        props.offerInput
          ? `Tap on ${props.name} Simulator screen`
          : `${props.name} Simulator screen`
      }
      className="apple-simulator-frame__screen"
      disabled={!props.offerInput || props.busy || props.onInput === undefined}
      onClick={(event) => {
        if (!props.offerInput || props.onInput === undefined || props.busy) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const x = ((event.clientX - rect.left) / rect.width) * rect.width;
        const y = ((event.clientY - rect.top) / rect.height) * rect.height;
        props.onInput({
          kind: "tap",
          point: { x: Math.round(x), y: Math.round(y) },
        });
      }}
      type="button"
    >
      <img alt={`${props.name} screen`} draggable={false} src={props.screenUrl} />
    </button>
  );
}

function FrameInputControls(props: {
  readonly onInput: (intent: AppleSimulatorFrameInputIntent) => void;
  readonly busy: boolean;
}) {
  const textId = useId();
  const [text, setText] = useState("");
  return (
    <div className="apple-simulator-frame__input" role="group" aria-label="Simulator input">
      <label className="apple-simulator-frame__type" htmlFor={textId}>
        Type into Simulator
        <OctantInput
          autoComplete="off"
          disabled={props.busy}
          id={textId}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || props.busy) return;
            event.preventDefault();
            if (text.trim().length === 0) return;
            props.onInput({ kind: "type-text", text });
            setText("");
          }}
          placeholder="Text to type"
          type="text"
          value={text}
        />
      </label>
      <div className="apple-simulator-frame__keys">
        <OctantButton
          disabled={props.busy || text.trim().length === 0}
          onClick={() => {
            if (text.trim().length === 0) return;
            props.onInput({ kind: "type-text", text });
            setText("");
          }}
          type="button"
          variant="secondary"
        >
          Type
        </OctantButton>
        <OctantButton
          disabled={props.busy}
          onClick={() => props.onInput({ kind: "key-press", key: "return" })}
          type="button"
          variant="secondary"
        >
          Return
        </OctantButton>
        <OctantButton
          disabled={props.busy}
          onClick={() => props.onInput({ kind: "key-press", key: "escape" })}
          type="button"
          variant="secondary"
        >
          Escape
        </OctantButton>
      </div>
    </div>
  );
}
