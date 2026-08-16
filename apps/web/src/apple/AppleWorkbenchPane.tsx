import type { AppleDiscoverySnapshot } from "@octant/contracts/apple-toolchain-rpc";
import type {
  AppleActionProgress,
  AppleBuildEvidence,
  AppleRuntimeSnapshot,
  AppleSimulatorRecord,
} from "@octant/contracts/apple-toolchain";

export type AppleWorkbenchStatus =
  | "loading"
  | "waiting"
  | "unavailable"
  | "interrupted"
  | "failed"
  | "ready";

export interface AppleWorkbenchPaneProps {
  readonly status: AppleWorkbenchStatus;
  readonly discovery?: AppleDiscoverySnapshot;
  readonly runtime?: AppleRuntimeSnapshot;
  readonly errorMessage?: string;
  readonly onRetry?: () => void;
}

export function AppleWorkbenchPane(props: AppleWorkbenchPaneProps) {
  if (props.status !== "ready") return <AppleWorkbenchState {...props} />;
  if (props.discovery === undefined || props.runtime === undefined) {
    return <AppleWorkbenchState status="waiting" />;
  }
  return (
    <section aria-label="Apple development workbench" className="apple-workbench">
      <header className="apple-workbench__header">
        <div>
          <span className="apple-workbench__eyebrow">Apple development</span>
          <h1>{props.discovery.workspace.projectPath}</h1>
        </div>
        <span className="apple-workbench__toolchain">
          Xcode {props.discovery.toolchain.xcodeVersion ?? "unavailable"}
        </span>
      </header>
      <dl className="apple-workbench__facts">
        <Fact label="Scheme" value={props.discovery.workspace.schemes[0] ?? "Not selected"} />
        <Fact label="Revision" value={props.discovery.workspace.sourceRevision.slice(0, 12)} />
        <Fact label="SDKs" value={String(props.discovery.toolchain.sdks.length)} />
        <Fact label="Simulators" value={String(props.discovery.simulators.length)} />
      </dl>
      <SimulatorList simulators={props.discovery.simulators} />
      <ProgressList progress={props.runtime.active} />
      <EvidenceList evidence={props.runtime.recentEvidence} />
    </section>
  );
}

function AppleWorkbenchState(
  props: Pick<AppleWorkbenchPaneProps, "status" | "errorMessage" | "onRetry">,
) {
  const presentation = {
    loading: ["Loading Apple toolchain", "Discovering Xcode, SDKs, and Simulator destinations."],
    waiting: [
      "Waiting for Apple evidence",
      "No authoritative Apple action state is available yet.",
    ],
    unavailable: [
      "Apple toolchain unavailable",
      "Install or select Xcode and an available Simulator runtime, then retry.",
    ],
    interrupted: [
      "Apple action interrupted",
      "The owned process stopped before a verified result was recorded.",
    ],
    failed: [
      "Apple action failed",
      props.errorMessage ?? "Review the normalized diagnostics and retry.",
    ],
    ready: ["Waiting for Apple evidence", "No authoritative Apple action state is available yet."],
  } as const;
  const [title, message] = presentation[props.status];
  return (
    <section
      aria-label="Apple development workbench"
      className={`apple-workbench apple-workbench--${props.status}`}
    >
      <span className="apple-workbench__eyebrow">Apple development</span>
      <h1>{title}</h1>
      <p role={props.status === "failed" ? "alert" : undefined}>{message}</p>
      {props.onRetry === undefined ? null : (
        <button onClick={props.onRetry} type="button">
          Retry
        </button>
      )}
    </section>
  );
}

function Fact(props: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

function SimulatorList(props: { readonly simulators: ReadonlyArray<AppleSimulatorRecord> }) {
  return (
    <section aria-labelledby="apple-simulators-heading" className="apple-workbench__section">
      <h2 id="apple-simulators-heading">Simulator destinations</h2>
      {props.simulators.length === 0 ? (
        <p>No compatible Simulator is available.</p>
      ) : (
        <ul>
          {props.simulators.map((simulator) => (
            <li key={simulator.simulatorId}>
              <strong>{simulator.name}</strong>
              <span>
                {simulator.platform} {simulator.runtimeVersion} · {simulatorState(simulator.state)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProgressList(props: { readonly progress: ReadonlyArray<AppleActionProgress> }) {
  return (
    <section aria-labelledby="apple-progress-heading" className="apple-workbench__section">
      <h2 id="apple-progress-heading">Current progress</h2>
      {props.progress.length === 0 ? (
        <p>No Apple action is running.</p>
      ) : (
        <ol>
          {props.progress.map((progress) => (
            <li key={progress.actionId}>
              <strong>{actionLabel(progress.kind)}</strong>
              <span>{stepLabel(progress.step)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function EvidenceList(props: { readonly evidence: ReadonlyArray<AppleBuildEvidence> }) {
  return (
    <section aria-labelledby="apple-evidence-heading" className="apple-workbench__section">
      <h2 id="apple-evidence-heading">Validation evidence</h2>
      {props.evidence.length === 0 ? (
        <p>No Apple evidence has been recorded.</p>
      ) : (
        <ol>
          {[...props.evidence].reverse().map((item) => (
            <li key={`${item.actionId}:${item.completedAt}`}>
              <div>
                <strong>{actionLabel(item.kind)}</strong>
                <span>{outcomeLabel(item.outcome)}</span>
                {item.cleanup === "uncertain" ? <span>Cleanup uncertain</span> : null}
              </div>
              {item.diagnostics.length === 0 ? null : (
                <ul aria-label="Diagnostics">
                  {item.diagnostics.map((diagnostic, index) => (
                    <li key={`${diagnostic.severity}:${index}`}>
                      {diagnostic.severity}: {diagnostic.message}
                    </li>
                  ))}
                </ul>
              )}
              {item.artifacts.length === 0 ? null : (
                <ul aria-label="Artifacts">
                  {item.artifacts.map((artifact) => (
                    <li key={`${artifact.kind}:${artifact.reference}`}>
                      {artifact.kind}: <code>{artifact.reference}</code>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function actionLabel(kind: string): string {
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}

function stepLabel(step: AppleActionProgress["step"]): string {
  return step
    .split("-")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function simulatorState(state: AppleSimulatorRecord["state"]): string {
  return state === "shutting-down" ? "Shutting down" : actionLabel(state);
}

function outcomeLabel(outcome: AppleBuildEvidence["outcome"]): string {
  const labels: Record<AppleBuildEvidence["outcome"], string> = {
    succeeded: "Succeeded",
    failed: "Failed",
    cancelled: "Cancelled",
    "timed-out": "Timed out",
    interrupted: "Interrupted",
    unavailable: "Unavailable",
    unauthorized: "Unauthorized",
    "invalid-destination": "Invalid destination",
    "process-died": "Process died",
  };
  return labels[outcome];
}
