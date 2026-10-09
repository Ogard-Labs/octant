import { useId, useRef, useState, type ReactNode } from "react";
import type { DeviceInputIntent, EnqueueDeviceInput } from "./deviceInput";
import type { DevicePlatform, DeviceScreenSource } from "./deviceModel";
import { StillScreen, StreamedScreen } from "./DeviceScreen";

/**
 * The device itself: an original silhouette (body, hairline edge, side keys)
 * with the screen inside it. The screen is the only hit region; nothing else
 * on the stage sends input.
 */
export function DeviceStage(props: {
  readonly platform: DevicePlatform;
  readonly name: string;
  readonly screen: DeviceScreenSource;
  readonly active: boolean;
  readonly enqueue: EnqueueDeviceInput;
  readonly dimmed?: boolean;
  readonly ghost?: boolean;
  /** A short badge above the device, for a last frame. */
  readonly badge?: string;
  /** A caption under the device, for booting or connecting. */
  readonly caption?: ReactNode;
  /** A quiet line under the device saying how its picture arrives. */
  readonly status?: string;
}) {
  const captionId = useId();
  const [focused, setFocused] = useState(false);
  const [mark, setMark] = useState<{
    readonly x: number;
    readonly y: number;
    readonly n: number;
  }>();
  const bodyRef = useRef<HTMLDivElement>(null);
  const press = (point: { readonly x: number; readonly y: number }) => {
    const body = bodyRef.current;
    if (body === null) return;
    const rect = body.getBoundingClientRect();
    setMark((previous) => ({
      x: point.x - rect.left,
      y: point.y - rect.top,
      n: (previous?.n ?? 0) + 1,
    }));
  };
  const screenLabel = props.active
    ? `${props.name} screen. Click to tap, drag to swipe, type while focused`
    : `${props.name} screen`;
  const { screen } = props;
  return (
    <div className="device-stage__fit">
      <div
        className="device-body"
        data-dimmed={props.dimmed === true ? "true" : undefined}
        data-ghost={props.ghost === true ? "true" : undefined}
        data-platform={props.platform}
        ref={bodyRef}
      >
        {screen.kind === "stream" ? (
          <StreamedScreen
            active={props.active}
            attach={screen.attach}
            describedBy={captionId}
            enqueue={props.enqueue}
            label={screenLabel}
            onBlur={() => setFocused(false)}
            onFocus={() => setFocused(true)}
            onPress={press}
            pictureLabel={`${props.name} live screen`}
            screen={screen.size}
          />
        ) : screen.kind === "still" ? (
          <StillScreen
            active={props.active}
            label={props.active ? `${props.name} screen. Click to tap` : `${props.name} screen`}
            onPress={press}
            onTap={(intent: DeviceInputIntent) => props.enqueue(intent, false)}
            pictureLabel={`${props.name} screen`}
            url={screen.url}
          />
        ) : (
          <span aria-hidden="true" className="device-screen device-screen--blank" />
        )}
        {mark === undefined ? null : (
          <span
            aria-hidden="true"
            className="device-touch"
            key={mark.n}
            onAnimationEnd={() => setMark(undefined)}
            style={{ left: mark.x, top: mark.y }}
          />
        )}
      </div>
      {props.badge === undefined ? null : (
        <span className="device-stage__badge">{props.badge}</span>
      )}
      {props.caption !== undefined ? (
        <p className="device-stage__caption">{props.caption}</p>
      ) : screen.kind === "stream" && props.active ? (
        // Says where the keys go while they go to the device, and otherwise
        // how the picture arrives, in the same row so nothing moves.
        <p className="device-stage__caption" hidden={!focused && props.status === undefined}>
          <span hidden={!focused} id={captionId}>
            Keys go to {props.name} · Tab to leave
          </span>
          {props.status === undefined ? null : <span hidden={focused}>{props.status}</span>}
        </p>
      ) : props.status !== undefined ? (
        <p className="device-stage__caption">{props.status}</p>
      ) : (
        <p aria-hidden="true" className="device-stage__caption" hidden />
      )}
    </div>
  );
}

export function DeviceSpinner() {
  return <span aria-hidden="true" className="device-spinner" />;
}
