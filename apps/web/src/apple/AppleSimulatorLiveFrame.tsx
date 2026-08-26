import type { AppleSimulatorLiveFrame } from "@octant/domain";

export interface AppleSimulatorLiveFrameProps {
  readonly frame: AppleSimulatorLiveFrame;
  readonly screenUrl?: string;
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
  return (
    <figure
      aria-label="iOS Simulator live frame"
      className={`apple-simulator-frame apple-simulator-frame--${frame.status}`}
      data-status={frame.status}
    >
      <figcaption>{frame.title}</figcaption>
      {frame.status === "live" && props.screenUrl !== undefined ? (
        <img alt={`${frame.name} screen`} src={props.screenUrl} />
      ) : (
        <p>{frame.message}</p>
      )}
      {evidence === undefined ? null : (
        <p>
          Evidence <code>{evidence}</code>
        </p>
      )}
    </figure>
  );
}
