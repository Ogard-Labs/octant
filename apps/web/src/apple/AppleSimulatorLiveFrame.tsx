import type { AppleSimulatorLiveFrame } from "@octant/domain";
import { canOfferAppleSimulatorFrameInput } from "@octant/domain";
import { useId, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { useOrderedDeviceInput, type DeviceInputIntent } from "../device/deviceInput";
import { StillScreen, StreamedScreen } from "../device/DeviceScreen";
import type { AppleSimulatorLiveScreen } from "./useAppleSimulatorLiveScreen";

export type AppleSimulatorFrameInputIntent = DeviceInputIntent;

export interface AppleSimulatorLiveFrameProps {
  readonly frame: AppleSimulatorLiveFrame;
  readonly screenUrl?: string;
  /**
   * The Simulator's screen as it changes. When the host streams one it replaces
   * the captured still; without one the still is what the frame shows.
   */
  readonly liveScreen?: AppleSimulatorLiveScreen;
  /**
   * When true and the frame is live, tap/type/key controls are offered. Remote
   * and headless clients leave this false so the surface stays read-only.
   */
  readonly inputEnabled?: boolean;
  readonly onInput?: (intent: AppleSimulatorFrameInputIntent) => void;
  readonly busy?: boolean;
}

/**
 * The live frame inside the full Apple workbench, beside its evidence. The
 * dock's device pane draws the same screen through `DevicePane` instead.
 */
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
  const streamed =
    frame.status === "live" && props.liveScreen?.status === "live" ? props.liveScreen : undefined;
  // The queue lives with the frame, not with the streamed screen: a live view
  // that reconnects unmounts the screen for a moment, and what a person had
  // typed just before was thrown away with it.
  const enqueue = useOrderedDeviceInput({
    owner: frame.status === "live" ? String(frame.simulatorId) : "",
    busy: props.busy === true,
    ...(props.onInput === undefined ? {} : { onInput: props.onInput }),
  });
  const send = (intent: AppleSimulatorFrameInputIntent) => enqueue(intent, false);
  return (
    <figure
      aria-label="iOS Simulator live frame"
      className={`apple-simulator-frame apple-simulator-frame--${frame.status}`}
      data-status={frame.status}
    >
      <figcaption>{frame.title}</figcaption>
      {frame.status === "live" && streamed !== undefined ? (
        <StreamedScreen
          // A pending press belongs to one Simulator. When the frame moves to
          // another it is dropped with the component.
          key={String(frame.simulatorId)}
          active={offerInput}
          attach={streamed.attach}
          enqueue={enqueue}
          label={
            offerInput ? `Tap on ${frame.name} Simulator screen` : `${frame.name} Simulator screen`
          }
          pictureLabel={`${frame.name} live screen`}
          screen={streamed.screen}
        />
      ) : frame.status === "live" && props.screenUrl !== undefined ? (
        <StillScreen
          active={offerInput}
          disabled={props.busy === true}
          label={
            offerInput ? `Tap on ${frame.name} Simulator screen` : `${frame.name} Simulator screen`
          }
          // Through the same queue: a tap on the still while the live view
          // reconnects must not overtake text that is waiting for its pause.
          {...(props.onInput === undefined ? {} : { onTap: send })}
          pictureLabel={`${frame.name} screen`}
          url={props.screenUrl}
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
        // Never disabled for being busy while streamed: the buttons wait their
        // turn in the same queue as the screen, behind whatever was typed.
        <FrameInputControls busy={streamed === undefined && props.busy === true} onInput={send} />
      ) : null}
    </figure>
  );
}

function FrameInputControls(props: {
  readonly onInput: (intent: AppleSimulatorFrameInputIntent) => void;
  readonly busy: boolean;
}) {
  const textId = useId();
  const [text, setText] = useState("");
  const hardware = (
    <>
      <OctantButton
        disabled={props.busy}
        onClick={() => props.onInput({ kind: "key-press", key: "home" })}
        type="button"
        variant="secondary"
      >
        Home
      </OctantButton>
      <OctantButton
        disabled={props.busy}
        onClick={() => props.onInput({ kind: "key-press", key: "lock" })}
        type="button"
        variant="secondary"
      >
        Lock
      </OctantButton>
    </>
  );
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
        {hardware}
      </div>
    </div>
  );
}
